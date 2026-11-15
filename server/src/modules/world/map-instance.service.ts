import { Injectable, Logger } from "@nestjs/common";
import {
  INSTANCE_CLOSE_REASON,
  InstanceCloseReason,
  MapInstanceRepository,
  closingLeadOf,
} from "../../database/repositories/map-instance.repository";
import { MapInstanceRow } from "../../database/rows";
import { isInstanceSlot, roomKey, splitRoomKey } from "../../common/utils/room-key.util";
import { RoomManager } from "./room/room.manager";

/**
 * 收场理由（值域 `emptied` / `expired` / `cleared` / `forced` / `world_lost`）
 *
 * 出口转一道：实时通道只该引世界域的服务，不该直连仓储（`audit-server-boundaries` 的
 * REPO_EDGES）—— 这个类型是它与通道之间合约的一部分，所以从这里走。
 */
export type { InstanceCloseReason } from "../../database/repositories/map-instance.repository";

/**
 * 全员离开后的宽限期**默认值**（毫秒；#1001 第二刀）
 *
 * 为什么不是「最后一个人一走就销毁」：客户端闪断、换线失败回退、主城取东西再回来 ——
 * 这些都表现成「一瞬间房里没人」。立刻销毁的话，一次网络抖动就把一队人的副本收了。
 * 30 秒足够覆盖重连，又不至于让没人打的副本占着内存与库行太久。
 *
 * 实际取值由配置 `WORLD_INSTANCE_EMPTY_GRACE_MS` 给，这里只是兜底常量
 * （与 `WORLD_MAP_IDLE_MS` 同一套：e2e 要把它压到几秒才测得动）。
 */
export const INSTANCE_EMPTY_GRACE_MS = 30_000;

/** 进副本被拒的理由（与协议 `instanceEnterResult.field` 同一套取值） */
export type InstanceRejectField = "unknown" | "closed" | "expired" | "full" | "forbidden" | "zone";

/**
 * 进副本的判定结果
 *
 * `ok = false` 时可能还带一个 `settleReason`：这一场其实**已经该收场了**（超时 / 世界丢了），
 * 调用方要先把它收掉（清残留行 + 把里面的人送回原图）再回拒绝帧 ——
 * 否则「进不去」的行会一直挂在那儿，下一拍扫地又判一次。
 */
export type InstanceEntryVerdict =
  | { ok: true; row: MapInstanceRow; fresh: boolean }
  | { ok: false; field: InstanceRejectField; row: MapInstanceRow | null; settleReason?: InstanceCloseReason };

/**
 * 扫地结论（`sweep` 的产物；**只判不做** —— 广播 / 送人 / 销毁房间都是通道的事）
 *
 * 世界层与通道的分工在这里延续：这一层知道「哪一场该收了、还差几秒」，但不知道
 * 连接存在。`RealtimeService` 拿到结论后自己发 `instanceClosing`、把人 `worldJoin` 回原图。
 */
export type InstanceSweepDecision =
  | { kind: "closing"; row: MapInstanceRow; inMs: number }
  | { kind: "settle"; row: MapInstanceRow; reason: InstanceCloseReason };

/**
 * 副本生命周期（#1001 第二刀 / docs/20 §2.8）
 *
 * ## 它管什么
 *
 * - **能不能进**（`entryOf`）：行还在不在、过期没、人满没、名单在不在、世界还在不在；
 * - **什么时候收场**（`sweep`）：超时 / 空房宽限到期 / 世界丢了，以及收场前的那次广播。
 *
 * ## 它不管什么
 *
 * 建房、播种、广播、把人送回原图 —— 那些分别是 `RoomManager` / `WorldService` / 通道的事。
 * 这里只读一份登记表（`map_instances`）与房间状态，给出**结论**。
 *
 * ## 为什么状态全在库里
 *
 * 开副本的是管理端（存档进程 3100），守副本的是实时进程（3101）—— 两个进程只共享 SQLite。
 * 所以「还允不允许进、几时收场」必须是行里的字段，而不是某个进程的内存变量；
 * 唯一留在内存的是 `announced`（「这一场的收场广播已经发过了」）—— 它丢了的后果只是
 * 重发一次提醒，不值得落库。
 */
