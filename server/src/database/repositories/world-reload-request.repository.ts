import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { WorldReloadRequestRow } from "../rows";

/** 管理端能写的两种重载模式（见 docs/20 §2.7） */
export const RELOAD_MODES = Object.freeze(["respawn", "reload"] as const);
export type ReloadMode = (typeof RELOAD_MODES)[number];

/** 等空窗的出厂上限：5 分钟（到期强制执行，见 docs/20 §2.7 的「为什么允许强制」） */
export const DEFAULT_FORCE_AFTER_MS = 5 * 60_000;

/**
 * 管理端提交时算出的 `force_at`（`now + forceAfterMs`，不传就取出厂上限）
 *
 * 放在仓储这一层而不是某个服务里：**写的一方**（管理端 MapService 填这一列）与
 * **读的一方**（实时进程 RoomReloadService 判「到点了吗」）分属两个模块、两个进程，
 * 各写一份「默认等多久」迟早漂移（一边 5 分钟一边 10 分钟，症状是「点了没反应」）。
 */
export function defaultForceAt(now: number, forceAfterMs?: number): number {
  return now + (forceAfterMs ?? DEFAULT_FORCE_AFTER_MS);
}

/**
 * 单图热重载请求（`world_reload_requests` 表；#809，收 #669）
 *
 * **跨进程的一张待办表**：管理端在存档进程（3100）写一行 `pending`，实时进程（3101）
 * 每秒读一次并执行。为什么不直接调服务：两个进程不共享内存，HTTP 回调又要处理
 * 「实时进程没起来 / 正在重启」这些情况；写库 + 轮询天然是「谁在跑谁执行」。
 *
 * 同一 `(zone, map, slot)` 的重复请求**在写库时合并**（不新增行，只更新已有 pending 行的
 * mode / force_at）—— 运营连点两下「立即重载」不该重播两次世界。
 */
@Injectable()
export class WorldReloadRequestRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 记一条重载请求（同房间已有 `pending` 就就地合并，返回那一行的 id）
   *
   * 合并口径（docs/20 §8.5 #34）：取**最新的 mode**，`force_at` 取**更早的那个** ——
   * 「先请求等空窗（5 分钟后强制）、再请求立即重载」应该立刻执行，而不是把立即变成 5 分钟。
   */
  enqueue(entry: {
    zoneId: number;
    mapId: string;
    slot: string;
    mode: ReloadMode;
    requestedBy: string;
    requestedAt: number;
    forceAt: number;
  }): { id: number; merged: boolean } {
    const existing = this.db.get<{ id: number; force_at: number }>(
      "SELECT id, force_at FROM world_reload_requests WHERE zone_id = ? AND map_id = ? AND slot = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
      [entry.zoneId, entry.mapId, entry.slot],
    );
    if (existing) {
      this.db.run(
        `UPDATE world_reload_requests SET mode = ?, requested_by = ?, requested_at = ?, force_at = ? WHERE id = ?`,
        [entry.mode, entry.requestedBy, entry.requestedAt, Math.min(existing.force_at, entry.forceAt), existing.id],
      );
      return { id: existing.id, merged: true };
    }
    const id = this.db.insertReturningId(
      `INSERT INTO world_reload_requests (zone_id, map_id, slot, mode, requested_by, requested_at, force_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [entry.zoneId, entry.mapId, entry.slot, entry.mode, entry.requestedBy, entry.requestedAt, entry.forceAt],
    );
    return { id, merged: false };
  }

  /** 待执行的全部请求（按提交先后：先到的先执行，运营的心智顺序就是这样） */
  listPending(): WorldReloadRequestRow[] {
    return this.db.all<WorldReloadRequestRow>(
      "SELECT * FROM world_reload_requests WHERE status = 'pending' ORDER BY requested_at ASC, id ASC",
    );
  }

  /** 标记执行完成（带重播只数摘要） */
  markDone(id: number, detail: string, at: number): void {
    this.db.run("UPDATE world_reload_requests SET status = 'done', done_at = ?, detail = ? WHERE id = ?", [at, detail, id]);
  }

  /** 标记执行失败（`detail` 放最后一次错误；重试计数由调用方掌握，表里不留中间态） */
  markFailed(id: number, detail: string, at: number): void {
    this.db.run("UPDATE world_reload_requests SET status = 'failed', done_at = ?, detail = ? WHERE id = ?", [
      at,
      detail,
      id,
    ]);
  }

  /** 最近 N 条（管理端地图页展示「最近重载过几次、结果如何」） */
  listRecent(limit: number): WorldReloadRequestRow[] {
    return this.db.all<WorldReloadRequestRow>(
      "SELECT * FROM world_reload_requests ORDER BY id DESC LIMIT ?",
      [Math.max(1, Math.min(200, Math.trunc(limit)))],
    );
  }

  /**
   * 清掉太久以前的已完结行（防表无限增长）
   *
   * 保留期按「运营排查够用」定，不按天：一张图的刷怪区一天改十次也就十行，
   * 但把半年前的行留着会让「最近重载」列表一眼看不出最近发生了什么。
   */
  trimFinished(olderThan: number): number {
    return this.db.execute("DELETE FROM world_reload_requests WHERE status != 'pending' AND requested_at < ?", [
      olderThan,
    ]).changes;
  }
}
