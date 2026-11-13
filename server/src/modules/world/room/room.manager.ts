import { Injectable, Logger } from "@nestjs/common";
import { MapRuleRepository, mapRulesOf } from "../../../database/repositories/map-rule.repository";
import { MapRepository } from "../../../database/repositories/map.repository";
import { MapSpawnAreaRepository } from "../../../database/repositories/map-spawn-area.repository";
import { MonsterRepository } from "../../../database/repositories/monster.repository";
import { WorldMonsterRepository } from "../../../database/repositories/world-monster.repository";
import { MapSpawnAreaRow } from "../../../database/rows";
import {
  MapPixelRect,
  spawnAreaInBounds,
  spawnAreaOverflow,
  spawnAreaOverflowText,
} from "../../../common/utils/spawn-area-bounds.util";
import { clampPointToMap, clampRectToMap, findAreaAt, spawnTargetOf } from "../../../common/utils/spawn-density.util";
import { PUBLIC_SLOT, instanceIdOf, parseInstanceSeq, roomKey, splitRoomKey } from "../../../common/utils/room-key.util";
import { Room } from "./room";
import { WorldMonster, fromWorldMonsterRow, processRespawns } from "../world-monster";

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
 * 房间管理（#809 / docs/20 §5.1）：房间的建 / 查 / 销毁 / 播种 / 卸载，全在这一处
 *
 * ===========================================================================
 * 与 WorldService 的分工
 * ===========================================================================
 * - **RoomManager**：管「有哪些房间、每间房里有哪些实例」。建房子（从库恢复或按刷怪区
 *   播种）、拆房子（空闲卸载 / 重载）、发牌（instanceId 序号）、容量，都是它的事。
 * - **WorldService**：管「时间」。tick 里的重生、密度对齐、节流落盘、代际作废 —— 那些
 *   与「有几间房」无关，只是遍历房间做事。
 *
 * 这条边界是有意画的：改造前 `WorldService` 同时持有 800 行里的「状态容器 + 时间循环」，
 * 结果每次「加载 / 卸载 / 作废 / 重载」都要在四个地方同步增删同一批字段，漏一个就是
 * 脏状态（内存里有这间房、序号却从 1 重来）。
 *
 * ===========================================================================
 * 播种口径（从 WorldService 原样搬过来，别在这里改玩法）
 * ===========================================================================
 * 播种只发生在**空房间**上：库里（或本次恢复）已有实例就一概沿用、刷怪区整份忽略。
 * 播种来源 = `map_spawn_areas`：每区域按**密度目标**展开成逐只落点（区域内均匀随机，
 * 公式与客户端旧版完全一致），怪 key 对照 `monsters` 表（直读库而非生成物快照 ——
 * 管理端改了数值 / 清单即时生效），不认识的跳过并报警（#852 的「只报一次」）。
 * 越界区域不再把怪刷到图外：落点先用「区域 ∩ 地图」裁一刀再取随机点（#850）。
 */
@Injectable()
export class RoomManager {
  private readonly logger = new Logger(RoomManager.name);

  /** `roomId` → 房间（内存里只留「看过」的房，空闲回收） */
  private readonly rooms = new Map<string, Room>();
  /**
   * 已经报过「区域不可用 / 越界」的区域（#852 / #850：补种每秒都跑，不记账会刷屏；按 `mapId#areaId` 记）
   *
   * 放在管理器而不是房间上：区域配置是**图级**的，同一张图的两条线会各自遇到同一个坏区域，
   * 记在房间上等于每条线各报一次。
   */
  private readonly warnedAreaKeys = new Set<string>();

  constructor(
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly monsterConfigs: MonsterRepository,
    private readonly spawnAreas: MapSpawnAreaRepository,
    private readonly mapConfigs: MapRepository,
    private readonly mapRules: MapRuleRepository,
  ) {}

  //#region 查询

