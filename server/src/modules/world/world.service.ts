import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MapSpawnAreaRepository } from "../../database/repositories/map-spawn-area.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { WorldMonsterRow } from "../../database/rows";
import { SPAWN_AREAS } from "./spawn-areas.generated";

/** 服务端持有的一只怪物实例（权威状态；内存形态，落盘见 WorldMonsterRow） */
export interface WorldMonster {
  /** 实例 id（服务端发牌，`m<mapId>_z<zone>_<n>`，跨重启稳定不重号） */
  instanceId: string;
  mapId: string;
  /** 归属区（#295 阶段二：同一张图各区各有一份独立世界） */
  zoneId: number;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 monsters 表） */
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
 * **一个区的一张图**一份怪物实例表（同区跨账号**共享**，跨区完全隔离）：血量 / 存活 /
 * 出生点。权威状态只此一份，客户端拿到的是快照（`world` 帧），出手的血量变化走 #34 的
 * settle（写这里），死亡后的重生由 tick 驱动。
 *
 * **不持有**的东西（边界别越）：
 * - 怪物的游走 / 追击移动 —— 仍是客户端表现层，坐标不回传；服务端记的「坐标」
 *   是出生点，那是世界里唯一稳定的真相；
 * - 掉落 / 经验 —— 仍在客户端结算（各自有独立 issue）。
 *
 * 刷怪**区域**配置已归服务端（#295 阶段一）：`map_spawn_areas` 表从 Tiled 导入一次
 * （tools/import-spawn-areas.cjs 生成 SPAWN_AREAS 快照，启动时空表自动 seed），
 * 进图 worldJoin 只带 mapId，播种完全由服务端按区域随机落点完成 —— 客户端不再上报计划。
 * 区维度（#295 阶段二）：世界按 `zone:mapId` 分域，每个区的新图都独立播种一份；
 * instanceId 带区段（`m<mapId>_z<zone>_<n>`），合并区时由管理端操作统一改写发牌。
 *
 * ===========================================================================
 * tick 的三件事（频率见配置 WORLD_TICK_MS / WORLD_PERSIST_MS）
 * ===========================================================================
 * 1. 代际巡检：`world_meta.epoch` 变了 = 别的进程（或本进程的管理操作）改写了库里的
 *    世界（合并区搬账号、重排 instanceId）—— 把整份内存世界作废（**不落盘**：库里
 *    已是改写后的权威，落盘会把旧 id 写回去）。未落盘的几秒内伤害变化随之丢弃，
 *    这是合并区这类稀有运营操作可接受的代价；下次 join 按库重载。
 * 2. 重生：死亡满 `worldRespawnMs` 的实例复活（满血、回出生点），并通知观看者；
 * 3. 落盘：把脏实例批量写回 SQLite —— 受击只标脏，真正的写由这里节流完成
 *    （不然一次出手就是一次 SQLite 写，与玩家存档防抖叠在一起写放大明显）。
 *    优雅关闭时**全量 flush**，所以节流间隔只影响「进程被硬杀时最多丢几秒状态」。
 *
 * ===========================================================================
 * 生命周期
 * ===========================================================================
 * - 图实例**惰性加载**：第一个观看者进图时从库里恢复（没有就按刷怪区播种创建）；
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
    private readonly zones: ZoneRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.seedSpawnAreas();
    this.epoch = this.zones.getEpoch();
    const total = this.worldMonsters.countAll();
    this.tickTimer = setInterval(() => this.tick(), this.tickMs()).unref();
    this.logger.log(`世界权威已启动（tick ${this.tickMs()}ms / 落盘节流 ${this.persistMs()}ms / 重生 ${this.respawnMs()}ms，库里已有 ${total} 只怪）`);
  }

  /**
   * 刷怪区 seed（#295）：表空时从 SPAWN_AREAS 快照灌入（INSERT OR IGNORE 幂等）。
   * 快照由导入工具从 Tiled 生成并提交进仓库 —— 部署机没有客户端素材也能 seed。
   * 非空表不重灌：导入工具 --db 才是整份替换的入口。
   */
  private seedSpawnAreas(): void {
    if (this.spawnAreas.countAll() > 0) return;
    let count = 0;
    for (const [mapId, areas] of Object.entries(SPAWN_AREAS)) {
      for (const area of areas) {
        this.spawnAreas.seedRow({
          map_id: mapId,
          name: area.name,
          monster_key: area.monsterKey,
          min: area.min,
          max: area.max,
          cx: area.cx,
          cy: area.cy,
          w: area.w,
          h: area.h,
          updated_at: 0,
        });
        count += 1;
      }
    }
    this.logger.log(`map_spawn_areas 空表，已从快照 seed ${count} 个刷怪区`);
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
   */
  join(zoneId: number, accountId: string, mapId: string): { mapId: string; monsters: WorldMonsterSnapshot[] } {
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

  /** 离图（连接断开时由通道调用）：观看者退掉；世界状态照常留着（别的观看者还在玩） */
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
      if (processRespawns(map, now)) {
        // 有重生：标脏由 processRespawns 做，这里只负责让观看者知道
        const [zoneId, mapId] = splitWorldKey(key);
        this.onWorldChanged?.(zoneId, mapId);
      }
    }
    this.flushDirty();
    if (this.idleMs() > 0) this.reclaimIdle(now);
  }

  /**
   * 代际巡检（#295 阶段二：跨进程的世界配置失效信号）
   *
   * 合并区在 API 进程里改写库（搬账号 + 重排 instanceId + epoch+1），而世界内存
   * 两个进程各有一份 —— 本进程发现 epoch 变了就把整份内存作废。**不落盘**：
   * 库里已经是改写后的权威状态，把旧 id 的脏行写回去等于把合并前的问题复活。
   */
  private checkEpoch(): void {
    const current = this.zones.getEpoch();
    if (current === this.epoch) return;
    const evicted = this.maps.size;
    this.epoch = current;
    this.maps.clear();
    this.instanceSeq.clear();
    // 观看者集合保留：他们的连接还活着，leave() 与空闲回收的账还得记；
    // 只是当前分域已作废 —— 客户端下一次 worldJoin 会按账号的区重载全量。
    if (evicted > 0) this.logger.warn(`世界代际 ${this.epoch - 1} → ${current}，已作废内存中 ${evicted} 个分域（未落盘，状态以库为准）`);
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
   * 不做「逐只补缺」—— 死亡未重生的实例还在库里占位，按区域补会把它顶掉。
   * 播种来源 = map_spawn_areas（#295 阶段一，从 Tiled 导入）：每区域按 max 展开
   * 成逐只落点（区域内均匀随机，公式与客户端旧版完全一致），怪 key 对照 monsters 表
   * （直读库而非生成物快照 —— 管理端改了数值/清单即时生效，#258），不认识的跳过并报警。
   * 每个区的空图都独立播种一份 —— 区与区的世界从此互不相干。
   */
  private loadMap(zoneId: number, mapId: string): Map<string, WorldMonster> {
    const key = worldKey(zoneId, mapId);
    let map = this.maps.get(key);
    if (map) return map;

    map = new Map<string, WorldMonster>();
    const rows = this.worldMonsters.listByZoneMap(zoneId, mapId);
    let maxSeq = 0;
    for (const row of rows) {
      const monster = fromRow(row);
      map.set(monster.instanceId, monster);
      maxSeq = Math.max(maxSeq, parseSeq(monster.instanceId));
    }
    this.instanceSeq.set(key, maxSeq);

    if (rows.length === 0) {
      const areas = this.spawnAreas.listByMap(mapId);
      let seeded = 0;
      for (const area of areas) {
        if (!this.monsterConfigs.findByKey(area.monster_key)) {
          this.logger.warn(`地图 ${mapId} 刷怪区「${area.name}」的怪物 key（${area.monster_key}）在 monsters 表里不存在，跳过`);
          continue;
        }
        for (let index = 0; index < area.max; index += 1) {
          const point = pickPointInArea(area.cx, area.cy, area.w, area.h);
          this.createMonster(zoneId, mapId, map, { monsterKey: area.monster_key, x: point.x, y: point.y });
          seeded += 1;
        }
      }
      if (seeded > 0) this.logger.log(`地图 ${mapId}（区 ${zoneId}）空图，按 ${areas.length} 个刷怪区播种 ${seeded} 只怪`);
    }

    // 恢复 / 播种之后，把卸载期间到期未处理的重生一次性补上（与 tick 同一条口径）
    processRespawns(map, Date.now());

    this.maps.set(key, map);
    if (map.size > rows.length) {
      this.logger.log(`分域 ${key} 已加载：库里恢复 ${rows.length} 只，播种新建 ${map.size - rows.length} 只`);
    }
    return map;
  }

  private createMonster(zoneId: number, mapId: string, map: Map<string, WorldMonster>, entry: { monsterKey: string; x: number; y: number }): void {
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
      x: entry.x,
      y: entry.y,
      hp: Number(stats.max_hp),
      maxHp: Number(stats.max_hp),
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
