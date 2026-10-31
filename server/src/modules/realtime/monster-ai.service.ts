import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MONSTERS, MONSTER_AI } from "../../shared/game-data.generated";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { MonsterSkillRepository } from "../../database/repositories/monster-skill.repository";
import { SkillRepository } from "../../database/repositories/skill.repository";
import { StatusRepository } from "../../database/repositories/status.repository";
import { SkillRow, StatusRow } from "../../database/rows";
import { parseCoefficientsJson, parseCombatJson } from "../../common/config-json";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import { WorldService, worldKey, type WorldMonster } from "../world/world.service";
import type { RealtimeMonsterAiEntry, RealtimeMonsterCast, RealtimeMonsterHit } from "./realtime.protocol";

/** 怪物 AI 参数（生成物 MONSTER_AI：普攻间隔 / 普攻距离 / 待机游走节奏，与客户端同源） */
const AI = MONSTER_AI as unknown as {
  attackInterval: number;
  attackRange: number;
  attackActionTime: number;
  idleMoveInterval: [number, number];
  idleMoveDuration: [number, number];
  idleMoveSpeedScale: number;
  wanderRadius: number;
};

/**
 * 技能 / 挂载 / 状态的读库缓存时长（毫秒）
 *
 * 为什么需要缓存：管理端与实时进程是**两个进程**（3100 / 3101），只能通过共享的 SQLite
 * 交换改动，没法直接通知。每 tick 都查三张表（skills / statuses / monster_skills）在
 * 一张图上几十只怪时是纯浪费；1 秒 TTL 换来「改完最多 1 秒生效」，与 #258 的读库口径一致。
 */
const SKILL_CACHE_TTL_MS = 1000;

/**
 * 一个可释放技能的运行时快照（技能行 + 挂载条目 + 状态行合并后的结果）
 *
 * 提前合并的理由：AI 每 tick 每只怪都要判断「能不能放、放哪个」，不该在那里做 JSON 解析。
 */
interface CastPlan {
  skillId: string;
  /** 分类原值：0 主动（打伤害）/ 2 状态（给自己挂 buff）。其它分类不参与怪物 AI */
  category: string;
  priority: number;
  /** 冷却（秒）：挂载条目覆写优先，其次技能自身的 cooldown */
  cooldown: number;
  /** 施法距离（像素；状态型忽略距离） */
  distance: number;
  /** 施法硬直（毫秒）：0 = 回落到普攻动作时长 AI.attackActionTime */
  castLockMs: number;
  /** 伤害系数（取等级 1 的第一条；怪物不练级） */
  baseType: string;
  rate: number;
  statusId: string;
  /** 状态持续（秒） */
  statusDuration: number;
}

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
  /** 技能冷却（skillId → 可再次释放的时刻，毫秒；#372） */
  skillReadyAt: Map<string, number>;
  /** 自己身上的状态（statusId → 到期时刻，毫秒；#372 服务端生效，不叠层只刷新） */
  statuses: Map<string, number>;
  /** 施法硬直到期时刻（毫秒）：期间既不移动也不出手（#372） */
  castEndAt: number;
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
 * 技能行 + 挂载条目 → 可执行的 CastPlan（不可用返回 null）
 *
 * 三种「配了也放不出来」的组合在这里挡掉，省得 AI 每 tick 白跑：
 * - 分类不是主动 / 状态（被动与回复不归怪物 AI 管）；
 * - 主动技能没有伤害系数（放出去伤害恒 0，与角色侧 `assertSkillConsistency` 同一理由）；
 * - 状态型技能指向的状态行不存在（被删了 / 改了 id）。
 */
function buildCastPlan(skill: SkillRow, priority: number, cooldownOverride: number | null, status: StatusRow | undefined): CastPlan | null {
  if (skill.category !== "0" && skill.category !== "2") return null;
  const coefficients = parseCoefficientsJson(skill.damage_coefficients);
  const first = coefficients[0];
  const rate = first ? Number(first.baseTypeRate) || 0 : 0;
  if (skill.category === "0" && rate <= 0) return null;
  if (skill.category === "2" && (!status || !skill.status_id)) return null;
  return {
    skillId: skill.id,
    category: skill.category,
    priority,
    cooldown: cooldownOverride ?? (Number(skill.cooldown) || 0),
    distance: Number(skill.distance) || 0,
    castLockMs: Number(skill.cast_lock_ms) || 0,
    baseType: String(first?.baseType ?? "physicalAttack"),
    rate,
    statusId: skill.status_id,
    statusDuration: status ? Number(status.duration) || 0 : 0,
  };
}

