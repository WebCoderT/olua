import { Injectable } from "@nestjs/common";
import {
  AOI_LEAVE_DELAY_MS,
  AOI_MAX_ENTITIES,
  cellCenterOf,
  cellKeyOf,
  neighborCellKeys,
  playerEntityOf,
} from "./aoi-math";

/**
 * 一间房的格子索引
 *
 * 怪与玩家**共用一套**（`m:<instanceId>` / `p:<accountId>`）：两套索引就得在两处处理
 * 「同一只怪既在怪表又在玩家表」这类一致性，而 AOI 的问题从来不是「怪和玩家有什么区别」，
 * 而是「这个位置有什么」。前缀只是为了 id 不撞（实例 id 与账号 id 都是字符串）。
 */
interface RoomAoi {
  /** cellKey → 实体集合 */
  cells: Map<string, Set<string>>;
  /** 实体 → cellKey（移动迁移时反查） */
  cellOf: Map<string, string>;
  /** 实体 → 最近一次同步的坐标（上限裁剪按距离排序用；同格内移动也更新） */
  pos: Map<string, { x: number; y: number }>;
}

/** 一个观看者的 AOI 状态（一个账号同一时刻只在一间房，所以按账号存） */
interface ViewAoi {
  roomId: string;
  /** 最近一拍所在格（`null` = 服务端还不知道他在哪 —— 刚进图 / 换图途中，此时不裁） */
  cell: string | null;
  /** 「客户端场上已经有什么」—— 下一拍 diff 的基线 */
  seen: Set<string>;
  /** 待确认的离开：实体 → 截止时刻（期内又看见就取消，见 AOI_LEAVE_DELAY_MS） */
  leaving: Map<string, number>;
}

/**
 * AOI 索引与视野差量（#810）
 *
 * ===========================================================================
 * 它管什么
 * ===========================================================================
 * 1. **格子索引**：谁在哪一格（`cells` / `cellOf`），移动时迁移；
 * 2. **可见集合**：某个格子里的观看者能看到哪些实体（3×3 并集 + 200 上限），按格缓存；
 * 3. **进出差量**：每个观看者「这一拍新看见谁 / 谁离开视野（延迟合并）」。
 *
 * 它**不管**发帧：帧长什么样、发给谁、怎么序列化是 `RealtimeService` 的事 —— 与
 * `WorldService` 不参与裁剪同一条边界（索引不认识 WebSocket）。
 *
 * ===========================================================================
 * 为什么可见集合按「格」缓存，而不是按「人」算
 * ===========================================================================
 * 同一格的人 3×3 邻域完全相同，可见集合就完全相同 —— 于是同一格的观看者能**共用一份
 * 序列化后的 JSON**（#768 的 stringify 缓存是「一帧一次」，这里进一步降到「一格一次」）。
 * 上限裁剪也按**格心**排序而不是按玩家坐标，正是为了保住这条性质：按人算的话每人
 * 集合都不同，缓存与共用都不成立。
 */
@Injectable()
export class AoiService {
  private readonly rooms = new Map<string, RoomAoi>();
  private readonly viewers = new Map<string, ViewAoi>();

  /**
   * 索引版本号
   *
   * 任何增删迁移都 +1。可见集合的缓存靠它失效 —— 每拍全清缓存也行，但那会让「这一拍
   * 里同一格算了 N 次」的情况重新变成 N 次并集运算；版本号让缓存只管「索引变了没」，
   * 与节拍无关。
   */
  private generation = 0;

  /** 可见集合缓存（`房间|格` → 集合 + 算出它时的版本） */
  private readonly visibleCache = new Map<string, { gen: number; ids: Set<string> }>();

  //#region 索引

  /**
   * 把实体放进它该在的格（新实体 / 移动都走这里）
   *
   * 跨格才动 `cells`（同格内每拍都改 Set 就是白做），坐标则每次都更新 —— 上限裁剪要
   * 按「离格心多远」排序，站桩不动的怪与刚走过来的怪必须能比出远近。
   */
  index(roomId: string, entityId: string, x: number, y: number): void {
    const room = this.roomOf(roomId);
    const cell = cellKeyOf(x, y);
    const previous = room.cellOf.get(entityId);
    if (previous !== cell) {
      if (previous !== undefined) {
        const old = room.cells.get(previous);
        old?.delete(entityId);
        // 空格子不留空 Set：房间反复进出时 Map 会无限长（每个到过的格都留一个空壳）
        if (old && old.size === 0) room.cells.delete(previous);
      }
      const bucket = room.cells.get(cell) ?? new Set<string>();
      bucket.add(entityId);
      room.cells.set(cell, bucket);
      room.cellOf.set(entityId, cell);
      this.generation += 1;
    }
    const known = room.pos.get(entityId);
    if (known) {
      known.x = x;
      known.y = y;
    } else {
      room.pos.set(entityId, { x, y });
    }
  }

