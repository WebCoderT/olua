import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MONSTER_COMBAT } from "../../shared/game-data.generated";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { WorldMonsterRow } from "../../database/rows";

/** 服务端持有的一只怪物实例（权威状态；内存形态，落盘见 WorldMonsterRow） */
export interface WorldMonster {
  /** 实例 id（服务端发牌，`m<mapId>_<n>`，跨重启稳定不重号） */
  instanceId: string;
  mapId: string;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 MONSTER_COMBAT） */
  monsterKey: string;
  /** 出生点（世界坐标；重生的落点也是它） */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 死亡时刻（毫秒）；存活为 null */
  killedAt: number | null;
  /** 预定重生时刻（毫秒）；存活为 null */
  respawnAt: number | null;
  /** 内存里改过还没落盘（tick 按节流批量写库） */
  dirty: boolean;
}

/** 客户端播种计划里的一只怪 */
export interface SpawnPlanEntry {
  monsterKey: string;
  x: number;
  y: number;
}

/** 快照里的一只怪（world 帧的 monsters 列表项，见 realtime.protocol.ts） */
export interface WorldMonsterSnapshot {
  instanceId: string;
  monsterKey: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  x: number;
  y: number;
  respawnInMs?: number;
}

/**
 * 世界权威（#35：服务端第一次持有「常驻状态 + 定时循环」）
 *
 * ===========================================================================
 * 服务端持有什么
 * ===========================================================================
 * 一张图一份怪物实例表（跨账号**共享**——不是每账号一份）：血量 / 存活 / 出生点。
 * 权威状态只此一份，客户端拿到的是快照（`world` 帧），出手的血量变化走 #34 的
 * settle（写这里），死亡后的重生由 tick 驱动。
 *
 * **不持有**的东西（边界别越）：
 * - 怪物的游走 / 追击移动 —— 仍是客户端表现层，坐标不回传；服务端记的「坐标」
 *   是出生点，那是世界里唯一稳定的真相；
 * - 掉落 / 经验 —— 仍在客户端结算（各自有独立 issue）；
 * - 刷怪**区域**配置 —— 住在客户端的 Tiled 地图文件里（素材不入库，服务端拿不到）。
 *   所以进图由客户端播种（`worldJoin` 带刷怪计划），服务端把它当建议：
 *   已有实例一概沿用，缺的才创建。
 *
 * ===========================================================================
 * tick 的两件事（频率见配置 WORLD_TICK_MS / WORLD_PERSIST_MS）
 * ===========================================================================
 * 1. 重生：死亡满 `worldRespawnMs` 的实例复活（满血、回出生点），并通知观看者；
 * 2. 落盘：把脏实例批量写回 SQLite —— 受击只标脏，真正的写由这里节流完成
 *    （不然一次出手就是一次 SQLite 写，与玩家存档防抖叠在一起写放大明显）。
 *    优雅关闭时**全量 flush**，所以节流间隔只影响「进程被硬杀时最多丢几秒状态」。
 *
 * ===========================================================================
 * 生命周期
 * ===========================================================================
 * - 图实例**惰性加载**：第一个观看者进图时从库里恢复（没有就按播种计划创建）；
 * - 玩家全下线不等于立刻卸载：空闲满 `worldMapIdleMs` 才从内存卸载（状态已在库），
 *   卸载期间不跑重生，重新加载时按当前时刻一次性补上到期的；
 * - 优雅关闭：`onApplicationShutdown` 停 tick、全量落盘 —— SQLite 连接在其后由
 *   DatabaseService 关闭（Nest 的关闭顺序保证这一点）。
 */
