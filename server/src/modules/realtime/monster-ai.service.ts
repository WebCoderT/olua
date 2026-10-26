import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MONSTERS, MONSTER_AI } from "../../shared/game-data.generated";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import { WorldService, worldKey, type WorldMonster } from "../world/world.service";
import type { RealtimeMonsterAiEntry, RealtimeMonsterHit } from "./realtime.protocol";

/** 怪物 AI 参数（生成物 MONSTER_AI：普攻间隔 / 普攻距离 / 待机游走节奏，与客户端同源） */
const AI = MONSTER_AI as unknown as {
  attackInterval: number;
  attackRange: number;
  idleMoveInterval: [number, number];
  idleMoveDuration: [number, number];
  idleMoveSpeedScale: number;
  wanderRadius: number;
};

/** 一只怪的服务端 AI 运行时（内存态，**不落盘**：坐标的持久真相是出生点，见 world.service） */
interface MonsterRuntime {
  /** 当前模拟坐标（世界坐标；首次创建时 = 出生点） */
  x: number;
  y: number;
  /** 当前追击目标账号（null = 没有目标，待机游走） */
  target: string | null;
  /** 最后一次打伤过这只怪的账号（被动怪的记恨；主动怪不依赖它） */
  provoked: string | null;
  /** 下一次可普攻的时刻（毫秒） */
  nextAttackAt: number;
  /** 待机游走的停留点（追击结束从这里重新游走） */
  anchorX: number;
  anchorY: number;
  /** 本轮随机走动的截止时刻（毫秒）；<= now 表示站定 */
  idleMoveEndAt: number;
  idleMoveDirectionX: number;
  idleMoveDirectionY: number;
  /** 下一次触发随机走动的时刻（毫秒） */
  nextIdleMoveAt: number;
  /** 上次广播的位置与移动标记（增量广播的判据） */
  sentX: number;
  sentY: number;
  sentMoving: boolean;
  /** 本轮 tick 是否在移动（待机游走 / 追击位移；站定与出手为 false） */
  movingNow: boolean;
}

/** 一个玩家的位置上报（AI 的目标检测输入；移动预测仍在客户端，服务端不做位置的权威） */
interface PlayerPosition {
  zoneId: number;
  mapId: string;
  x: number;
  y: number;
  hp: number;
  updatedAt: number;
}

