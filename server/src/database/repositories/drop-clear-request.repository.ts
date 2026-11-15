import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { DropClearRequestRow } from "../rows";

/**
 * 「清空某张图的地面掉落」的**跨进程待办**（`drop_clear_requests`；#805）
 *
 * 为什么是一张表而不是一次 HTTP 调用：地面掉落活在**实时进程（3101）的内存**里，
 * 管理端打的是**存档进程（3100）** —— 两个进程共享 SQLite、不共享内存。落表 + 轮询
 * 是唯一在「实时进程此刻没起来 / 正在重启」时仍然正确的做法：谁在跑谁执行，
 * 重启之后也会先把没做完的请求补掉。
 *
 * **绝对不要**在 3100 直接 `DELETE FROM world_drops WHERE map_id = ?` 就返回成功：
 * 内存里那批掉落还活着，下一拍 `flush` 会把它们原样写回库，页面看起来「清了又出现」。
 */
@Injectable()
export class DropClearRequestRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 记一条清空请求（同一张图已有未完成的请求就**就地合并**，返回那一行的 id）
   *
   * 合并的理由与热重载（`world_reload_requests`）一致：运营连点两下不该清两遍 ——
   * 第二遍清出来 0 件，却在流水里多一批 `manual_clear` 的空记录，反而更难排查。
   */
  enqueue(entry: { zoneId: number; mapId: string; requestedAt: number }): { id: number; merged: boolean } {
    const existing = this.db.get<{ id: number }>(
      "SELECT id FROM drop_clear_requests WHERE zone_id = ? AND map_id = ? AND done_at IS NULL ORDER BY id ASC LIMIT 1",
      [entry.zoneId, entry.mapId],
    );
    if (existing) return { id: existing.id, merged: true };
    const id = this.db.insertReturningId(
      `INSERT INTO drop_clear_requests (zone_id, map_id, requested_at, done_at, cleared) VALUES (?, ?, ?, NULL, 0)`,
      [entry.zoneId, entry.mapId, entry.requestedAt],
    );
    return { id, merged: false };
  }

  /**
   * 还没执行的请求（实时进程每秒读一次）
   *
   * 按 `id` 升序：先提交的先清。**不做时间窗过滤** —— 进程停了三小时再起来，
   * 那时提交的请求也该执行（那张图上现在的掉落是重启后新掉的，但请求的意思就是「清空」）。
   */
  listPending(): DropClearRequestRow[] {
    return this.db.all<DropClearRequestRow>(
      "SELECT * FROM drop_clear_requests WHERE done_at IS NULL ORDER BY id ASC",
    );
  }

  /** 回写执行结果（`cleared` = 实际清掉多少件；只由实时进程写） */
  markDone(id: number, cleared: number, at: number): void {
    this.db.run("UPDATE drop_clear_requests SET done_at = ?, cleared = ? WHERE id = ? AND done_at IS NULL", [
      at,
      cleared,
      id,
    ]);
  }

  /**
   * 某个区最近的一批请求（管理端概况卡看「清完没有」）
   *
   * 取「未完成的 + 最近完成的」，按 id 倒序：页面拿 POST 返回的 `requestId` 在这批里找，
   * 找到且 `doneAt` 有值就显示「已清空 N 件」。一个区一天也就点几次，20 条足够。
   */
  listRecentOfZone(zoneId: number, limit: number): DropClearRequestRow[] {
    return this.db.all<DropClearRequestRow>(
      "SELECT * FROM drop_clear_requests WHERE zone_id = ? ORDER BY id DESC LIMIT ?",
      [zoneId, Math.max(1, Math.min(50, Math.trunc(limit)))],
    );
  }

  /** 某个区还有多少条没执行（合并区前预检用；与热重载同口径） */
  countPendingOfZone(zoneId: number): number {
    return this.db.count("SELECT COUNT(1) AS total FROM drop_clear_requests WHERE done_at IS NULL AND zone_id = ?", [
      zoneId,
    ]);
  }
}