@Injectable()
export class WorldService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorldService.name);

  /** mapId → 实例表（内存里只留「看过」的图，空闲回收） */
  private readonly maps = new Map<string, Map<string, WorldMonster>>();
  /** mapId → 正在看这张图的账号（广播与空闲回收的依据） */
  private readonly viewers = new Map<string, Set<string>>();
  /** mapId → 变成无人观看的时刻（毫秒）；有人看时删掉 */
  private readonly emptySince = new Map<string, number>();
  /** 每张图的发牌序号（instanceId 的 `_n` 段；加载时从库里的最大值续起，重启不重号） */
  private readonly instanceSeq = new Map<string, number>();

  private tickTimer: NodeJS.Timeout | null = null;

  /**
   * 世界变化的广播出口（世界帧发给谁、怎么发，是通道的事 —— 世界层不知道连接存在）。
   * RealtimeService 启动时接线；未接线时变化照常发生，只是没人收到推送（下个 join 会拿到全量）。
   */
  onWorldChanged: ((mapId: string) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly worldMonsters: WorldMonsterRepository,
  ) {}

  onApplicationBootstrap(): void {
    const total = this.worldMonsters.countAll();
    this.tickTimer = setInterval(() => this.tick(), this.tickMs()).unref();
    this.logger.log(`世界权威已启动（tick ${this.tickMs()}ms / 落盘节流 ${this.persistMs()}ms / 重生 ${this.respawnMs()}ms，库里已有 ${total} 只怪）`);
  }

  /** 优雅关闭：停 tick + 全量落盘（SQLite 连接随后由 DatabaseService 收尾） */
  onApplicationShutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.flushAll();
  }

  //#region 进图 / 离图

  /**
   * 进图登记：惰性加载该图实例（库里恢复或按播种计划创建），把账号记为观看者，
   * 返回权威快照（`world` 帧的 data）。**重复 join 同一图是幂等的**（断线重连走这里拿回状态）。
   */
  join(accountId: string, mapId: string, spawnPlan: SpawnPlanEntry[]): { mapId: string; monsters: WorldMonsterSnapshot[] } {
    const map = this.loadMap(mapId, spawnPlan);
    let viewerSet = this.viewers.get(mapId);
    if (!viewerSet) {
      viewerSet = new Set<string>();
      this.viewers.set(mapId, viewerSet);
    }
    viewerSet.add(accountId);
    this.emptySince.delete(mapId);
    return { mapId, monsters: [...map.values()].map(snapshotOf) };
  }

  /** 离图（连接断开时由通道调用）：观看者退掉；世界状态照常留着（别的观看者还在玩） */
  leave(accountId: string): void {
    for (const [mapId, viewerSet] of this.viewers) {
      if (!viewerSet.delete(accountId)) continue;
      if (viewerSet.size === 0) {
        this.viewers.delete(mapId);
        this.emptySince.set(mapId, Date.now());
      }
    }
  }

  /** 一张图的权威快照（`world` 帧的 data）；图不在内存（未加载 / 已回收）返回 null */
  snapshot(mapId: string): { mapId: string; monsters: WorldMonsterSnapshot[] } | null {
    const map = this.maps.get(mapId);
    if (!map) return null;
    return { mapId, monsters: [...map.values()].map(snapshotOf) };
  }

  /** 正在看一张图的账号（广播出口按它找人；只读，别改） */
  viewersOf(mapId: string): Iterable<string> {
    return this.viewers.get(mapId) ?? [];
  }

  //#endregion

  //#region 结算入口（#34 的 settle 走这里改世界状态）

  /**
   * 给一只实例扣血（结算服务算完伤害后调用）
   * @returns 扣完的血量与是否死亡；实例不存在或已死返回 null（调用方负责拒绝码）
   */
  applyDamage(instanceId: string, damage: number): { hp: number; killed: boolean } | null {
    const monster = this.find(instanceId);
    if (!monster || !monster.alive) return null;
    monster.hp = Math.max(0, monster.hp - damage);
    monster.dirty = true;
    if (monster.hp <= 0) {
      const now = Date.now();
      monster.alive = false;
      monster.killedAt = now;
      monster.respawnAt = now + this.respawnMs();
    }
    return { hp: monster.hp, killed: !monster.alive };
  }

  /** 查一只实例（结算服务校验 targetId / monsterKey / 存活用） */
  find(instanceId: string): WorldMonster | null {
    for (const map of this.maps.values()) {
      const monster = map.get(instanceId);
      if (monster) return monster;
    }
    return null;
  }

  //#endregion

  //#region tick：重生 + 节流落盘 + 空闲回收

  private tick(): void {
    const now = Date.now();
    for (const [mapId, map] of this.maps) {
      if (processRespawns(map, now)) {
        // 有重生：标脏由 processRespawns 做，这里只负责让观看者知道
        this.onWorldChanged?.(mapId);
      }
    }
    this.flushDirty();
    if (this.idleMs() > 0) this.reclaimIdle(now);
  }

  /** 到期重生的补处理（tick 与重新加载共用一条口径，见 processRespawns 的注释） */
  //#endregion

  //#region 落盘

  /** 把脏实例批量写库（一次事务，撞锁时由 busy_timeout 等待而不是报错） */
  private flushDirty(): void {
    const dirty = [...this.maps.values()].flatMap((map) => [...map.values()]).filter((monster) => monster.dirty);
    if (dirty.length === 0) return;
    try {
      this.worldMonsters.upsertBatch(dirty.map(toRow));
      for (const monster of dirty) monster.dirty = false;
    } catch (error) {
      // 落盘失败不中断世界（内存里还是对的），下个节流周期再试；关服时的全量 flush 会再兜一次
      this.logger.warn(`世界状态落盘失败（下个周期重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 全量落盘（优雅关闭时用；连脏标记都重置，保证幂等） */
  private flushAll(): void {
    const all = [...this.maps.values()].flatMap((map) => [...map.values()]);
    if (all.length === 0) return;
    try {
      this.worldMonsters.upsertBatch(all.map(toRow));
      this.logger.log(`世界状态已全部落盘（${all.length} 只怪）`);
    } catch (error) {
      this.logger.error(`世界状态关机落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  //#endregion

  //#region 空闲回收

  private reclaimIdle(now: number): void {
    for (const [mapId, since] of this.emptySince) {
      if (now - since < this.idleMs()) continue;
      this.emptySince.delete(mapId);
      this.maps.delete(mapId);
      this.instanceSeq.delete(mapId);
      this.logger.log(`地图 ${mapId} 无人观看已空闲 ${Math.round(this.idleMs() / 1000)}s，实例已从内存卸载（状态在库里）`);
    }
  }

  //#endregion

  //#region 图实例的加载与播种

  /**
   * 取一张图的实例表（内存 → 库 → 播种，三层兜底）
   *
   * 播种只发生在**空图**上：库里（或本次恢复）已有实例就一概沿用、plan 整份忽略。
   * 不做「逐条补缺」—— plan 的条目没有身份（客户端每次进图的落点是随机的），
   * 拿它对已有实例去重只会得到「看起来能用、实际每次进图都在悄悄加怪」的假去重。
   * 代价是「客户端改了刷怪配置」不会自动生效（要清这张图的世界状态），这正是
   * 世界权威的自然结果：服务端的现状不再听任客户端随手改写。
   */
  private loadMap(mapId: string, spawnPlan: SpawnPlanEntry[]): Map<string, WorldMonster> {
    let map = this.maps.get(mapId);
    if (map) return map;

    map = new Map<string, WorldMonster>();
    const rows = this.worldMonsters.listByMap(mapId);
    let maxSeq = 0;
    for (const row of rows) {
      const monster = fromRow(row);
      map.set(monster.instanceId, monster);
      maxSeq = Math.max(maxSeq, parseSeq(monster.instanceId));
    }
    this.instanceSeq.set(mapId, maxSeq);

    // 播种：空图才建。怪 key 存在性对照 MONSTER_COMBAT（不认识的条目跳过并报警）
    if (rows.length === 0) {
      for (const entry of spawnPlan) {
        if (!validPlanEntry(entry)) continue;
        if (!MONSTER_COMBAT[entry.monsterKey as keyof typeof MONSTER_COMBAT]) {
          this.logger.warn(`地图 ${mapId} 的播种计划里有不认识的怪物 key（${entry.monsterKey}），跳过`);
          continue;
        }
        this.createMonster(mapId, map, entry);
      }
    }

    // 恢复 / 播种之后，把卸载期间到期未处理的重生一次性补上（与 tick 同一条口径）
    processRespawns(map, Date.now());

    this.maps.set(mapId, map);
    if (map.size > rows.length) {
      this.logger.log(`地图 ${mapId} 已加载：库里恢复 ${rows.length} 只，播种新建 ${map.size - rows.length} 只`);
    }
    return map;
  }

  private createMonster(mapId: string, map: Map<string, WorldMonster>, entry: SpawnPlanEntry): void {
    const stats = MONSTER_COMBAT[entry.monsterKey as keyof typeof MONSTER_COMBAT];
    const seq = (this.instanceSeq.get(mapId) ?? 0) + 1;
    this.instanceSeq.set(mapId, seq);
    const instanceId = `m${mapId}_${seq}`;
    const monster: WorldMonster = {
      instanceId,
      mapId,
      monsterKey: entry.monsterKey,
      x: entry.x,
      y: entry.y,
      hp: Number(stats.maxHp),
      maxHp: Number(stats.maxHp),
      alive: true,
      killedAt: null,
      respawnAt: null,
      dirty: true,
    };
    map.set(instanceId, monster);
  }

  //#endregion

  //#region 配置读取

  private tickMs(): number {
    return this.config.get<number>("worldTickMs") ?? 1000;
  }

  private persistMs(): number {
    return this.config.get<number>("worldPersistMs") ?? 5000;
  }

  private respawnMs(): number {
    return this.config.get<number>("worldRespawnMs") ?? 30_000;
  }

  private idleMs(): number {
    return this.config.get<number>("worldMapIdleMs") ?? 0;
  }

  //#endregion
}

//#region 纯函数（e2e / 单测可对照）

/**
 * 到期重生的补处理（tick 与重新加载共用这一条口径）
 *
 * 重生 = 满血、回出生点、清掉死亡时间戳。返回本轮重生了几只（调用方据此决定要不要广播）。
 * 「卸载的图不跑 tick、重载时一次性补上」靠的就是它接受任意 `now`：错过多个周期也不会
 * 连环重生，只补一次。
 */
export function processRespawns(map: Map<string, WorldMonster>, now: number): number {
  let revived = 0;
  for (const monster of map.values()) {
    if (monster.alive || monster.respawnAt === null || monster.respawnAt > now) continue;
    monster.alive = true;
    monster.hp = monster.maxHp;
    monster.killedAt = null;
    monster.respawnAt = null;
    monster.dirty = true;
    revived += 1;
  }
  return revived;
}

/** 内存实例 → 数据库行（写入形态） */
function toRow(monster: WorldMonster): WorldMonsterRow {
  return {
    instance_id: monster.instanceId,
    map_id: monster.mapId,
    monster_key: monster.monsterKey,
    x: monster.x,
    y: monster.y,
    hp: monster.hp,
    max_hp: monster.maxHp,
    alive: monster.alive ? 1 : 0,
    killed_at: monster.killedAt,
    respawn_at: monster.respawnAt,
    updated_at: Date.now(),
  };
}

/** 数据库行 → 内存实例（恢复形态；从库里加载出来的不标脏 —— 没改过不用写回去） */
function fromRow(row: WorldMonsterRow): WorldMonster {
  return {
    instanceId: row.instance_id,
    mapId: row.map_id,
    monsterKey: row.monster_key,
    x: row.x,
    y: row.y,
    hp: row.hp,
    maxHp: row.max_hp,
    alive: row.alive === 1,
    killedAt: row.killed_at,
    respawnAt: row.respawn_at,
    dirty: false,
  };
}

/** 实例 → 快照（world 帧的下发形态；死亡中的怪带重生倒计时） */
function snapshotOf(monster: WorldMonster): WorldMonsterSnapshot {
  const now = Date.now();
  return {
    instanceId: monster.instanceId,
    monsterKey: monster.monsterKey,
    hp: monster.hp,
    maxHp: monster.maxHp,
    alive: monster.alive,
    x: monster.x,
    y: monster.y,
    ...(monster.alive || monster.respawnAt === null ? {} : { respawnInMs: Math.max(0, monster.respawnAt - now) }),
  };
}

/** 播种条目的最小校验（key 非空、坐标是有限数；怪 key 存在性由调用方对照 MONSTER_COMBAT） */
function validPlanEntry(entry: SpawnPlanEntry): boolean {
  return (
    typeof entry?.monsterKey === "string" &&
    entry.monsterKey !== "" &&
    Number.isFinite(entry.x) &&
    Number.isFinite(entry.y)
  );
}

/** 从 instanceId 解析发牌序号（`m1_3` → 3；解析不出按 0，重启后续号从它之上开始） */
function parseSeq(instanceId: string): number {
  const at = instanceId.lastIndexOf("_");
  if (at < 0) return 0;
  const seq = Number(instanceId.slice(at + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

//#endregion
