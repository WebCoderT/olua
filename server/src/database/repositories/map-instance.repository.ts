import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapInstanceRow } from "../rows";
import { instanceSlotOf } from "../../common/utils/room-key.util";

/** 出厂时限：30 分钟（运营不填时用它 —— 够打完一轮，也够「忘了关」的副本自己收场） */
export const DEFAULT_INSTANCE_TTL_MS = 30 * 60_000;

/** 出厂人数上限：6 人（一队） */
export const DEFAULT_INSTANCE_MAX_PLAYERS = 6;

/**
 * 收场行的保留期：7 天（#1001 第二刀）
 *
 * 收场之后行不删 —— 「上周那场为什么收了」是运营真会问的问题（一场副本的行只有几十字节）。
 * 但也不能无限长：**开场时顺手裁一次**（`create` 里），不另起定时器 —— 会开副本的部署
 * 一定有人调 `create`，没人开的部署表也不会长。
 */
export const INSTANCE_CLOSED_RETAIN_MS = 7 * 24 * 60 * 60_000;

/**
 * 收场前多久广播 `instanceClosing`（毫秒；#1001 第二刀）
 *
 * 30 秒是「让人打完手上这一只、收东西」的量级。**短副本自动缩短**（取 `ttlMs / 2`）：
 * e2e 与「五分钟试玩本」不该在开出来的第一秒就收到「还剩 30 秒」——
 * 见 `closingLeadOf()`，两处（实时进程判广播点、管理端展示倒计时）都走它。
 */
export const INSTANCE_CLOSING_LEAD_MS = 30_000;

/** 一场副本实际能用的提醒窗口（短 TTL 时按一半算，至少 1 秒） */
export function closingLeadOf(ttlMs: number): number {
  return Math.max(1_000, Math.min(INSTANCE_CLOSING_LEAD_MS, Math.floor(ttlMs / 2)));
}

/** 收场理由（写进 `close_reason`，管理端与日志都读它） */
export const INSTANCE_CLOSE_REASON = Object.freeze({
  /** 所有人离开且宽限期过完 */
  EMPTIED: "emptied",
  /** 时限到了 */
  EXPIRED: "expired",
  /** 通关 / 任务系统标记完成 */
  CLEARED: "cleared",
  /** 管理端强制收场 */
  FORCED: "forced",
  /** 世界丢了（进程重启）：有人再来时才判出来 */
  WORLD_LOST: "world_lost",
} as const);
export type InstanceCloseReason = (typeof INSTANCE_CLOSE_REASON)[keyof typeof INSTANCE_CLOSE_REASON];

/** 开一场副本要什么（`ownerRoleIds` 留空 = 谁都能进） */
export interface CreateInstanceEntry {
  zoneId: number;
  mapId: string;
  originMapId: string;
  ownerRoleIds: string[];
  maxPlayers: number;
  ttlMs: number;
  createdBy: string | null;
  now: number;
}

/**
 * 副本登记簿（`map_instances` 表；#1001 第二刀 / docs/20 §2.8）
 *
 * **为什么是一张表而不是实时进程的内存**：开副本的是管理端（存档进程 3100），
 * 守副本的是实时进程（3101）—— 两个进程只共享 SQLite。写一行、由实时进程按行守，
 * 天然是「谁在跑谁干活」，也不必处理「实时进程没起来」时的 HTTP 回调失败。
 *
 * **为什么房间不在库里**：副本的世界就是 `world_monsters` 里 slot 为 `i<n>` 的那批行，
 * 但**副本不允许从库恢复** —— 进程重启后那张「半场打完」的世界不该被复活成一场新副本。
 * 所以这张表只记「还允不允许进、还差多久收场」，世界状态一律内存 + 收场即删。
 */