function randomBetween(range: [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

/** 属性区间随机取整数（与结算侧 rollRange 同一口径：含两端、自动纠正颠倒） */
function rollRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * 怪物 AI（#323：目标选择 / 移动 / 普攻与玩家受击的权威都在服务端）
 *
 * ===========================================================================
 * 服务端模拟什么
 * ===========================================================================
 * 每只**有人看的图**上的存活怪，跑一套与客户端旧 MonsterAI 同口径的状态机：
 * - 目标选择：主动怪常驻发现；被动怪被打伤后记恨打它的人（结算侧 provoke 进来）；
 *   玩家离开检测范围即丢失目标（记恨不清，回来继续被追 —— 与客户端语义一致）；
 * - 移动：待机游走（停留点 + 随机方向 + 活动半径）与追击（直线趋近，不做寻路），
 *   速度用快照里每只怪的 `moveSpeed`（像素/秒，与客户端同一数值）；
 * - 普攻：进入普攻距离后按 `attackInterval` 出手，伤害 = 怪物物攻区间随机值
 *   （monsters 表，#258 起读库即时生效）− 玩家物防区间随机值（服务端重算属性），
 *   受击走 `RolesService.applyMonsterHit` 落账（血量权威在服务端，revision 不推进）。
 *
 * ===========================================================================
 * 刻意不做的
 * ===========================================================================
 * - **状态数值不参与**（格挡 / 防御修正这些客户端 StatusManager 的本地增益）：
 *   状态还没上服务端（独立 issue），服务端按裸属性结算 —— 权威口径宁缺毋滥；
 * - **位置不落盘**：坐标的持久真相是出生点（世界服务的既有边界），重启后怪物回出生点
 *   重新游走 —— 几秒钟的表现层状态，不值得为它加一张表；
 * - 玩家位置不权威：客户端节流上报（`pos` 帧），服务端只把它当 AI 输入；
 *   超时没上报的玩家视作离场，怪物丢失目标。
 *
 * ===========================================================================
 * 广播
 * ===========================================================================
 * 按 `MONSTER_AI_BROADCAST_MS` 节流：只发**有变化**的怪（位置变了或移动标记变了）
 * 加上这段时间的普攻命中事件 —— 站着的怪不发第二遍。帧形状见 protocol 的
 * `RealtimeMonsterAiMessage`；发谁由观看者集合决定（RealtimeService 接线）。
 */
@Injectable()
export class MonsterAiService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonsterAiService.name);

  /** `zone:mapId` → 该图各怪的 AI 运行时（与世界服务的分域键同构；没人看的图整份清掉） */
  private readonly runtimes = new Map<string, Map<string, MonsterRuntime>>();
  /** 账号 → 最近一次位置上报 */
  private readonly positions = new Map<string, PlayerPosition>();
  private aiTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  /** 本轮 tick 攒下的命中事件（`zone:mapId` → hits），广播时一并发出 */
  private readonly pendingHits = new Map<string, RealtimeMonsterHit[]>();

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时 AI 照常跑，只是没人收到帧。
   */
  onBroadcast: ((zoneId: number, mapId: string, data: { mapId: string; monsters: RealtimeMonsterAiEntry[]; hits: RealtimeMonsterHit[] }) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly world: WorldService,
    private readonly roles: RolesService,
    private readonly monsterConfigs: MonsterRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.aiTimer = setInterval(() => this.tick(), this.tickMs()).unref();
    this.broadcastTimer = setInterval(() => this.broadcast(), this.broadcastMs()).unref();
    this.logger.log(`怪物 AI 已启动（tick ${this.tickMs()}ms / 广播 ${this.broadcastMs()}ms / 位置超时 ${this.posStaleMs()}ms）`);
  }

  onApplicationShutdown(): void {
    if (this.aiTimer) clearInterval(this.aiTimer);
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.aiTimer = null;
    this.broadcastTimer = null;
  }

  //#region 输入（通道侧调用）

  /**
   * 记录一次玩家位置上报（不校验图是否加载：上报先到、worldJoin 后到是正常时序）
   */
  updatePosition(accountId: string, zoneId: number, mapId: string, x: number, y: number, hp: number): void {
    this.positions.set(accountId, { zoneId, mapId, x, y, hp, updatedAt: Date.now() });
  }

  /**
   * 被动怪的记恨（结算侧在玩家打伤怪后调用）：之后这只怪在检测范围内会追击这个玩家
   */
  provoke(instanceId: string, accountId: string): void {
    const monster = this.world.find(instanceId);
    if (!monster) return;
    const runtime = this.runtimeOf(monster);
    runtime.provoked = accountId;
  }

  /** 怪物被击杀：AI 运行时作废（重生回出生点后按新的一轮游走重新开始） */
  onMonsterKilled(instanceId: string): void {
    for (const map of this.runtimes.values()) map.delete(instanceId);
  }

  /** 连接断开 / 被踢：位置上报作废（该玩家的目标下轮 tick 自然丢失） */
  dropAccount(accountId: string): void {
    this.positions.delete(accountId);
  }

  //#endregion

  //#region tick：目标选择 → 移动/普攻 → 攒命中事件

  private tick(): void {
    const now = Date.now();
    const viewed = this.world.viewedMaps();
    const viewedKeys = new Set<string>();

    for (const { zoneId, mapId, monsters } of viewed) {
      const key = worldKey(zoneId, mapId);
      viewedKeys.add(key);
      let runtimes = this.runtimes.get(key);
      if (!runtimes) {
        runtimes = new Map<string, MonsterRuntime>();
        this.runtimes.set(key, runtimes);
      }
      // 这张图上「位置新鲜且活着」的玩家（AI 的目标候选）
      const players: Array<[string, PlayerPosition]> = [];
      for (const [accountId, position] of this.positions) {
        if (position.zoneId !== zoneId || position.mapId !== mapId) continue;
        if (now - position.updatedAt > this.posStaleMs() || position.hp <= 0) continue;
        players.push([accountId, position]);
      }

      for (const monster of monsters.values()) {
        if (!monster.alive) {
          runtimes.delete(monster.instanceId);
          continue;
        }
        const config = MONSTERS[monster.monsterKey] as { aggressive: boolean; detectRange: number; moveSpeed: number } | undefined;
        if (!config) continue;
        const runtime = this.runtimeOf(monster);
        this.stepMonster(runtime, monster, config, players, now, key);
      }
    }

    // 没人看的分域：AI 运行时整份清掉（重进图时按出生点重建）
    for (const key of [...this.runtimes.keys()]) {
      if (!viewedKeys.has(key)) this.runtimes.delete(key);
    }
  }

  /** 推进一只怪：先校验/获取目标，再按「有目标追击普攻 / 没目标待机游走」走一步 */
  private stepMonster(
    runtime: MonsterRuntime,
    monster: WorldMonster,
    config: { aggressive: boolean; detectRange: number; moveSpeed: number },
    players: Array<[string, PlayerPosition]>,
    now: number,
    mapKey: string,
  ): void {
    // 目标校验：上报超时 / 换图 / 死亡都算丢失（记恨不清，与客户端旧语义一致）
    if (runtime.target) {
      const position = this.positions.get(runtime.target);
      const fresh = position && position.hp > 0 && Date.now() - position.updatedAt <= this.posStaleMs();
      if (!fresh) runtime.target = null;
    }
    // 目标获取：主动怪发现检测范围内最近玩家；被动怪只认记恨的那个人
    if (!runtime.target) {
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const [accountId, position] of players) {
        if (!config.aggressive && runtime.provoked !== accountId) continue;
        const distance = Math.hypot(position.x - runtime.x, position.y - runtime.y);
        if (distance <= config.detectRange && distance < bestDistance) {
          best = accountId;
          bestDistance = distance;
        }
      }
      if (best) {
        runtime.target = best;
        // 进入追击：停留点定在当前位置，待机游走计时归零（与客户端 followAnchor 同语义）
        runtime.anchorX = runtime.x;
        runtime.anchorY = runtime.y;
        runtime.idleMoveEndAt = 0;
      }
    }

    if (runtime.target) {
      const position = this.positions.get(runtime.target);
      if (!position) return;
      const distance = Math.hypot(position.x - runtime.x, position.y - runtime.y);
      if (distance <= AI.attackRange) {
        // 站定出手：按普攻间隔结算一次
        runtime.movingNow = false;
        if (now >= runtime.nextAttackAt) {
          runtime.nextAttackAt = now + AI.attackInterval;
          const hit = this.attack(monster, runtime.target);
          if (hit) {
            const list = this.pendingHits.get(mapKey) ?? [];
            list.push(hit);
            this.pendingHits.set(mapKey, list);
          }
        }
        return;
      }
      // 追击：直线趋近（不做寻路，与客户端旧口径一致）
      const step = Math.min(distance, (config.moveSpeed * this.tickMs()) / 1000);
      runtime.x += ((position.x - runtime.x) / distance) * step;
      runtime.y += ((position.y - runtime.y) / distance) * step;
      runtime.movingNow = true;
      return;
    }

    // 没目标：待机游走（停留点 + 活动半径，与客户端 stayIdle / wanderStep 同口径）
    if (now >= runtime.nextIdleMoveAt && runtime.idleMoveEndAt <= now) {
      runtime.nextIdleMoveAt = now + randomBetween(AI.idleMoveInterval);
      runtime.idleMoveEndAt = now + randomBetween(AI.idleMoveDuration);
      const offsetX = runtime.x - runtime.anchorX;
      const offsetY = runtime.y - runtime.anchorY;
      const fromAnchor = Math.hypot(offsetX, offsetY);
      if (fromAnchor > AI.wanderRadius) {
        // 离停留点超过活动半径：往回走
        runtime.idleMoveDirectionX = -offsetX / fromAnchor;
        runtime.idleMoveDirectionY = -offsetY / fromAnchor;
      } else {
        const angle = Math.random() * Math.PI * 2;
        runtime.idleMoveDirectionX = Math.cos(angle);
        runtime.idleMoveDirectionY = Math.sin(angle);
      }
    }
    if (runtime.idleMoveEndAt > now) {
      const speed = config.moveSpeed * AI.idleMoveSpeedScale;
      runtime.x += runtime.idleMoveDirectionX * ((speed * this.tickMs()) / 1000);
      runtime.y += runtime.idleMoveDirectionY * ((speed * this.tickMs()) / 1000);
      runtime.movingNow = true;
    } else {
      runtime.movingNow = false;
    }
  }

  /** 结算一次普攻：伤害 = 怪物物攻区间随机值 − 玩家物防区间随机值（裸属性，状态不参与） */
  private attack(monster: WorldMonster, accountId: string): RealtimeMonsterHit | null {
    const role = this.roles.online(accountId);
    if (!role) return null;
    const stats = this.monsterConfigs.findByKey(monster.monsterKey);
    if (!stats) return null;
    const summary = summarizeRoleAttributes(role);
    const attack = rollRange([Number(stats.physical_attack_min) || 0, Number(stats.physical_attack_max) || 0]);
    const defense = summary ? rollRange(summary.physicalDefense) : 0;
    const damage = Math.max(0, attack - defense);
    const applied = this.roles.applyMonsterHit(accountId, damage);
    if (!applied) return null;
    // 位置缓存里的血量同步（下轮目标校验用它，不再多打一次库）
    const position = this.positions.get(accountId);
    if (position) position.hp = applied.hp;
    return { instanceId: monster.instanceId, accountId, damage, hp: applied.hp, maxHp: applied.maxHp };
  }

  //#endregion

  //#region 广播：只发有变化的怪 + 攒下的命中事件

  private broadcast(): void {
    if (this.onBroadcast === null && this.pendingHits.size === 0) return;
    for (const [key, runtimes] of this.runtimes) {
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
      const hits = this.pendingHits.get(key) ?? [];
      this.pendingHits.delete(key);
      const monsters: RealtimeMonsterAiEntry[] = [];
      for (const [instanceId, runtime] of runtimes) {
        const moved = Math.abs(runtime.x - runtime.sentX) > 0.01 || Math.abs(runtime.y - runtime.sentY) > 0.01;
        const turn = runtime.movingNow !== runtime.sentMoving;
        if (!moved && !turn) continue;
        monsters.push({ instanceId, x: Math.round(runtime.x * 100) / 100, y: Math.round(runtime.y * 100) / 100, moving: runtime.movingNow });
        runtime.sentX = runtime.x;
        runtime.sentY = runtime.y;
        runtime.sentMoving = runtime.movingNow;
      }
      if (monsters.length === 0 && hits.length === 0) continue;
      this.onBroadcast?.(zoneId, mapId, { mapId, monsters, hits });
    }
  }

  //#endregion

  //#region 运行时与配置

  /** 取（或按出生点初始化）一只怪的 AI 运行时 */
  private runtimeOf(monster: WorldMonster): MonsterRuntime {
    const key = worldKey(monster.zoneId, monster.mapId);
    let map = this.runtimes.get(key);
    if (!map) {
      map = new Map<string, MonsterRuntime>();
      this.runtimes.set(key, map);
    }
    const existed = map.get(monster.instanceId);
    if (existed) return existed;
    const runtime: MonsterRuntime = {
      x: monster.x,
      y: monster.y,
      target: null,
      provoked: null,
      nextAttackAt: 0,
      anchorX: monster.x,
      anchorY: monster.y,
      idleMoveEndAt: 0,
      idleMoveDirectionX: 0,
      idleMoveDirectionY: 0,
      nextIdleMoveAt: Date.now() + randomBetween(AI.idleMoveInterval),
      sentX: monster.x,
      sentY: monster.y,
      sentMoving: false,
      movingNow: false,
    };
    map.set(monster.instanceId, runtime);
    return runtime;
  }

  private tickMs(): number {
    return Math.max(20, Number(this.config.get<number>("monsterAiTickMs") ?? 100));
  }

  private broadcastMs(): number {
    return Math.max(50, Number(this.config.get<number>("monsterAiBroadcastMs") ?? 200));
  }

  private posStaleMs(): number {
    return Math.max(500, Number(this.config.get<number>("monsterAiPosStaleMs") ?? 3000));
  }

  //#endregion
}