  /** 取一间房（未加载返回 null；不会触发加载 —— 加载只该由「有人进图」触发） */
  get(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** 全部已加载的房间（tick 遍历用；只读，别在里面删房间） */
  list(): Room[] {
    return [...this.rooms.values()];
  }

  /** 一张图在这个区里的所有线（分线与副本都算；管理端监控按它列线） */
  listByMap(zoneId: number, mapId: string): Room[] {
    return [...this.rooms.values()].filter((room) => room.zoneId === zoneId && room.mapId === mapId);
  }

  /** 有人看的房间（怪物 AI tick / 监控采样的输入；#323 / #887） */
  viewedRooms(): Room[] {
    return [...this.rooms.values()].filter((room) => room.viewers.size > 0);
  }

  /** 所有房间里的所有实例（密度对齐 / 落盘用的扁平视图；只读） */
  allMonsters(): WorldMonster[] {
    return [...this.rooms.values()].flatMap((room) => [...room.monsters.values()]);
  }

  /** 一间房里的一只实例（结算校验用；**不跨房间找** —— instanceId 全局唯一，跨房间找等于掩盖错 id） */
  monsterOf(roomId: string, instanceId: string): WorldMonster | null {
    return this.rooms.get(roomId)?.monsters.get(instanceId) ?? null;
  }

  //#endregion

  //#region 观看者

  /**
   * 登记一个观看者（进图 / 重连都走这里）
   *
   * **换图时也要调用 `leave(accountId)` 先把人从旧房退掉** —— 世界层的 `join` 负责
   * 这个顺序（一个人同一时刻只在一张图里，见 docs/20 §5.6）；管理器只做机械登记，
   * 不猜调用方的意图。
   */
  addViewer(room: Room, accountId: string): void {
    room.viewers.add(accountId);
    room.emptySince = null;
  }

  /**
   * 把一个账号从**所有**房间的观看者里退掉，返回因此变空的房间
   *
   * 为什么全表扫而不是维护「账号 → 房间」索引：有观看者的房间本来就只有在线人数那个量级，
   * 扫一遍比多养一份可能与真相错位的索引便宜；顺带还能纠正历史遗留的错位记录
   * （一个人同时挂在两张图上）。
   */
  leave(accountId: string, now: number): Room[] {
    const emptied: Room[] = [];
    for (const room of this.rooms.values()) {
      if (!room.viewers.delete(accountId)) continue;
      if (room.viewers.size === 0) {
        room.emptySince = now;
        emptied.push(room);
      }
    }
    return emptied;
  }

  //#endregion

  //#region 加载 / 播种 / 销毁

  /**
   * 取一间房，没有就从库里恢复或按刷怪区播种（惰性加载：第一个观看者进图时才建）
   *
   * 三层兜底顺序与改造前一致：**内存 → 库 → 播种**。播种只发生在「库里这一区一行都没有」
   * 的情况 —— 库里已有实例就一概沿用（否则每次重启都会在原有怪身上再撒一份）。
   */
  ensure(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const { zoneId, mapId, slot } = splitRoomKey(roomId);
    const room: Room = {
      roomId,
      zoneId,
      mapId,
      slot,
      monsters: new Map<string, WorldMonster>(),
      viewers: new Set<string>(),
      emptySince: null,
      seq: 0,
      trimGraceUntil: 0,
      capacity: this.capacityOf(mapId),
    };

    const areas = this.spawnAreas.listByMap(mapId);
    const mapPixel = this.mapPixelOf(mapId);
    const rows = this.worldMonsters.listByRoom(zoneId, mapId, slot);
    let maxSeq = 0;
    let backfilled = 0;
    for (const row of rows) {
      const monster = fromWorldMonsterRow(row);
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
      room.monsters.set(monster.instanceId, monster);
      maxSeq = Math.max(maxSeq, parseInstanceSeq(monster.instanceId));
    }
    room.seq = maxSeq;

    if (rows.length === 0) this.seed(room, areas, mapPixel, 1);
    // 恢复 / 播种之后，把卸载期间到期未处理的重生一次性补上（与 tick 同一条口径）：
    // 房间空闲卸载期间不跑 tick，回来时那些「其实早该刷了」的怪要当场站起来
    processRespawns(room.monsters, Date.now());
    this.rooms.set(roomId, room);

    if (backfilled > 0) {
      this.logger.log(`房间 ${roomId} 有 ${backfilled} 只老实例按出生点回填了归属刷怪区（#852）`);
    }
    if (room.monsters.size > rows.length) {
      this.logger.log(`房间 ${roomId} 已加载：库里恢复 ${rows.length} 只，播种新建 ${room.monsters.size - rows.length} 只`);
    }
    return room;
  }

  /**
   * 按刷怪区把一间空房铺到「目标数」（首播不节流；之后的增删交给 tick 的差量对齐）
   *
   * `online` 是人数系数：首播按「一个人在看」算（调用它的时候观看者还没登记进来）。
   */
  private seed(room: Room, areas: MapSpawnAreaRow[], mapPixel: MapPixelRect | null, online: number): number {
    let seeded = 0;
    const now = Date.now();
    for (const area of areas) {
      if (!this.areaUsable(room.mapId, area)) continue;
      const target = spawnTargetOf(area, online, now);
      for (let index = 0; index < target; index += 1) {
        const point = this.pickSpawnPoint(room.mapId, area, mapPixel);
        this.createMonster(room, { monsterKey: area.monster_key, areaId: area.id, x: point.x, y: point.y });
        seeded += 1;
      }
    }
    if (seeded > 0) {
      this.logger.log(`房间 ${room.roomId} 空房播种：按 ${areas.length} 个刷怪区铺了 ${seeded} 只怪`);
    }
    return seeded;
  }

  /**
   * 单图热重载的执行体（#809）：删库行 → 清内存 → 按当前刷怪区重播 → 序号归零
   *
   * **整份重播而不是差量对齐**：运营改完区域要立刻看到「配置里的样子」。密度对齐虽然
   * 也会收敛，但它是每秒最多补 2 只 —— 一个有 30 只的图要 15 秒才对齐完，而这段时间里
   * 旧区域的怪还在（「我删了这块区域，怪怎么还在打人」）。
   *
   * 序号从头开始（`removed` 之后库是空的）：不重置的话 id 会一直往上飘，运维对比日志时
   * 「这张图的第 200 号怪」永远对不上重载后的样子。
   */
  reload(room: Room): { removed: number; seeded: number } {
    const removed = this.worldMonsters.removeByRoom(room.zoneId, room.mapId, room.slot);
    room.monsters.clear();
    room.seq = 0;
    room.trimGraceUntil = 0;
    const areas = this.spawnAreas.listByMap(room.mapId);
    const seeded = this.seed(room, areas, this.mapPixelOf(room.mapId), Math.max(1, room.viewers.size));
    return { removed, seeded };
  }

  /** 从内存摘掉一间房（状态已在库里；调用方负责先落盘脏行） */
  destroy(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** 整份作废（世界代际变化时用；观看者集合保留 —— 他们的连接还活着，账还得记） */
  evictAll(): string[] {
    const evicted = [...this.rooms.keys()];
    this.rooms.clear();
    return evicted;
  }

  /**
   * 空闲回收（`idleMs <= 0` 表示不回收，与改造前 `worldMapIdleMs` 的语义一致）
   * @returns 被卸载的房间
   */
  reclaimIdle(now: number, idleMs: number): Room[] {
    if (idleMs <= 0) return [];
    const reclaimed: Room[] = [];
    for (const [roomId, room] of this.rooms) {
      if (room.emptySince === null || now - room.emptySince < idleMs) continue;
      this.rooms.delete(roomId);
      reclaimed.push(room);
    }
    return reclaimed;
  }

  //#endregion

  //#region 密度对齐（#852 / docs/27 的 E2）

  /**
   * 把一间房的实例数对齐到「现在该有多少」（每秒一次，与 tick 同频）
   *
   * 与「播种」的分工：播种只负责空房首播，之后**所有**增减都由这里按差量处理 ——
   * 于是运营改 `max` / 密度系数不需要重启、不需要等房间卸载，下一秒就见效（#669 的根）。
   *
   * 三条口径（docs/27 §2.2.1）：
   * - **补**：每次最多 `refillPerTick` 只，避免「改完配置一进图满屏怪」；
   * - **上限**：`max × density_peak` 是硬顶，`min` 是下限（都在 `spawnTargetOf` 里）；
   * - **裁**：`存活实例 > 目标` 时删最久没被攻击的；5 秒内被打过的跳过（正在被打的不删），
   *   死亡等重生的先删（它们本来就要回来，删了不损玩法，也不会让「总数」虚高）。
   *
   * **统计口径是「实例数」而不是「存活数」**：一只怪死了要等 `respawnAt` 才回来（走重生），
   * 这只实例还占着这一区的名额 —— 按存活数补会立刻补一只新的，等旧的复活就变成
   * 「打一只变两只」。补种只负责「从来没被填满过」的部分。
   *
   * @returns 这一轮增删了几只（调用方据此决定要不要广播）
   */
  alignDensity(room: Room, now: number, refillPerTick: number): number {
    const areas = this.spawnAreas.listByMap(room.mapId);
    if (areas.length === 0) return 0;
    const online = Math.max(1, room.viewers.size);
    const mapPixel = this.mapPixelOf(room.mapId);

    const byArea = new Map<number, WorldMonster[]>();
    for (const monster of room.monsters.values()) {
      if (monster.areaId === null) continue;
      const bucket = byArea.get(monster.areaId);
      if (bucket) bucket.push(monster);
      else byArea.set(monster.areaId, [monster]);
    }

    let changes = 0;
    // 区域被删掉的那些实例（area_id 指向已不存在的区）：1 秒内清场，别让「删了区域怪还在」变成常态
    const known = new Set(areas.map((area) => area.id));
    const orphans = [...room.monsters.values()].filter(
      (monster) =>
        monster.areaId !== null &&
        !known.has(monster.areaId) &&
        !(monster.alive && monster.lastDamagedAt !== null && now - monster.lastDamagedAt < DENSITY_TRIM_PROTECT_MS),
    );
    if (orphans.length > 0) {
      this.worldMonsters.removeMany(orphans.map((monster) => monster.instanceId));
      for (const monster of orphans) room.monsters.delete(monster.instanceId);
      changes += orphans.length;
    }
    for (const area of areas) {
      const bucket = byArea.get(area.id) ?? [];
      const target = spawnTargetOf(area, online, now);
      if (bucket.length === target) continue;
      if (bucket.length < target) {
        if (!this.areaUsable(room.mapId, area)) continue;
        const add = Math.min(target - bucket.length, refillPerTick);
        for (let index = 0; index < add; index += 1) {
          const point = this.pickSpawnPoint(room.mapId, area, mapPixel);
          this.createMonster(room, { monsterKey: area.monster_key, areaId: area.id, x: point.x, y: point.y });
          changes += 1;
        }
        continue;
      }
      // 宽限期内只补不裁（合并区的搬迁不该被密度当成「配置改小了」）
      if (now < room.trimGraceUntil) continue;
      changes += this.trimExcess(room, bucket, bucket.length - target, now);
    }
    return changes;
  }

  /** 删掉一区里多出来的实例（死亡中的先删，存活里删最久没被攻击的；返回删了几只） */
  private trimExcess(room: Room, bucket: WorldMonster[], excess: number, now: number): number {
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
    for (const instanceId of doomed) room.monsters.delete(instanceId);
    return doomed.length;
  }

  //#endregion

  //#region 实例创建与落点
  /**
   * 在一间房里新建一只实例（发牌序号在房间上，房间之间互不干扰）
   *
   * 直读 monsters 表（#258）：管理端改了 maxHp 即时生效 —— 播种 / 重播 / 密度补种都走这里。
   */
  createMonster(
    room: Room,
    entry: { monsterKey: string; areaId: number | null; x: number; y: number },
  ): WorldMonster | null {
    const stats = this.monsterConfigs.findByKey(entry.monsterKey);
    if (!stats) {
      this.logger.warn(`怪物 ${entry.monsterKey} 在 monsters 表里不存在（清库了？），跳过播种`);
      return null;
    }
    const seq = room.seq + 1;
    room.seq = seq;
    const monster: WorldMonster = {
      instanceId: instanceIdOf(room.mapId, room.zoneId, room.slot, seq),
      mapId: room.mapId,
      zoneId: room.zoneId,
      slot: room.slot,
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
    room.monsters.set(monster.instanceId, monster);
    return monster;
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

  /** 一间房的容量（`map_rules.max_players_per_room`；一行不存在 = 出厂 30） */
  private capacityOf(mapId: string): number {
    const rules = mapRulesOf(this.mapRules.find(mapId));
    return Math.max(0, Math.trunc(rules.maxPlayersPerRoom));
  }

  //#endregion
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

/** 公共线房间的键（调用方多半只需要这一句，别到处写 `roomKey(z, m, "0")`） */
export function publicRoomOf(zoneId: number, mapId: string): string {
  return roomKey(zoneId, mapId, PUBLIC_SLOT);
}