@Injectable()
export class MapInstanceRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 开一场副本：先插一行拿自增 id（= 发牌序号），再把 `slot` 补成 `i<id>`
   *
   * 分两步是因为 slot 里要含 id，而 id 只有插完才知道。`slot` 有唯一索引兜着：
   * 同一场不会出现两个 slot，也不会与历史 slot 撞车（AUTOINCREMENT 不复用）。
   */
  create(entry: CreateInstanceEntry): MapInstanceRow {
    // 顺手裁一次老行（见 `INSTANCE_CLOSED_RETAIN_MS`）：开场是这张表唯一会长的地方
    this.trimClosed(entry.now - INSTANCE_CLOSED_RETAIN_MS);
    const owners = JSON.stringify(entry.ownerRoleIds);
    const id = this.db.insertReturningId(
      `INSERT INTO map_instances
         (zone_id, map_id, slot, origin_map_id, owner_role_ids, max_players, ttl_ms,
          created_at, expires_at, created_by)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.zoneId,
        entry.mapId,
        entry.originMapId,
        owners,
        entry.maxPlayers,
        entry.ttlMs,
        entry.now,
        entry.now + entry.ttlMs,
        entry.createdBy,
      ],
    );
    this.db.run("UPDATE map_instances SET slot = ? WHERE id = ?", [instanceSlotOf(id), id]);
    return this.findById(id) as MapInstanceRow;
  }

  findById(id: number): MapInstanceRow | null {
    return this.db.get<MapInstanceRow>("SELECT * FROM map_instances WHERE id = ?", [id]) ?? null;
  }

  /** 按房间键里的 slot 找那一场（`"i7"` → 第 7 场；已收场也返回，调用方看 `closed_at`） */
  findBySlot(zoneId: number, mapId: string, slot: string): MapInstanceRow | null {
    return (
      this.db.get<MapInstanceRow>("SELECT * FROM map_instances WHERE zone_id = ? AND map_id = ? AND slot = ?", [
        zoneId,
        mapId,
        slot,
      ]) ?? null
    );
  }

  /** 所有还开着的副本（实时进程每秒扫一次：判超时、判空房宽限到期） */
  listOpen(): MapInstanceRow[] {
    return this.db.all<MapInstanceRow>("SELECT * FROM map_instances WHERE closed_at IS NULL ORDER BY id ASC");
  }

  /** 一张图还开着的副本（管理端列表页看的就是这几行） */
  listOpenByMap(zoneId: number, mapId: string): MapInstanceRow[] {
    return this.db.all<MapInstanceRow>(
      "SELECT * FROM map_instances WHERE zone_id = ? AND map_id = ? AND closed_at IS NULL ORDER BY id ASC",
      [zoneId, mapId],
    );
  }

  /** 最近收场的几场（管理端「刚关掉的副本」—— 收场原因比行本身有用） */
  listRecentClosed(zoneId: number, mapId: string, limit: number): MapInstanceRow[] {
    return this.db.all<MapInstanceRow>(
      `SELECT * FROM map_instances WHERE zone_id = ? AND map_id = ? AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT ?`,
      [zoneId, mapId, Math.max(1, Math.min(50, Math.trunc(limit)))],
    );
  }

  /** 第一次有人进去：记下时刻（之后「世界丢了」才有得判） */
  markStarted(id: number, at: number): void {
    this.db.run("UPDATE map_instances SET started_at = ? WHERE id = ? AND started_at IS NULL", [at, id]);
  }

  /**
   * 收场（幂等：已经关过的不再改 `closed_at` / 理由）
   *
   * 幂等是必须的：空房宽限到期与超时可能在同一拍被判到，两处都调一次不该
   * 把「emptied」覆盖成「expired」—— 先到的那个理由才是真正的原因。
   */
  close(id: number, reason: InstanceCloseReason, at: number): boolean {
    const { changes } = this.db.execute(
      "UPDATE map_instances SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL",
      [at, reason, id],
    );
    return changes > 0;
  }

  /**
   * 清掉很久以前收场的行（防表无限增长）
   *
   * 保留期给足：一场副本的行只有几十字节，而「上周那场为什么收了」是运营真会问的问题。
   */
  trimClosed(olderThan: number): number {
    return this.db.execute("DELETE FROM map_instances WHERE closed_at IS NOT NULL AND closed_at < ?", [olderThan])
      .changes;
  }
}
