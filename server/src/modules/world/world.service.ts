import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { Room } from "./room/room";
import { RoomManager } from "./room/room.manager";
import {
  WorldMonster,
  WorldMonsterSnapshot,
  processRespawns,
  toWorldMonsterRow,
  worldMonsterSnapshotOf,
} from "./world-monster";

/**
 * 代际重载后的「只补不裁」宽限期（毫秒）
 *
 * 合并区会把源区的实例整批改牌搬进目标区（24 只 > 配置的目标 12 只）。那是**一次搬迁**，
 * 不是「配置改小了」—— 立刻按密度裁掉 12 只等于把源区那份世界状态扔掉，合并就白做了。
 * 所以重载后先容忍超编，宽限期内只补不裁；到期后仍由密度收口（怪本来也会死与重生，
 * 长期超编没有意义）。
 */
export const MERGE_TRIM_GRACE_MS = 5 * 60_000;

/** 重载结果的形状（世界层只报事实，「重播了几只」由调用方去记日志 / 写回执） */
export interface RoomReloadResult {
  roomId: string;
  mapId: string;
  slot: string;
  /** 删掉的旧实例数（库里的行数） */
  removed: number;
  /** 重播出的新实例数 */
  seeded: number;
  /** 强制执行（在场玩家看到怪整体重刷一次）还是等到了空窗 */
  forced: boolean;
}

/**
 * 世界权威（#35：服务端第一次持有「常驻状态 + 定时循环」；#809 起房间状态搬进 RoomManager）
 *
 * ===========================================================================
 * 服务端持有什么
 * ===========================================================================
 * **一「间房」**（区 + 图 + 线，见 `common/utils/room-key.util`）一份怪物实例表
 * （同房跨账号**共享**，跨房完全隔离）：血量 / 存活 / 出生点。权威状态只此一份，
 * 客户端拿到的是快照（`world` 帧），出手的血量变化走 #34 的 settle（写这里），
 * 死亡后的重生由 tick 驱动。
 *
 * **不持有**的东西（边界别越）：
 * - 怪物的游走 / 追击移动 —— 怪物 AI 运行时（`MonsterAiService`）持有，世界层记的
 *   坐标是出生点，那是世界里唯一稳定的真相；
 * - 「有哪些房间、每间有多少只」—— 那是 `RoomManager` 的事（#809 之前混在这个类里，
 *   导致每次「加载 / 卸载 / 作废 / 重载」都要在四处同步同一批字段）。
 *
 * ===========================================================================
 * tick 的四件事（频率见配置 WORLD_TICK_MS / WORLD_PERSIST_MS）
 * ===========================================================================
 * 1. 代际巡检：`world_meta.epoch` 变了 = 别的进程（或本进程的管理操作）改写了库里的
 *    世界（合并区搬账号、重排 instanceId）—— 把整份内存世界作废（**不落盘**：库里
 *    已是改写后的权威，落盘会把旧 id 写回去）。#851 起**有人看的房间当场按库重载并广播**，
 *    没人看的保持惰性（下次 join 再加载）；
 * 2. 重生：死亡满 `worldRespawnMs` 的实例复活（满血、回出生点），并通知观看者；
 * 3. 密度对齐（#852）：按「目标数 vs 当前实例数」的差量补 / 裁，每次最多补 2 只 ——
 *    运营改 `max` 或密度系数**下一秒就见效**（实现见 `RoomManager.alignDensity`）；
 * 4. 落盘：把脏实例批量写回 SQLite —— 受击只标脏，真正的写由这里按 `worldPersistMs`
 *    节流完成（不然一次出手就是一次 SQLite 写）。优雅关闭时**全量 flush**。
 *
 * ===========================================================================
 * 生命周期
 * ===========================================================================
 * - 房间**惰性加载**：第一个观看者进图时从库里恢复（没有就按刷怪区播种创建）；
 * - **一个账号同一时刻只在一间房里**（#821）：换图 = 先退出旧房再登记新房，
 *   由 `join` 自己保证，不靠调用方记得先 `leave`；
 * - 玩家全下线不等于立刻卸载：空闲满 `worldMapIdleMs` 才从内存卸载（状态已在库）；
 * - 优雅关闭：`onApplicationShutdown` 停 tick、全量落盘。
 */