/**
 * 怪物 AI（#323：目标选择 / 移动 / 普攻与玩家受击的权威都在服务端；#372 起还会放技能）
 *
 * ===========================================================================
 * 服务端模拟什么
 * ===========================================================================
 * 每只**有人看的图**上的存活怪，跑一套与客户端旧 MonsterAI 同口径的状态机：
 * - 目标选择：主动怪常驻发现；被动怪被打伤后记恨打它的人（结算侧 provoke 进来）；
 *   玩家离开检测范围即丢失目标（记恨不清，回来继续被追 —— 与客户端语义一致）；
 * - 移动：待机游走（停留点 + 随机方向 + 活动半径）与追击（直线趋近，不做寻路），
 *   速度用快照里每只怪的 `moveSpeed`（像素/秒，与客户端同一数值）；
 * - 出手：进入距离后**先试技能、再普攻**（#372，见下节）；普攻伤害 = 怪物物攻区间随机值
 *   （monsters 表，#258 起读库即时生效）× 攻击倍率 − 玩家物防区间随机值（服务端重算属性），
 *   受击走 `RolesService.applyMonsterHit` 落账（血量权威在服务端，revision 不推进）。
 *
 * ===========================================================================
 * 技能（#372）
 * ===========================================================================
 * 依据三张表（都读库、1 秒 TTL）：`monster_skills`（哪只怪放哪些、优先级、冷却覆写）、
 * `skills`（owner=monster 的技能行：动作 / 特效 / 倍率 / 距离 / 施法硬直 / 挂载状态）、
 * `statuses`（状态持续时长与战斗修正）。
 *
 * - **顺序**：状态型整体先于伤害型（buff 先上），同类型内按 priority 升序；
 *   已经在身上的状态不重复放（等它到期）；
 * - **距离**：伤害型要够得着（技能 distance，钳到普攻距离下限）；状态型不看距离 ——
 *   追击路上就能给自己上 buff；
 * - **硬直**：`castLockMs`（0 回落 `AI.attackActionTime`）期间不移动不出手，
 *   同时把普攻间隔一并推后（普攻与施法共用同一个「出手」窗口）；
 * - **状态生效**：`attackMultiplier` 乘伤害、`defenseMultiplier` 乘被玩家打时的防御
 *   （`CombatSettlementService` 通过 `defenseMultiplierOf` 取），到期惰性清理。
 *
 * ===========================================================================
 * 刻意不做的
 * ===========================================================================
 * - **玩家侧状态数值不参与**（格挡 / 防御修正这些仍是客户端 StatusManager 的本地增益）：
 *   服务端按裸属性结算 —— 权威口径宁缺毋滥；怪物侧的状态从 #372 起是真的。
 * - **位置不落盘**：坐标的持久真相是出生点（世界服务的既有边界），重启后怪物回出生点
 *   重新游走 —— 几秒钟的表现层状态，不值得为它加一张表；
 * - 玩家位置不权威：客户端节流上报（`pos` 帧），服务端只把它当 AI 输入；
 *   超时没上报的玩家视作离场，怪物丢失目标；
 * - 怪物不消耗魔法值：技能表的 `mpCost` 只对角色生效（怪物没有资源系统）。
 *
 * ===========================================================================
 * 广播
 * ===========================================================================
 * 按 `MONSTER_AI_BROADCAST_MS` 节流：只发**有变化**的怪（位置变了或移动标记变了）
 * 加上这段时间的命中事件与技能释放 —— 站着的怪不发第二遍。帧形状见 protocol 的
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
  /** 本轮 tick 攒下的技能释放（`zone:mapId` → casts），广播时一并发出 */
  private readonly pendingCasts = new Map<string, RealtimeMonsterCast[]>();

  /** 技能缓存（#372）：怪物 key → 按释放顺序排好的 CastPlan；`loadedAt` 做 TTL */
  private skillPlans = new Map<string, CastPlan[]>();
  /** 状态行缓存（#372）：statusId → 行（算状态修正时不再查库） */
  private statusRows = new Map<string, StatusRow>();
  private skillCacheLoadedAt = 0;

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时 AI 照常跑，只是没人收到帧。
   */
  onBroadcast:
    | ((
        zoneId: number,
        mapId: string,
        data: { mapId: string; monsters: RealtimeMonsterAiEntry[]; hits: RealtimeMonsterHit[]; casts: RealtimeMonsterCast[] },
      ) => void)
    | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly world: WorldService,
    private readonly roles: RolesService,
    private readonly monsterConfigs: MonsterRepository,
    private readonly skillsRepo: SkillRepository,
    private readonly statusesRepo: StatusRepository,
    private readonly monsterSkillsRepo: MonsterSkillRepository,
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

  /** 怪物被击杀：AI 运行时作废（重生回出生点后按新的一轮游走重新开始，身上的状态一并清掉） */
  onMonsterKilled(instanceId: string): void {
    for (const map of this.runtimes.values()) map.delete(instanceId);
  }

  /** 连接断开 / 被踢：位置上报作废（该玩家的目标下轮 tick 自然丢失） */
  dropAccount(accountId: string): void {
    this.positions.delete(accountId);
  }

  //#endregion

  //#region 状态修正（#372：结算侧查询怪物身上的 buff）

  /**
   * 怪物当前受到的攻击倍率（多个状态连乘；没有状态 = 1）
   *
   * 与客户端 `BattleMath.collectStatusCombatModifiers` 同口径：越界 / 非数字忽略，
   * 到期立即不计入（惰性清理，不靠定时器）。
   */
  attackMultiplierOf(instanceId: string): number {
    return this.statusMultiplier(instanceId, "attackMultiplier");
  }

  /**
   * 怪物当前的防御倍率（玩家打它时乘在防御项上）
   *
   * `CombatSettlementService` 在算「攻击 - 防御」时取它 —— 没有这条，
   * 怪物放「硬化皮肤」就只是客户端动画。
   */
  defenseMultiplierOf(instanceId: string): number {
    return this.statusMultiplier(instanceId, "defenseMultiplier");
  }

  private statusMultiplier(instanceId: string, key: "attackMultiplier" | "defenseMultiplier"): number {
    const runtime = this.findRuntime(instanceId);
    if (!runtime || runtime.statuses.size === 0) return 1;
    this.refreshSkillCache(Date.now());
    const now = Date.now();
    let multiplier = 1;
    for (const [statusId, expiresAt] of runtime.statuses) {
      if (expiresAt <= now) {
        runtime.statuses.delete(statusId);
        continue;
      }
      const row = this.statusRows.get(statusId);
      if (!row) continue;
      const value = parseCombatJson(row.combat)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) multiplier *= value;
    }
    return multiplier;
  }

  private findRuntime(instanceId: string): MonsterRuntime | undefined {
    for (const map of this.runtimes.values()) {
      const runtime = map.get(instanceId);
      if (runtime) return runtime;
    }
    return undefined;
  }

  //#endregion

  //#region tick：目标选择 → 移动/技能/普攻 → 攒事件

  private tick(): void {
    const now = Date.now();
    this.refreshSkillCache(now);
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

    // 没人看的分域：AI 运行时整份清掉（重进图时按出生点重建；身上的状态也一并作废）
    for (const key of [...this.runtimes.keys()]) {
      if (!viewedKeys.has(key)) this.runtimes.delete(key);
    }
  }

  /** 推进一只怪：先校验/获取目标，再按「有目标技能或普攻 / 没目标待机游走」走一步 */
  private stepMonster(
    runtime: MonsterRuntime,
    monster: WorldMonster,
    config: { aggressive: boolean; detectRange: number; moveSpeed: number },
    players: Array<[string, PlayerPosition]>,
    now: number,
    mapKey: string,
  ): void {
    // 施法硬直：动作没播完之前既不移动也不出手（与客户端动作锁同一语义）。
    // 放在目标校验之前 —— 硬直期间不该因为目标丢失而中断这次释放的收尾。
    if (now < runtime.castEndAt) {
      runtime.movingNow = false;
      return;
    }

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
      // 技能优先（#372）：进入战斗才有意义 —— 没有敌人时给自己上 buff 没有价值
      if (this.tryCast(runtime, monster, distance, now, mapKey)) return;
      if (distance <= AI.attackRange) {
        // 站定出手：按普攻间隔结算一次
        runtime.movingNow = false;
        if (now >= runtime.nextAttackAt) {
          runtime.nextAttackAt = now + AI.attackInterval;
          const hit = this.attack(monster, runtime.target);
          if (hit) this.pushHit(mapKey, hit);
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

  //#endregion

  //#region 技能释放（#372）

  /**
   * 尝试放一个技能：按缓存里的顺序取第一个可用的
   *
   * 顺序在缓存构建时就排好了（状态型优先 + priority 升序 + id 稳定），这里只做四道判断：
   * 冷却、距离（仅伤害型）、状态是否已在身上、技能是否仍然有效（缓存里已经没有它了就跳过）。
   * 全都不满足返回 false，调用方回落到普攻。
   */
  private tryCast(runtime: MonsterRuntime, monster: WorldMonster, distance: number, now: number, mapKey: string): boolean {
    const plans = this.skillPlans.get(monster.monsterKey);
    if (!plans || plans.length === 0) return false;
    for (const plan of plans) {
      if (now < (runtime.skillReadyAt.get(plan.skillId) ?? 0)) continue;
      // 伤害型要够得着；状态型不看距离（追击路上也能给自己上 buff）
      if (plan.category === "0" && distance > Math.max(plan.distance, AI.attackRange)) continue;
      if (plan.category === "2" && runtime.statuses.has(plan.statusId) && (runtime.statuses.get(plan.statusId) ?? 0) > now) continue;
      this.castSkill(runtime, monster, plan, now, mapKey);
      return true;
    }
    return false;
  }

  /**
   * 释放一次技能
   *
   * 伤害型：按倍率算一次伤害，命中事件照旧走 `hits`（客户端只演数字）；
   * 状态型：给自己挂状态（同状态重复获得 = 刷新到期时间，不叠层），不发命中事件。
   * 两种都发 `casts`（客户端据此播动作 + 特效）。
   */
  private castSkill(runtime: MonsterRuntime, monster: WorldMonster, plan: CastPlan, now: number, mapKey: string): void {
    runtime.movingNow = false;
    runtime.skillReadyAt.set(plan.skillId, now + plan.cooldown * 1000);
    // 硬直：配置值优先；0 回落到普攻动作时长（服务端不知道客户端动画有多长）
    runtime.castEndAt = now + (plan.castLockMs > 0 ? plan.castLockMs : AI.attackActionTime);
    // 普攻与施法共用同一个出手窗口：技能放完不会立刻接一记普攻
    runtime.nextAttackAt = Math.max(runtime.nextAttackAt, now + AI.attackInterval);

    const cast: RealtimeMonsterCast = { instanceId: monster.instanceId, skillId: plan.skillId };
    if (plan.category === "2") {
      runtime.statuses.set(plan.statusId, now + plan.statusDuration * 1000);
      cast.statusId = plan.statusId;
    } else if (runtime.target) {
      const hit = this.attack(monster, runtime.target, plan.rate);
      if (hit) this.pushHit(mapKey, hit);
    }
    const list = this.pendingCasts.get(mapKey) ?? [];
    list.push(cast);
    this.pendingCasts.set(mapKey, list);
    this.logger.debug(
      `怪物 ${monster.instanceId}(${monster.monsterKey}) 释放技能 ${plan.skillId}（${plan.category === "2" ? `状态 ${plan.statusId}` : `伤害倍率 ${plan.rate}`}）`,
    );
  }

  //#endregion

  //#region 伤害

  /**
   * 结算一次出手（普攻或伤害型技能）
   *
   * 伤害 = round(怪物物攻区间随机值 × 攻击倍率 × 技能倍率 − 玩家物防区间随机值)，下限 0；
   * 攻击倍率来自身上的状态（#372）。玩家侧状态不参与（见类注释的「刻意不做的」）。
   */
  private attack(monster: WorldMonster, accountId: string, rate = 1): RealtimeMonsterHit | null {
    const role = this.roles.online(accountId);
    if (!role) return null;
    const stats = this.monsterConfigs.findByKey(monster.monsterKey);
    if (!stats) return null;
    // RoleDto 要摊平（装备/成长线在 data 里），否则玩家的防御只剩等级那一档
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data));
    const attack = rollRange([Number(stats.physical_attack_min) || 0, Number(stats.physical_attack_max) || 0]) * this.attackMultiplierOf(monster.instanceId);
    const defense = summary ? rollRange(summary.physicalDefense) : 0;
    const damage = Math.max(0, Math.round(attack * rate - defense));
    const applied = this.roles.applyMonsterHit(accountId, damage);
    if (!applied) return null;
    // 位置缓存里的血量同步（下轮目标校验用它，不再多打一次库）
    const position = this.positions.get(accountId);
    if (position) position.hp = applied.hp;
    return { instanceId: monster.instanceId, accountId, damage, hp: applied.hp, maxHp: applied.maxHp };
  }

  private pushHit(mapKey: string, hit: RealtimeMonsterHit): void {
    const list = this.pendingHits.get(mapKey) ?? [];
    list.push(hit);
    this.pendingHits.set(mapKey, list);
  }

  //#endregion

  //#region 广播：只发有变化的怪 + 攒下的命中与技能释放

  private broadcast(): void {
    if (this.onBroadcast === null && this.pendingHits.size === 0 && this.pendingCasts.size === 0) return;
    for (const [key, runtimes] of this.runtimes) {
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
      const hits = this.pendingHits.get(key) ?? [];
      this.pendingHits.delete(key);
      const casts = this.pendingCasts.get(key) ?? [];
      this.pendingCasts.delete(key);
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
      if (monsters.length === 0 && hits.length === 0 && casts.length === 0) continue;
      this.onBroadcast?.(zoneId, mapId, { mapId, monsters, hits, casts });
    }
  }

  //#endregion

  //#region 技能缓存（#372：三张表读库，1 秒 TTL）

  /**
   * 加载技能 / 状态 / 挂载三张表的快照（TTL 内直接返回）
   *
   * 顺序排序在构建时完成：**状态型整体先于伤害型**（buff 先上），同类型按 priority 升序，
   * 再按技能 id 兜底 —— 保证「同一只怪两轮 tick 里放技能的次序」是确定的。
   */
  private refreshSkillCache(now: number): void {
    if (now - this.skillCacheLoadedAt < SKILL_CACHE_TTL_MS) return;
    this.skillCacheLoadedAt = now;

    const skills = new Map<string, SkillRow>();
    for (const row of this.skillsRepo.listAll()) skills.set(row.id, row);
    const statuses = new Map<string, StatusRow>();
    for (const row of this.statusesRepo.listAll()) statuses.set(row.id, row);
    this.statusRows = statuses;

    const plans = new Map<string, CastPlan[]>();
    for (const mount of this.monsterSkillsRepo.listAll()) {
      const skill = skills.get(mount.skill_id);
      // 被删掉的技能（挂载行还在）在这里自然跳过：管理端删技能前会拒删被引用的，
      // 但两个进程之间仍有极小的窗口（删技能与挂载替换并发），跳过比抛错安全
      if (!skill || skill.owner !== "monster") continue;
      const plan = buildCastPlan(skill, mount.priority, mount.cooldown, statuses.get(skill.status_id));
      if (!plan) continue;
      const list = plans.get(mount.monster_key) ?? [];
      list.push(plan);
      plans.set(mount.monster_key, list);
    }
    for (const list of plans.values()) {
      list.sort((a, b) => (a.category === "2" ? 0 : 1) - (b.category === "2" ? 0 : 1) || a.priority - b.priority || a.skillId.localeCompare(b.skillId));
    }
    this.skillPlans = plans;
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
      skillReadyAt: new Map<string, number>(),
      statuses: new Map<string, number>(),
      castEndAt: 0,
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