@Injectable()
export class MapInstanceService {
  private readonly logger = new Logger(MapInstanceService.name);

  /** 已经广播过 `instanceClosing` 的场次（进程内；重启重发一次提醒，无害） */
  private readonly announced = new Set<number>();

  constructor(
    private readonly instances: MapInstanceRepository,
    private readonly rooms: RoomManager,
  ) {}

  /**
   * 进副本判据（顺序 = 玩家看到的顺序）
   *
   * 1. 房间键不是副本 / 行不存在 → `unknown`（id 拼错 / 行被清掉了）
   * 2. 已收场 → `closed`
   * 3. 过点了 → `expired`（顺手让调用方把它收掉）
   * 4. 名单外 → `forbidden`（名单为空 = 谁都能进）
   * 5. 世界丢了（开过、但房间不在内存了）→ `closed` + 收场（副本不允许从库恢复）
   * 6. 人满 → `full`（已经站在这一场里的人放行 —— 重连不该被自己那一场的容量锁在门外）
   */
  entryOfRoom(input: { roomId: string; accountId: string; roleId: string; now: number }): InstanceEntryVerdict {
    const ref = splitRoomKey(input.roomId);
    if (!isInstanceSlot(ref.slot)) return { ok: false, field: "unknown", row: null };
    const row = this.instances.findBySlot(ref.zoneId, ref.mapId, ref.slot);
    if (!row) return { ok: false, field: "unknown", row: null };
    return this.verdictOf(row, input);
  }

  /** 判据本体（房间键入口的唯一实现 —— 别长出第二套「按 id 进」的口径） */
  private verdictOf(row: MapInstanceRow, input: { accountId: string; roleId: string; now: number }): InstanceEntryVerdict {
    if (row.closed_at !== null) return { ok: false, field: "closed", row };
    if (input.now >= row.expires_at) return { ok: false, field: "expired", row, settleReason: INSTANCE_CLOSE_REASON.EXPIRED };
    const owners = parseOwners(row.owner_role_ids);
    if (owners.length > 0 && !owners.includes(input.roleId)) return { ok: false, field: "forbidden", row };
    const room = this.rooms.get(roomKeyOf(row));
    // 开过、房间却不在内存：进程重启过（或房间被代际作废）—— 这一场的世界没了。
    // 按普通房间那样「从库恢复」会把半场打完的副本复活成一场新的，所以这里直接收场。
    if (row.started_at !== null && !room) {
      return { ok: false, field: "closed", row, settleReason: INSTANCE_CLOSE_REASON.WORLD_LOST };
    }
    const inside = room?.viewers.has(input.accountId) ?? false;
    if (!inside && row.max_players > 0 && (room?.viewers.size ?? 0) >= row.max_players) {
      return { ok: false, field: "full", row };
    }
    return { ok: true, row, fresh: row.started_at === null };
  }