  /** 移出索引（实体消失：怪被重载换了一批 / 玩家离开房间） */
  remove(roomId: string, entityId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const cell = room.cellOf.get(entityId);
    if (cell === undefined) return;
    const bucket = room.cells.get(cell);
    bucket?.delete(entityId);
    if (bucket && bucket.size === 0) room.cells.delete(cell);
    room.cellOf.delete(entityId);
    room.pos.delete(entityId);
    this.generation += 1;
  }

  /**
   * 按前缀清理：只保留 `keep` 里有的实体
   *
   * 索引是「按拍被动同步」的，实体从权威列表里消失（怪被重载换 id、玩家断线）不会自己
   * 从格子里掉出来 —— 不清理的话，它会一直作为「可见实体」被算进别人的视野里，
   * 表现为一个永远不消失的幽灵（客户端还拿不到它的数据，因为权威列表里已经没有了）。
   */
  retain(roomId: string, prefix: string, keep: ReadonlySet<string>): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const entityId of [...room.cellOf.keys()]) {
      if (!entityId.startsWith(prefix)) continue;
      if (!keep.has(entityId)) this.remove(roomId, entityId);
    }
  }

  /** 整间房作废（房间卸载 / 世界代际变化后按库重载） */
  resetRoom(roomId: string): void {
    this.rooms.delete(roomId);
    for (const key of [...this.visibleCache.keys()]) {
      if (key.startsWith(`${roomId}|`)) this.visibleCache.delete(key);
    }
    for (const [accountId, viewer] of this.viewers) {
      if (viewer.roomId === roomId) this.viewers.delete(accountId);
    }
    this.generation += 1;
  }

  /**
   * 只保留这些房间的索引与观看者状态
   *
   * 房间的空闲回收在世界层（`worldMapIdleMs`），卸载时不会通知本服务 —— 每拍拿
   * `viewedRooms()` 的房号列表对一遍是最省心的收口方式：不在列表里的房，索引与观看者
   * 状态一并丢掉，下次有人进图会重新建（世界层会把怪全量给回来）。
   */
  pruneRooms(activeRoomIds: ReadonlySet<string>): void {
    for (const roomId of [...this.rooms.keys()]) {
      if (!activeRoomIds.has(roomId)) this.resetRoom(roomId);
    }
    for (const [accountId, viewer] of this.viewers) {
      if (!activeRoomIds.has(viewer.roomId)) this.viewers.delete(accountId);
    }
  }

  //#endregion

  //#region 可见集合

  /**
   * 某个格子里的观看者能看到哪些实体（3×3 并集，超上限只留离格心最近的 200 个）
   *
   * 返回的 Set **只读**：调用方不要改它（同一格的多个观看者共用这一份）。
   */
  visibleInCell(roomId: string, cell: string): Set<string> {
    const key = `${roomId}|${cell}`;
    const cached = this.visibleCache.get(key);
    if (cached && cached.gen === this.generation) return cached.ids;

    const room = this.rooms.get(roomId);
    const ids = new Set<string>();
    if (room) {
      const candidates: string[] = [];
      for (const neighbor of neighborCellKeys(cell)) {
        const bucket = room.cells.get(neighbor);
        if (!bucket) continue;
        for (const entityId of bucket) candidates.push(entityId);
      }
      if (candidates.length <= AOI_MAX_ENTITIES) {
        for (const entityId of candidates) ids.add(entityId);
      } else {
        const center = cellCenterOf(cell);
        const distance = (entityId: string): number => {
          const at = room.pos.get(entityId);
          if (!at) return Number.POSITIVE_INFINITY;
          return (at.x - center.x) ** 2 + (at.y - center.y) ** 2;
        };
        candidates.sort((left, right) => distance(left) - distance(right));
        for (let i = 0; i < AOI_MAX_ENTITIES; i += 1) ids.add(candidates[i]);
      }
    }
    this.visibleCache.set(key, { gen: this.generation, ids });
    return ids;
  }

  //#endregion

  //#region 观看者状态

  /** 取（或建）一个观看者的状态；换房时旧基线作废（新房间的场上是另一批实体） */
  viewerOf(roomId: string, accountId: string): ViewAoi {
    const existing = this.viewers.get(accountId);
    if (existing && existing.roomId === roomId) return existing;
    const fresh: ViewAoi = { roomId, cell: null, seen: new Set(), leaving: new Map() };
    this.viewers.set(accountId, fresh);
    return fresh;
  }

  /** 观看者最近一拍所在格（`null` = 位置未知，此时不裁） */
  viewerCellOf(accountId: string): string | null {
    return this.viewers.get(accountId)?.cell ?? null;
  }

  /**
   * 对齐基线：客户端场上现在有这些实体
   *
   * 用在「服务端刚下发了一份全量」之后（进图 world 帧 + 互见快照、世界广播）。不 seed
   * 的话第一拍会把「其实已经发过」的实体再 enter 一遍，且**不会把客户端多出来的
   * 域外实体 leave 掉** —— 那些是进图时全量给的，会永久留在画面上。
   */
  seed(roomId: string, accountId: string, entityIds: Iterable<string>): void {
    const viewer = this.viewerOf(roomId, accountId);
    viewer.seen = new Set(entityIds);
    viewer.leaving.clear();
  }

  /** 只替换怪物那部分基线（世界广播给的是「怪的全量」，玩家集合不受影响） */
  seedMonsters(roomId: string, accountId: string, monsterIds: Iterable<string>): void {
    const viewer = this.viewerOf(roomId, accountId);
    for (const entityId of [...viewer.seen]) {
      if (entityId.startsWith("m:")) viewer.seen.delete(entityId);
    }
    for (const entityId of monsterIds) {
      viewer.seen.add(entityId);
      viewer.leaving.delete(entityId);
    }
  }

  /** 连接断开 / 被踢：整份状态丢掉（下次进图重新 seed） */
  dropViewer(accountId: string): void {
    this.viewers.delete(accountId);
  }

  /**
   * 算一拍：这个观看者新看见谁、谁离开视野
   *
   * 离开**延迟合并**：第一次看不见只记账（`leaving`），到点还没回来才真的算离开；
   * 期内又看见就把账销掉。玩家在格子边界来回走时，客户端因此不会看到「闪一下」。
   *
   * 自己的实体永远不进「新看见」——客户端本来就有自己，也不需要为它建节点。
   */
  diff(roomId: string, accountId: string, x: number, y: number, now: number): { cell: string; enters: string[]; leaves: string[] } {
    const viewer = this.viewerOf(roomId, accountId);
    const cell = cellKeyOf(x, y);
    viewer.cell = cell;
    const visible = this.visibleInCell(roomId, cell);
    const self = playerEntityOf(accountId);

    const enters: string[] = [];
    for (const entityId of visible) {
      if (entityId === self) continue;
      if (viewer.seen.has(entityId)) {
        viewer.leaving.delete(entityId);
        continue;
      }
      viewer.seen.add(entityId);
      enters.push(entityId);
    }

    const leaves: string[] = [];
    for (const entityId of viewer.seen) {
      if (visible.has(entityId)) continue;
      const deadline = viewer.leaving.get(entityId);
      if (deadline === undefined) {
        viewer.leaving.set(entityId, now + AOI_LEAVE_DELAY_MS);
        continue;
      }
      if (now < deadline) continue;
      viewer.leaving.delete(entityId);
      viewer.seen.delete(entityId);
      leaves.push(entityId);
    }
    return { cell, enters, leaves };
  }

  /** 诊断用：这间房索引了多少实体（日志 / e2e 读它判断同步是否生效） */
  sizeOf(roomId: string): number {
    return this.rooms.get(roomId)?.cellOf.size ?? 0;
  }

  //#endregion

  private roomOf(roomId: string): RoomAoi {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const fresh: RoomAoi = { cells: new Map(), cellOf: new Map(), pos: new Map() };
    this.rooms.set(roomId, fresh);
    return fresh;
  }
}
