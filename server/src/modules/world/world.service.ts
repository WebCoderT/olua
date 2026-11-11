import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MapRepository } from "../../database/repositories/map.repository";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { MapSpawnAreaRow, WorldMonsterRow } from "../../database/rows";
import {
  MapPixelRect,
  spawnAreaInBounds,
  spawnAreaOverflow,
  spawnAreaOverflowText,
} from "../../common/utils/spawn-area-bounds.util";
import { clampPointToMap, clampRectToMap, findAreaAt, spawnTargetOf } from "../../common/utils/spawn-density.util";

/**
 * 每个 tick 最多补几只（#852 / docs/27 E2）：一次补齐会让玩家看到「怪批量凭空出现」
 *
 * 跟着 tick 走而不是另设「每秒」计时器：默认 tick 1s ⇒ 每秒 2 只；把 `WORLD_TICK_MS`
 * 调小的环境（e2e）同比例变快，没人会以为「限速失效了」。
 */
export const DENSITY_REFILL_PER_TICK = 2;

/** 裁剪时的「正在被打」保护窗（毫秒）：这段时间内被攻击过的怪不删 */
export const DENSITY_TRIM_PROTECT_MS = 5_000;

/**
 * 代际重载后的「只补不裁」宽限期（毫秒）
 *
 * 合并区会把源区的实例整批改牌搬进目标区（24 只 > 配置的目标 12 只）。那是**一次搬迁**，
 * 不是「配置改小了」—— 立刻按密度裁掉 12 只等于把源区那份世界状态扔掉，合并就白做了。
 * 所以重载后先容忍超编，宽限期内只补不裁；到期后仍由密度收口（怪本来也会死与重生，
 * 长期超编没有意义）。
 */
export const MERGE_TRIM_GRACE_MS = 5 * 60_000;

/** 服务端持有的一只怪物实例（权威状态；内存形态，落盘见 WorldMonsterRow） */
export interface WorldMonster {
  /** 实例 id（服务端发牌，`m<mapId>_z<zone>_<n>`，跨重启稳定不重号） */
  instanceId: string;
  mapId: string;
  /** 归属区（#295 阶段二：同一张图各区各有一份独立世界） */
  zoneId: number;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 monsters 表） */
  monsterKey: string;
  /** 归属刷怪区（#852：密度补种按它统计「这一区现在几只」；老档可空） */
  areaId: number | null;
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
  /**
   * 最后一次被攻击的时刻（毫秒；只在内存里，不落库）
   *
   * 只有一个消费方：密度裁剪（#852）要「删最久没被攻击的」，且**正在被打的不删**。
   * 不落库是因为它只在本次进程的生命周期内有意义 —— 重启后所有人都已经脱战了。
   */
  lastDamagedAt: number | null;
  /** 内存里改过还没落盘（tick 按节流批量写库） */
  dirty: boolean;
}