  /**
   * 扫地：这一拍该广播谁、该收谁（**只判不做**）
   *
   * 一行的四种结局（顺序就是优先级）：
   * 1. 过点 → 收（超时是硬边界，比「刚空出来」更该报）
   * 2. 开过但房间不在内存 → 收（世界丢了）
   * 3. 空房宽限到期 → 收
   * 4. 还没到点但进了提醒窗口 → 广播一次（`announced` 记着，只发一次）
   *
   * `started_at IS NULL`（还没人进过）的行只判超时：它没有房间、没有观看者，
   * 「空房」对它没有意义。
   *
   * 另外还有**第五种**（不在上面这一轮里，见方法末尾）：行已经被管理端收场
   * （`closed_at` 非空，`cleared` / `forced`），但房间还活着 —— 那些行不在
   * `listOpen()` 的结果里，得从内存里的副本房反查。
   */
  sweep(now: number, emptyGraceMs: number): InstanceSweepDecision[] {
    const decisions: InstanceSweepDecision[] = [];
    for (const row of this.instances.listOpen()) {
      const room = this.rooms.get(roomKeyOf(row));
      if (now >= row.expires_at) {
        decisions.push({ kind: "settle", row, reason: INSTANCE_CLOSE_REASON.EXPIRED });
        continue;
      }
      if (row.started_at !== null && !room) {
        decisions.push({ kind: "settle", row, reason: INSTANCE_CLOSE_REASON.WORLD_LOST });
        continue;
      }
      if (room && room.viewers.size === 0 && room.emptySince !== null && now - room.emptySince >= emptyGraceMs) {
        decisions.push({ kind: "settle", row, reason: INSTANCE_CLOSE_REASON.EMPTIED });
        continue;
      }
      const at = row.expires_at - closingLeadOf(row.ttl_ms);
      if (now >= at && !this.announced.has(row.id)) {
        this.announced.add(row.id);
        decisions.push({ kind: "closing", row, inMs: Math.max(0, row.expires_at - now) });
      }
    }
    // 管理端「通关收场 / 强制散场」是**先改行、后散场**：`closed_at` 立刻非空（列表当场变），
    // 而把人送回原图、销毁房间在实时进程这一侧。这些行已经不在 `listOpen()` 里了，
    // 只靠上面那一轮永远等不到它们 —— 表现为「列表说关了，人还在里面打，库里的怪也还在」。
    // 所以再扫一遍内存里的副本房：行已收场而房间还在，就按行上记的原因收掉。
    for (const room of this.rooms.list()) {
      if (!isInstanceSlot(room.slot)) continue;
      const row = this.instances.findBySlot(room.zoneId, room.mapId, room.slot);
      if (!row || row.closed_at === null) continue;
      decisions.push({
        kind: "settle",
        row,
        reason: (row.close_reason as InstanceCloseReason | null) ?? INSTANCE_CLOSE_REASON.FORCED,
      });
    }
    return decisions;
  }

  /**
   * 记「这一场已经收场」（调用方做完效果后调；**幂等**）
   *
   * @returns 这一次是不是真的关掉了（已经关过的返回 false，调用方据此决定要不要再清一遍房间）
   */
  markClosed(row: MapInstanceRow, reason: InstanceCloseReason, now: number): boolean {
    this.announced.delete(row.id);
    const changed = this.instances.close(row.id, reason, now);
    if (changed) {
      this.logger.log(
        `副本 ${row.zone_id}:${row.map_id}:${row.slot} 已收场（${reason}）：` +
          `开于 ${new Date(row.created_at).toISOString()}，${row.max_players} 人上限`,
      );
    }
    return changed;
  }

  /** 还开着的副本（管理端列表 / 扫地的输入） */
  listOpen(): MapInstanceRow[] {
    return this.instances.listOpen();
  }

  /**
   * 按房间键的槽位取一行（**收场过的也返回**）
   *
   * 通道要用它拼拒绝帧（`mapId` / `originMapId` 得在拒绝里带上，客户端才知道「本来要回哪」），
   * 而「收场了没」由判定自己说 —— 只查开着的行会把 `closed` 误报成 `unknown`。
   */
  findRow(zoneId: number, mapId: string, slot: string): MapInstanceRow | null {
    return this.instances.findBySlot(zoneId, mapId, slot);
  }

  /** 记「这一场开场了」（第一次真的有人进去；之后再没人进来过就该收场了） */
  markStarted(row: MapInstanceRow, now: number): void {
    this.instances.markStarted(row.id, now);
  }
}

/** 一行的房间键 */
export function roomKeyOf(row: MapInstanceRow): string {
  return roomKey(row.zone_id, row.map_id, row.slot);
}

/** 名单列（脏 JSON 按「谁都能进」处理：名单坏了不该把人挡在外面） */
function parseOwners(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