@Injectable()
export class WorldService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorldService.name);

  /** 上次巡检到的世界代际（变了 = 库被别的进程改写过，见 tick 的代际巡检；bootstrap 时读真实值） */
  private epoch = 0;

  private tickTimer: NodeJS.Timeout | null = null;
  /** 上次落盘的时刻（#849：`worldPersistMs` 是节流间隔，不是「每次 tick 都 flush」） */
  private lastPersistAt = 0;

  /**
   * 世界变化的广播出口（世界帧发给谁、怎么发，是通道的事 —— 世界层不知道连接存在）。
   * RealtimeService 启动时接线；未接线时变化照常发生，只是没人收到推送（下个 join 会拿到全量）。
   */
  onWorldChanged: ((roomId: string) => void) | null = null;

  /**
   * 单图热重载完成后的通知出口（#809）：`realtime` 据此广播 `world.reload`，
   * 客户端收到后重建怪物并飘字「本图怪物已重刷」。
   */
  onRoomReloaded: ((result: RoomReloadResult) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly zones: ZoneRepository,
    private readonly roomManager: RoomManager,
  ) {}

  onApplicationBootstrap(): void {
    this.epoch = this.zones.getEpoch();
    const total = this.worldMonsters.countAll();
    this.tickTimer = setInterval(() => this.tick(), this.tickMs()).unref();
    this.logger.log(
      `世界权威已启动（tick ${this.tickMs()}ms / 落盘节流 ${this.persistMs()}ms / 重生 ${this.respawnMs()}ms，库里已有 ${total} 只怪）`,
    );
  }

  /** 优雅关闭：停 tick + 全量落盘（SQLite 连接随后由 DatabaseService 收尾） */
  onApplicationShutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.flushAll();
  }

  //#region 进图 / 离图

  /**
   * 进图登记：惰性加载该房间的实例（库里恢复或按刷怪区播种），把账号记为观看者，
   * 返回权威快照（`world` 帧的 data）。**重复 join 同一房间是幂等的**（断线重连走这里）。
   *
   * **换图也走这条**（#821）：登记前先把账号从所有房间的观看者里退掉。这是世界层的
   * 不变量 ——「一个人同一时刻只在一间房里」—— 写在这里就不可能被某个调用方漏掉。
   * 漏掉的后果不是「少退一条记录」：旧房 `viewers` 永不为空，`viewedRooms()` 永远带着它，
   * 于是那间房的怪物 AI 一直跑、监控一直采样、世界频道还在往一个不在那儿的人身上投递。
   */
  join(
    roomId: string,
    accountId: string,
  ): { roomId: string; mapId: string; slot: string; capacity: number; monsters: WorldMonsterSnapshot[] } {
    // 幂等：同房重进时这步等于「退掉再登记」，`emptySince` 被 addViewer 抹掉，不会误回收
    this.leave(accountId);
    const room = this.roomManager.ensure(roomId);
    this.roomManager.addViewer(room, accountId);
    return {
      roomId: room.roomId,
      mapId: room.mapId,
      slot: room.slot,
      capacity: room.capacity,
      monsters: [...room.monsters.values()].map(worldMonsterSnapshotOf),
    };
  }

  /**
   * 离图（连接断开 / 被踢下线 / 换图前由 `join` 调用）：观看者从**所有**房间退掉；
   * 退空的房间记下「从此刻起无人观看」，空闲回收按它算。
   */
  leave(accountId: string): void {
    this.roomManager.leave(accountId, Date.now());
  }

  /** 一间房的权威快照（`world` 帧的 data）；房间不在内存（未加载 / 已回收）返回 null */
  snapshot(roomId: string): { roomId: string; mapId: string; slot: string; capacity: number; monsters: WorldMonsterSnapshot[] } | null {
    const room = this.roomManager.get(roomId);
    if (!room) return null;
    return {
      roomId: room.roomId,
      mapId: room.mapId,
      slot: room.slot,
      capacity: room.capacity,
      monsters: [...room.monsters.values()].map(worldMonsterSnapshotOf),
    };
  }

  /** 正在看一间房的账号（广播出口按它找人；只读，别改） */
  viewersOf(roomId: string): Iterable<string> {
    return this.roomManager.get(roomId)?.viewers ?? [];
  }

  /**
   * 一间房里的一只只实例（#824 群体技能的候选池；只读，别改血量）
   *
   * 只给出**出生点**，不筛距离：几何口径属于战斗（半径、命中上限、用不用 AI 运行时坐标）
   * 而不属于世界层 —— 这里一旦长出 `near(x, y, r)`，世界层就要认识「技能半径」这件事。
   * 房间不在内存（未加载）返回空数组，调用方按「一个都打不到」处理。
   */
  monstersOf(roomId: string): WorldMonster[] {
    const room = this.roomManager.get(roomId);
    return room ? [...room.monsters.values()] : [];
  }

  /**
   * 当前**有人看**的房间（#323：怪物 AI tick 只驱动有人看的房 —— 没人看的房
   * 没有广播对象，纯空转）。实例表是权威状态本体，调用方只读、别改血量。
   */
  viewedRooms(): Room[] {
    return this.roomManager.viewedRooms();
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
    // #852：密度裁剪靠它判「正在被打的不删」（只在内存，不落库）
    monster.lastDamagedAt = Date.now();
    if (monster.hp <= 0) {
      const now = Date.now();
      monster.alive = false;
      monster.killedAt = now;
      monster.respawnAt = now + this.respawnMs();
    }
    return { hp: monster.hp, killed: !monster.alive };
  }

  /** 查一只实例（结算服务校验 targetId / monsterKey / 区归属 / 存活用） */
  find(instanceId: string): WorldMonster | null {
    for (const room of this.roomManager.list()) {
      const monster = room.monsters.get(instanceId);
      if (monster) return monster;
    }
    return null;
  }

  //#endregion

  //#region 单图热重载（#809，收 #669）

  /**
   * 重载一间房：删库行 → 清内存 → 按当前刷怪区重播 → 广播
   *
   * 只有 `RoomReloadService` 调它（它负责排队 / 强制那套决策）。这里只管「做得对不对」：
   * 房间不在内存时**先加载再重载** —— 否则「改完区域、图里没人」那种请求会变成空操作，
   * 下次有人进图还按旧库播种（库里已经被删空，于是重新播种时会用**新**区域，看起来是对的，
   * 但 `removed` 会算错，运营看到的「删了 N 只」是假的）。
   */
  reloadRoom(roomId: string, forced: boolean, mode: string): RoomReloadResult {
    const room = this.roomManager.ensure(roomId);
    const { removed, seeded } = this.roomManager.reload(room);
    const result: RoomReloadResult = { roomId, mapId: room.mapId, slot: room.slot, removed, seeded, forced };
    this.logger.log(
      `房间 ${roomId} 已按新刷怪区重载（mode=${mode}${forced ? "，强制执行" : ""}）：删 ${removed} 只、重播 ${seeded} 只`,
    );
    // **先推新快照，再发「重载过了」的通知**（#809）：重播换了整批实例 id，
    // 不推快照的话客户端手里全是已经不存在的 id —— 下一次出手就是 20008。
    // 顺序不能反：通知是给人看的（飘字），快照是给机器用的，先让机器对齐再提示。
    this.onWorldChanged?.(roomId);
    this.onRoomReloaded?.(result);
    return result;
  }

  //#endregion

  //#region tick：代际巡检 + 重生 + 密度 + 节流落盘 + 空闲回收

  private tick(): void {
    const now = Date.now();
    this.checkEpoch();
    for (const room of this.roomManager.list()) {
      let changed = processRespawns(room.monsters, now) > 0;
      // 密度对齐只对「有人看」的房间做：没人看的房按 docs/27「无人冻结」停常规刷怪，
      // 何况没有观看者时人数系数恒为 1，对齐也没意义
      if (room.viewers.size > 0) {
        changed = this.roomManager.alignDensity(room, now, this.refillPerTick()) > 0 || changed;
      }
      if (changed) this.onWorldChanged?.(room.roomId);
    }
    // 落盘按 worldPersistMs 节流（#849）：受击只标脏，真正的写在节流点一次事务写完
    if (now - this.lastPersistAt >= this.persistMs()) {
      this.lastPersistAt = now;
      this.flushDirty();
    }
    this.reclaimIdle(now);
  }

  /**
   * 代际巡检（#295 阶段二：跨进程的世界配置失效信号）
   *
   * 合并区在 API 进程里改写库（搬账号 + 重排 instanceId + epoch+1），而世界内存
   * 两个进程各有一份 —— 本进程发现 epoch 变了就把整份内存作废。**不落盘**：
   * 库里已经是改写后的权威状态，把旧 id 的脏行写回去等于把合并前的问题复活。
   *
   * #851：作废之后**不能只留个空壳**。只清内存不通知，客户端手里那些旧 `instanceId`
   * 会一直指着已经不存在的怪（出手就是 20008「目标不存在」），而下一个 world 帧可能
   * 十分钟后才来。所以分两步收口：
   * 1. **有人看的房间立刻按库重载**（没人看的保持惰性，下次 join 再加载 —— 那是常态）；
   * 2. **重载完广播一次 world 帧**，让观看者手上的实例表换成本次改写的真相。
   *
   * 「按库重载」严格照库：**库里这一房一行都没有就不播**。合并区刚把源区的行改牌搬走，
   * 那名（还挂在旧房间上的）观看者会让 `viewers` 非空 —— 这时候要是走 `ensure` 的
   * 「空房按刷怪区播种」，就会把刚并走的那个区**原样复活**一份（12 只 z2 怪重新入库），
   * 合并等于白做。播种只属于「第一个观看者进图」，不属于「代际变化」。
   */
  private checkEpoch(): void {
    const current = this.zones.getEpoch();
    if (current === this.epoch) return;
    const previous = this.epoch;
    this.epoch = current;
    const evicted = this.roomManager
      .list()
      .map((room) => ({ roomId: room.roomId, zoneId: room.zoneId, mapId: room.mapId, slot: room.slot, viewers: room.viewers.size }));
    this.roomManager.evictAll();
    let reloaded = 0;
    for (const room of evicted) {
      // 观看者集合随房间一起被清了：他们的连接还活着，下一次 join 会重新登记。
      // 这里只处理「有人看 = 该立刻按库重载」的那部分
      if (room.viewers === 0) continue;
      // 库里没有这一房的实例 = 它已经被合并/搬走：不重载、更不重新播种（见上面的注释）
      if (this.worldMonsters.listByRoom(room.zoneId, room.mapId, room.slot).length === 0) continue;
      const loaded = this.roomManager.ensure(room.roomId);
      loaded.trimGraceUntil = Date.now() + MERGE_TRIM_GRACE_MS;
      reloaded += 1;
      this.onWorldChanged?.(room.roomId);
    }
    if (evicted.length > 0) {
      this.logger.warn(
        `世界代际 ${previous} → ${current}，已作废内存中 ${evicted.length} 个房间（未落盘，状态以库为准）；` +
          `其中 ${reloaded} 个有人看，已按库重载并通知观看者`,
      );
    }
  }

  //#endregion

  //#region 落盘

  /** 把脏实例批量写库（一次事务，撞锁时由 busy_timeout 等待而不是报错） */
  private flushDirty(): void {
    const dirty = this.roomManager.allMonsters().filter((monster) => monster.dirty);
    if (dirty.length === 0) return;
    try {
      this.worldMonsters.upsertBatch(dirty.map(toWorldMonsterRow));
      for (const monster of dirty) monster.dirty = false;
    } catch (error) {
      // 落盘失败不中断世界（内存里还是对的），下个节流周期再试；关服时的全量 flush 会再兜一次
      this.logger.warn(`世界状态落盘失败（下个周期重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 全量落盘（优雅关闭时用；连脏标记都重置，保证幂等） */
  private flushAll(): void {
    const all = this.roomManager.allMonsters();
    if (all.length === 0) return;
    try {
      this.worldMonsters.upsertBatch(all.map(toWorldMonsterRow));
      this.logger.log(`世界状态已全部落盘（${all.length} 只怪）`);
    } catch (error) {
      this.logger.error(`世界状态关机落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  //#endregion

  //#region 空闲回收

  private reclaimIdle(now: number): void {
    for (const room of this.roomManager.reclaimIdle(now, this.idleMs())) {
      this.logger.log(
        `房间 ${room.roomId}（地图 ${room.mapId} / 区 ${room.zoneId} / 线 ${room.slot}）无人观看已空闲 ` +
          `${Math.round(this.idleMs() / 1000)}s，实例已从内存卸载（状态在库里）`,
      );
    }
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

  private refillPerTick(): number {
    return this.config.get<number>("worldRefillPerTick") ?? 2;
  }

  //#endregion
}