/** 快照里的一只怪（world 帧的 monsters 列表项，见 realtime.protocol.ts） */
export interface WorldMonsterSnapshot {
  instanceId: string;
  monsterKey: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  /**
   * 出生点（世界坐标）。**这不是「他现在在哪」** —— 世界层不持有走动，怪的位置只有怪物 AI
   * 运行时知道；通道把快照发出去之前会按运行时坐标覆盖它（#670，见 RealtimeService）。
   */
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
 * **一个区的一张图**一份怪物实例表（同区跨账号**共享**，跨区完全隔离）：血量 / 存活 /
 * 出生点。权威状态只此一份，客户端拿到的是快照（`world` 帧），出手的血量变化走 #34 的
 * settle（写这里），死亡后的重生由 tick 驱动。
 *
 * **不持有**的东西（边界别越）：
 * - 怪物的游走 / 追击移动 —— 仍是客户端表现层，坐标不回传；服务端记的「坐标」
 *   是出生点，那是世界里唯一稳定的真相；
 * - 掉落 / 经验 —— 仍在客户端结算（各自有独立 issue）。
 *
 * 刷怪**区域**配置已归服务端（#295 阶段一 / #667 起由管理端地图页绘制）：
 * `map_spawn_areas` 表是唯一来源（出厂值随 `config-sync.sql` 首启灌入，之后在后台改），
 * 进图 worldJoin 只带 mapId，播种完全由服务端按区域随机落点完成 —— 客户端不再上报计划。
 * 区维度（#295 阶段二）：世界按 `zone:mapId` 分域，每个区的新图都独立播种一份；
 * instanceId 带区段（`m<mapId>_z<zone>_<n>`），合并区时由管理端操作统一改写发牌。
 *
 * ===========================================================================
 * tick 的四件事（频率见配置 WORLD_TICK_MS / WORLD_PERSIST_MS）
 * ===========================================================================
 * 1. 代际巡检：`world_meta.epoch` 变了 = 别的进程（或本进程的管理操作）改写了库里的
 *    世界（合并区搬账号、重排 instanceId）—— 把整份内存世界作废（**不落盘**：库里
 *    已是改写后的权威，落盘会把旧 id 写回去）。未落盘的几秒内伤害变化随之丢弃，
 *    这是合并区这类稀有运营操作可接受的代价；#851 起**有人看的分域当场按库重载并广播**，
 *    没人看的保持惰性（下次 join 再加载）。
 * 2. 重生：死亡满 `worldRespawnMs` 的实例复活（满血、回出生点），并通知观看者；
 * 3. 密度对齐（#852）：按「目标数 vs 当前实例数」的差量补 / 裁，每次最多补 2 只 ——
 *    运营改 `max` 或密度系数**下一秒就见效**，不用等分域卸载（#669 的根）；
 * 4. 落盘：把脏实例批量写回 SQLite —— 受击只标脏，真正的写由这里按 `worldPersistMs`
 *    节流完成（不然一次出手就是一次 SQLite 写，与玩家存档防抖叠在一起写放大明显）。
 *    优雅关闭时**全量 flush**，所以节流间隔只影响「进程被硬杀时最多丢几秒状态」。
 *
 * ===========================================================================
 * 生命周期
 * ===========================================================================
 * - 图实例**惰性加载**：第一个观看者进图时从库里恢复（没有就按刷怪区播种创建）；
 * - **一个账号同一时刻只在一张图里**（#821）：换图 = 先退出旧分域再登记新分域，
 *   由 `join` 自己保证，不靠调用方记得先 `leave`；
 * - 玩家全下线不等于立刻卸载：空闲满 `worldMapIdleMs` 才从内存卸载（状态已在库），
 *   卸载期间不跑重生，重新加载时按当前时刻一次性补上到期的；
 * - 优雅关闭：`onApplicationShutdown` 停 tick、全量落盘 —— SQLite 连接在其后由
 *   DatabaseService 关闭（Nest 的关闭顺序保证这一点）。
 */
@Injectable()
export class WorldService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorldService.name);

  /** `zone:mapId` → 实例表（内存里只留「看过」的图，空闲回收） */
  private readonly maps = new Map<string, Map<string, WorldMonster>>();
  /** `zone:mapId` → 正在看这张图的账号（广播与空闲回收的依据） */
  private readonly viewers = new Map<string, Set<string>>();
  /** `zone:mapId` → 变成无人观看的时刻（毫秒）；有人看时删掉 */
  private readonly emptySince = new Map<string, number>();
  /** 每个分域的发牌序号（instanceId 的 `_n` 段；加载时从库里的最大值续起，重启不重号） */
  private readonly instanceSeq = new Map<string, number>();
  /** 上次巡检到的世界代际（变了 = 库被别的进程改写过，见 tick 的代际巡检；bootstrap 时读真实值） */
  private epoch = 0;

  private tickTimer: NodeJS.Timeout | null = null;
  /** 上次落盘的时刻（#849：`worldPersistMs` 是节流间隔，不是「每次 tick 都 flush」） */
  private lastPersistAt = 0;
  /** 已经报过「区域不可用」的区域（#852：补种每秒都跑，不记账会刷屏；按 `mapId#areaId` 记） */
  private readonly warnedAreaKeys = new Set<string>();
  /** 分域 → 裁剪宽限期截止时刻（代际重载后先容忍超编，见 MERGE_TRIM_GRACE_MS） */
  private readonly trimGraceUntil = new Map<string, number>();

  /**
   * 世界变化的广播出口（世界帧发给谁、怎么发，是通道的事 —— 世界层不知道连接存在）。
   * RealtimeService 启动时接线；未接线时变化照常发生，只是没人收到推送（下个 join 会拿到全量）。
   */
  onWorldChanged: ((zoneId: number, mapId: string) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly monsterConfigs: MonsterRepository,
    private readonly spawnAreas: MapSpawnAreaRepository,
    private readonly mapConfigs: MapRepository,
    private readonly zones: ZoneRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.epoch = this.zones.getEpoch();
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
   * 进图登记：惰性加载该区分域的实例（库里恢复或按刷怪区播种），把账号记为观看者，
   * 返回权威快照（`world` 帧的 data）。**重复 join 同一分域是幂等的**（断线重连走这里拿回状态）。
   * 区号由调用方（realtime，从账号行解析）传入 —— 本服务不认识账号。
   *
   * **换图也走这条**（#821）：登记前先把账号从所有分域的观看者里退掉。这是世界层的不变量
   * ——「一个人同一时刻只在一张图里」—— 写在这里就不可能被某个调用方漏掉。漏掉的后果不是
   * 「少退一条记录」：旧图 `viewers` 永不为空，`viewedMaps()` 永远带着它，于是那张图的怪物
   * AI 一直跑、监控一直采样、世界频道还在往一个不在那儿的人身上投递，直到进程重启。
   */
  join(zoneId: number, accountId: string, mapId: string): { mapId: string; monsters: WorldMonsterSnapshot[] } {
    // 幂等：同图重进时这步等于「退掉再登记」，`emptySince` 被下面的 delete 抹掉，不会误回收
    this.leave(accountId);
    const map = this.loadMap(zoneId, mapId);
    const key = worldKey(zoneId, mapId);
    let viewerSet = this.viewers.get(key);
    if (!viewerSet) {
      viewerSet = new Set<string>();
      this.viewers.set(key, viewerSet);
    }
    viewerSet.add(accountId);
    this.emptySince.delete(key);
    return { mapId, monsters: [...map.values()].map(snapshotOf) };
  }

  /**
   * 离图（连接断开 / 被踢下线 / 换图前由 `join` 调用）：观看者从**所有**分域退掉；
   * 退空的分域记下「从此刻起无人观看」，空闲回收按它算。
   *
   * 为什么全表扫而不是维护「账号 → 当前分域」的索引：有观看者的分域本来就只有
   * 在线人数那个量级，扫一遍比多养一份可能与真相错位的内存便宜；顺带还能纠正
   * 历史遗留的错位记录（一个人同时挂在两张图上）。世界状态照常留着（别的观看者还在玩）。
   */
  leave(accountId: string): void {
    for (const [key, viewerSet] of this.viewers) {
      if (!viewerSet.delete(accountId)) continue;
      if (viewerSet.size === 0) {
        this.viewers.delete(key);
        this.emptySince.set(key, Date.now());
      }
    }
  }

  /** 一个分域的权威快照（`world` 帧的 data）；图不在内存（未加载 / 已回收）返回 null */
  snapshot(zoneId: number, mapId: string): { mapId: string; monsters: WorldMonsterSnapshot[] } | null {
    const map = this.maps.get(worldKey(zoneId, mapId));
    if (!map) return null;
    return { mapId, monsters: [...map.values()].map(snapshotOf) };
  }

  /** 正在看一个分域的账号（广播出口按它找人；只读，别改） */
  viewersOf(zoneId: number, mapId: string): Iterable<string> {
    return this.viewers.get(worldKey(zoneId, mapId)) ?? [];
  }

  /**
   * 一个分域里的一只只实例（#824 群体技能的候选池；只读，别改血量）
   *
   * 只给出**出生点**，不筛距离：几何口径属于战斗（半径、命中上限、用不用 AI 运行时坐标）
   * 而不属于世界层 —— 这里一旦长出 `near(x, y, r)`，世界层就要认识「技能半径」这件事。
   * 图不在内存（未加载）返回空数组，调用方按「一个都打不到」处理。
   */
  monstersOf(zoneId: number, mapId: string): WorldMonster[] {
    const map = this.maps.get(worldKey(zoneId, mapId));
    return map ? [...map.values()] : [];
  }

  /**
   * 当前**有人看**的分域列表（#323：怪物 AI tick 只驱动有人看的图 —— 没人看的图
   * 没有广播对象，纯空转）。怪物实例表是权威状态本体，调用方只读、别改血量。
   */
  viewedMaps(): Array<{ zoneId: number; mapId: string; monsters: Map<string, WorldMonster> }> {
    const out: Array<{ zoneId: number; mapId: string; monsters: Map<string, WorldMonster> }> = [];
    for (const [key, map] of this.maps) {
      const viewerSet = this.viewers.get(key);
      if (!viewerSet || viewerSet.size === 0) continue;
      const [zoneId, mapId] = splitWorldKey(key);
      out.push({ zoneId, mapId, monsters: map });
    }
    return out;
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
    for (const map of this.maps.values()) {
      const monster = map.get(instanceId);
      if (monster) return monster;
    }
    return null;
  }

  //#endregion

  //#region tick：代际巡检 + 重生 + 节流落盘 + 空闲回收

  private tick(): void {
    const now = Date.now();
    this.checkEpoch();
    for (const [key, map] of this.maps) {
      const [zoneId, mapId] = splitWorldKey(key);
      let changed = processRespawns(map, now) > 0;
      // 密度对齐只对「有人看」的图做：没人看的图按 docs/27「无人冻结」停常规刷怪，
      // 何况没有观看者时人数系数恒为 1，对齐也没意义
      if ((this.viewers.get(key)?.size ?? 0) > 0) {
        changed = this.reconcileDensity(zoneId, mapId, map, now) > 0 || changed;
      }
      if (changed) {
        // 有重生 / 补种 / 裁剪：标脏由各处自己做，这里只负责让观看者知道
        this.onWorldChanged?.(zoneId, mapId);
      }
    }
    // 落盘按 worldPersistMs 节流（#849）：受击只标脏，真正的写在节流点一次事务写完
    if (now - this.lastPersistAt >= this.persistMs()) {
      this.lastPersistAt = now;
      this.flushDirty();
    }
    if (this.idleMs() > 0) this.reclaimIdle(now);
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
   * 1. **有人看的分域立刻按库重载**（没人看的保持惰性，下次 join 再加载 —— 那是常态）；
   * 2. **重载完广播一次 world 帧**，让观看者手上的实例表换成本次改写的真相。
   *
   * 「按库重载」严格照库：**库里这一区一行都没有就不播**。合并区刚把源区的行改牌搬走，
   * 那名（还挂在旧分域上的）观看者会让 `viewers` 非空 —— 这时候要是走 `loadMap` 的
   * 「空图按刷怪区播种」，就会把刚并走的那个区**原样复活**一份（12 只 z2 怪重新入库），
   * 合并等于白做。播种只属于「第一个观看者进图」，不属于「代际变化」。
   */
  private checkEpoch(): void {
    const current = this.zones.getEpoch();
    if (current === this.epoch) return;
    const previous = this.epoch;
    this.epoch = current;
    const evicted = [...this.maps.keys()];
    this.maps.clear();
    this.instanceSeq.clear();
    let reloaded = 0;
    for (const key of evicted) {
      // 观看者集合保留：他们的连接还活着，leave() 与空闲回收的账还得记
      if ((this.viewers.get(key)?.size ?? 0) === 0) continue;
      const [zoneId, mapId] = splitWorldKey(key);
      // 库里没有这一区的实例 = 它已经被合并/搬走：不重载、更不重新播种（见上面的注释）
      if (this.worldMonsters.listByZoneMap(zoneId, mapId).length === 0) continue;
      this.loadMap(zoneId, mapId);
      this.trimGraceUntil.set(key, Date.now() + MERGE_TRIM_GRACE_MS);
      reloaded += 1;
      this.onWorldChanged?.(zoneId, mapId);
    }
    if (evicted.length > 0) {
      this.logger.warn(
        `世界代际 ${previous} → ${current}，已作废内存中 ${evicted.length} 个分域（未落盘，状态以库为准）；` +
          `其中 ${reloaded} 个有人看，已按库重载并通知观看者`,
      );
    }
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
    for (const [key, since] of this.emptySince) {
      if (now - since < this.idleMs()) continue;
      this.emptySince.delete(key);
      this.maps.delete(key);
      this.instanceSeq.delete(key);
      this.trimGraceUntil.delete(key);
      const [zoneId, mapId] = splitWorldKey(key);
      this.logger.log(`分域 ${key}（地图 ${mapId} / 区 ${zoneId}）无人观看已空闲 ${Math.round(this.idleMs() / 1000)}s，实例已从内存卸载（状态在库里）`);
    }
  }

  //#endregion

  //#region 分域实例的加载与播种

  /**
   * 取一个分域的实例表（内存 → 库 → 播种，三层兜底）
   *
   * 播种只发生在**空分域**上：库里（或本次恢复）已有实例就一概沿用、刷怪区整份忽略。
   * 播种来源 = map_spawn_areas（#295 阶段一，从 Tiled 导入）：每区域按**密度目标**展开
   * 成逐只落点（区域内均匀随机，公式与客户端旧版完全一致），怪 key 对照 monsters 表
   * （直读库而非生成物快照 —— 管理端改了数值/清单即时生效，#258），不认识的跳过并报警。
   * 每个区的空图都独立播种一份 —— 区与区的世界从此互不相干。
   *
   * #852 起「按 max 铺满」改成「按 tick 的同一套目标数播种」：进图的人不该看到一只都没有，
   * 所以首播不节流（一次播到目标）；之后的增删都交给 tick 的差量对齐（每次最多补 2 只）。
   *
   * #850：越界区域不再把怪刷到图外 —— 落点先用「区域 ∩ 地图」裁一刀再取随机点；
   * 整块在图外的区域跳过（这种行只可能来自「改过图几何」的存量库，日志会指出来）。
   */
  private loadMap(zoneId: number, mapId: string): Map<string, WorldMonster> {
    const key = worldKey(zoneId, mapId);
    let map = this.maps.get(key);
    if (map) return map;

    map = new Map<string, WorldMonster>();
    const areas = this.spawnAreas.listByMap(mapId);
    const mapPixel = this.mapPixelOf(mapId);
    const rows = this.worldMonsters.listByZoneMap(zoneId, mapId);
    let maxSeq = 0;
    let backfilled = 0;
    for (const row of rows) {
      const monster = fromRow(row);
      // 老档（#852 之前播种的实例）没有 area_id：按出生点反查归属区回填，
      // 命中不了（区域已被删 / 挪走）就保持 null —— 那几只不计入任何区的配额
      if (monster.areaId === null) {
        const home = findAreaAt(areas, monster.x, monster.y);
        if (home) {
          monster.areaId = home.id;
          monster.dirty = true;
          backfilled += 1;
        }
      }
      map.set(monster.instanceId, monster);
      maxSeq = Math.max(maxSeq, parseSeq(monster.instanceId));
    }
    this.instanceSeq.set(key, maxSeq);

    if (rows.length === 0) {
      let seeded = 0;
      for (const area of areas) {
        if (!this.areaUsable(mapId, area)) continue;
        // 首播按「一个人在看」的人数系数算：join 还没把观看者登记进来（见 join 的顺序）
        const target = spawnTargetOf(area, 1, Date.now());
        for (let index = 0; index < target; index += 1) {
          const point = this.pickSpawnPoint(mapId, area, mapPixel);
          this.createMonster(zoneId, mapId, map, { monsterKey: area.monster_key, areaId: area.id, x: point.x, y: point.y });
          seeded += 1;
        }
      }
      if (seeded > 0) this.logger.log(`地图 ${mapId}（区 ${zoneId}）空图，按 ${areas.length} 个刷怪区播种 ${seeded} 只怪`);
    }

    // 恢复 / 播种之后，把卸载期间到期未处理的重生一次性补上（与 tick 同一条口径）
    processRespawns(map, Date.now());

    this.maps.set(key, map);
    if (backfilled > 0) this.logger.log(`分域 ${key} 有 ${backfilled} 只老实例按出生点回填了归属刷怪区（#852）`);
    if (map.size > rows.length) {
      this.logger.log(`分域 ${key} 已加载：库里恢复 ${rows.length} 只，播种新建 ${map.size - rows.length} 只`);
    }
    return map;
  }

  /** 这张图在库里的像素几何（行没补过几何时返回 null：越界判定跳过，免得把 62 个区全刷成警告） */
  private mapPixelOf(mapId: string): MapPixelRect | null {
    const mapRow = this.mapConfigs.getById(mapId);
    if (!mapRow || mapRow.pixel_width <= 0) return null;
    return { width: mapRow.pixel_width, height: mapRow.pixel_height };
  }

  /** 这一区能不能刷怪：怪物 key 必须在 monsters 表里（不认识的跳过，日志只报一次） */
  private areaUsable(mapId: string, area: MapSpawnAreaRow): boolean {
    if (this.monsterConfigs.findByKey(area.monster_key)) return true;
    const id = `${mapId}#${area.id}`;
    if (!this.warnedAreaKeys.has(id)) {
      this.warnedAreaKeys.add(id);
      this.logger.warn(`地图 ${mapId} 刷怪区「${area.name}」的怪物 key（${area.monster_key}）在 monsters 表里不存在，跳过`);
    }
    return false;
  }

  /**
   * 在区域里取一个**落在图内**的落点（#850：越界区域不再把怪刷到图外）
   *
   * 两步：
   * 1. 优先用「区域 ∩ 地图」取点 —— 半截在外的区域因此保留了图内那半边的分布；
   * 2. 整块在图外 / 零面积区域（老数据里有点状区域）退回「原区域取点再钳进图内」，
   *    宁可让它们贴着图边站，也不让这一区凭空消失（#586 的教训：少刷比刷错更难查）。
   *
   * 越界只在**第一次**打日志：密度对齐每秒都跑，不记账会一秒一条把日志刷满。
   */
  private pickSpawnPoint(mapId: string, area: MapSpawnAreaRow, mapPixel: MapPixelRect | null): { x: number; y: number } {
    const raw = () => pickPointInArea(area.cx, area.cy, area.w, area.h);
    if (!mapPixel) return raw();
    const id = `${mapId}#${area.id}`;
    if (!spawnAreaInBounds(area, mapPixel) && !this.warnedAreaKeys.has(id)) {
      this.warnedAreaKeys.add(id);
      this.logger.warn(
        `地图 ${mapId} 刷怪区「${area.name}」越出地图边界（${spawnAreaOverflowText(spawnAreaOverflow(area, mapPixel))}）—— ` +
          `中心 (${area.cx}, ${area.cy}) ${area.w}×${area.h}，图 ${mapPixel.width}×${mapPixel.height}；` +
          "落点已钳制到图内，但多半是库表还留着旧口径（去地图管理页把这块区域重画一遍）",
      );
    }
    const clipped = clampRectToMap(area, mapPixel);
    return clampPointToMap(clipped ? pickPointInArea(clipped.cx, clipped.cy, clipped.w, clipped.h) : raw(), mapPixel);
  }

  private createMonster(
    zoneId: number,
    mapId: string,
    map: Map<string, WorldMonster>,
    entry: { monsterKey: string; areaId: number | null; x: number; y: number },
  ): void {
    // 直读 monsters 表（#258）：管理端改了 maxHp 即时生效 —— 播种 / 重生都走这里
    const stats = this.monsterConfigs.findByKey(entry.monsterKey);
    if (!stats) {
      this.logger.warn(`怪物 ${entry.monsterKey} 在 monsters 表里不存在（清库了？），跳过播种`);
      return;
    }
    const key = worldKey(zoneId, mapId);
    const seq = (this.instanceSeq.get(key) ?? 0) + 1;
    this.instanceSeq.set(key, seq);
    const instanceId = `m${mapId}_z${zoneId}_${seq}`;
    const monster: WorldMonster = {
      instanceId,
      mapId,
      zoneId,
      monsterKey: entry.monsterKey,
      areaId: entry.areaId,
      x: entry.x,
      y: entry.y,
      hp: Number(stats.max_hp),
      maxHp: Number(stats.max_hp),
      alive: true,
      killedAt: null,
      respawnAt: null,
      lastDamagedAt: null,
      dirty: true,
    };
    map.set(instanceId, monster);
  }

  //#endregion

  //#region 密度对齐（#852 / docs/27 的 E2）

  /**
   * 把一张图的实例数对齐到「现在该有多少」（每秒一次，与 tick 同频）
   *
   * 与「播种」的分工：播种只负责空图首播，之后**所有**增减都由这里按差量处理 ——
   * 于是运营改 `max` / 密度系数不需要重启、不需要等分域卸载，下一秒就见效（#669 的根）。
   *
   * 三条口径（docs/27 §2.2.1）：
   * - **补**：每次最多 2 只（`DENSITY_REFILL_PER_TICK`），避免「改完配置一进图满屏怪」；
   * - **上限**：`max × density_peak` 是硬顶，`min` 是下限；
   * - **裁**：`存活实例 > 目标` 时删最久没被攻击的；5 秒内被打过的跳过（正在被打的不删），
   *   死亡等重生的先删（它们本来就要回来，删了不损玩法，也不会让「总数」虚高）。
   *
   * **统计口径是「实例数」而不是「存活数」**：一只怪死了要等 `respawnAt` 才回来（走重生），
   * 这只实例还占着这一区的名额 —— 按存活数补会立刻补一只新的，等旧的复活就变成
   * 「打一只变两只」。补种只负责「从来没被填满过」的部分。
   */
  private reconcileDensity(zoneId: number, mapId: string, map: Map<string, WorldMonster>, now: number): number {
    const areas = this.spawnAreas.listByMap(mapId);
    if (areas.length === 0) return 0;
    const online = Math.max(1, this.viewers.get(worldKey(zoneId, mapId))?.size ?? 1);
    const mapPixel = this.mapPixelOf(mapId);

    const byArea = new Map<number, WorldMonster[]>();
    for (const monster of map.values()) {
      if (monster.areaId === null) continue;
      const bucket = byArea.get(monster.areaId);
      if (bucket) bucket.push(monster);
      else byArea.set(monster.areaId, [monster]);
    }

    let changes = 0;
    // 区域被删掉的那些实例（area_id 指向已不存在的区）：1 秒内清场，别让「删了区域怪还在」变成常态
    const known = new Set(areas.map((area) => area.id));
    const orphans = [...map.values()].filter(
      (monster) =>
        monster.areaId !== null &&
        !known.has(monster.areaId) &&
        !(monster.alive && monster.lastDamagedAt !== null && now - monster.lastDamagedAt < DENSITY_TRIM_PROTECT_MS),
    );
    if (orphans.length > 0) {
      this.worldMonsters.removeMany(orphans.map((monster) => monster.instanceId));
      for (const monster of orphans) map.delete(monster.instanceId);
      changes += orphans.length;
    }
    for (const area of areas) {
      const bucket = byArea.get(area.id) ?? [];
      const target = spawnTargetOf(area, online, now);
      if (bucket.length === target) continue;
      if (bucket.length < target) {
        if (!this.areaUsable(mapId, area)) continue;
        const add = Math.min(target - bucket.length, DENSITY_REFILL_PER_TICK);
        for (let index = 0; index < add; index += 1) {
          const point = this.pickSpawnPoint(mapId, area, mapPixel);
          this.createMonster(zoneId, mapId, map, { monsterKey: area.monster_key, areaId: area.id, x: point.x, y: point.y });
          changes += 1;
        }
        continue;
      }
      // 宽限期内只补不裁（合并区的搬迁不该被密度当成「配置改小了」）
      if (now < (this.trimGraceUntil.get(worldKey(zoneId, mapId)) ?? 0)) continue;
      changes += this.trimExcess(map, bucket, bucket.length - target, now);
    }
    return changes;
  }

  /** 删掉一区里多出来的实例（死亡中的先删，存活里删最久没被攻击的；返回删了几只） */
  private trimExcess(map: Map<string, WorldMonster>, bucket: WorldMonster[], excess: number, now: number): number {
    const candidates = [...bucket].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? 1 : -1;
      return (a.lastDamagedAt ?? 0) - (b.lastDamagedAt ?? 0);
    });
    const doomed: string[] = [];
    for (const monster of candidates) {
      if (doomed.length >= excess) break;
      // 正在被打的不删：5 秒内被攻击过的活着实例跳过（打一半的怪凭空消失是最难查的一类现象）
      if (monster.alive && monster.lastDamagedAt !== null && now - monster.lastDamagedAt < DENSITY_TRIM_PROTECT_MS) continue;
      doomed.push(monster.instanceId);
    }
    if (doomed.length === 0) return 0;
    this.worldMonsters.removeMany(doomed);
    for (const instanceId of doomed) map.delete(instanceId);
    return doomed.length;
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

//#region 分域内存键（`zone:mapId`；纯函数，e2e / 单测可对照）

/** 区 + 地图 → 内存键 */
export function worldKey(zoneId: number, mapId: string): string {
  return `${zoneId}:${mapId}`;
}

/** 内存键 → 区 + 地图（zoneId / mapId 自身都不含冒号：区是数字，地图 id 是数字或 slug） */
function splitWorldKey(key: string): [number, string] {
  const at = key.indexOf(":");
  return [Number(key.slice(0, at)), key.slice(at + 1)];
}

//#endregion

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
    zone_id: monster.zoneId,
    monster_key: monster.monsterKey,
    area_id: monster.areaId,
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
    zoneId: row.zone_id,
    monsterKey: row.monster_key,
    areaId: row.area_id ?? null,
    x: row.x,
    y: row.y,
    hp: row.hp,
    maxHp: row.max_hp,
    alive: row.alive === 1,
    killedAt: row.killed_at,
    respawnAt: row.respawn_at,
    lastDamagedAt: null,
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

/**
 * 刷怪区内随机取一点（世界坐标）。
 * 与客户端旧版 MonsterAreaSpawner 完全同一公式：矩形内均匀取值（地图节点未旋转缩放）。
 * rand 可注入 —— e2e 用固定序列断言落点确定性与边界。
 */
export function pickPointInArea(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rand: () => number = Math.random,
): { x: number; y: number } {
  return { x: cx + (rand() - 0.5) * w, y: cy + (rand() - 0.5) * h };
}

/** 从 instanceId 解析发牌序号（`m1_z1_3` → 3；解析不出按 0，重启后续号从它之上开始） */
function parseSeq(instanceId: string): number {
  const at = instanceId.lastIndexOf("_");
  if (at < 0) return 0;
  const seq = Number(instanceId.slice(at + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

//#endregion
