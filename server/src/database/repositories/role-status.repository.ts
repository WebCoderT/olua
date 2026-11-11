import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RoleStatusRow } from "../rows";

/**
 * 角色身上的状态（`role_status`，#822）
 *
 * 只做「这张表的增删查」，叠层 / 到期 / 数值汇总全在 `RoleStatusService` ——
 * 与 `role-inventory` 的分工一致：仓储不判业务，业务不写 SQL。
 *
 * **到期清理有两道**：读取方每次取列表前先删掉过期的（惰性，保证判据不吃旧行），
 * 服务端另有每 5 秒一次的全表清扫（`deleteExpired`）兜住「再没人读过」的行。
 * 两道都按 `expire_at` 单列走索引。
 */
@Injectable()
export class RoleStatusRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 这个角色全部未处理的行（**不**过滤过期 —— 由 service 先调 deleteExpiredOfRole） */
  listByRole(roleId: string): RoleStatusRow[] {
    return this.db.all<RoleStatusRow>("SELECT * FROM role_status WHERE role_id = ?", [roleId]);
  }

  /**
   * 写一行（同 id 覆盖）：主键是 (role_id, status_id)，所以「重复获得」天然是覆盖，
   * 不会长出第二条 —— 叠层与刷新到期都在调用方算好后一次写入。
   */
  upsert(row: RoleStatusRow): void {
    this.db.run(
      `INSERT INTO role_status (role_id, status_id, stacks, expire_at, source_skill, ticked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(role_id, status_id) DO UPDATE SET
         stacks = excluded.stacks,
         expire_at = excluded.expire_at,
         source_skill = excluded.source_skill,
         ticked_at = excluded.ticked_at`,
      [row.role_id, row.status_id, row.stacks, row.expire_at, row.source_skill, row.ticked_at ?? 0],
    );
  }

  /**
   * 只推进周期记账（#826 第三批）
   *
   * 单独一条语句而不是复用 `upsert`：tick 与「另一条状态被刷新」是两件独立的事，
   * 共用 `upsert` 会把对方的 `expire_at` / `stacks` 一起盖掉 —— 那种错只在多状态同时挂着时出现。
   */
  markTicked(roleId: string, statusId: string, tickedAt: number): void {
    this.db.run("UPDATE role_status SET ticked_at = ? WHERE role_id = ? AND status_id = ?", [tickedAt, roleId, statusId]);
  }

  /** 所有带周期效果的未过期行（`tick_ms > 0`；周期结算的扫描面，#826 第三批） */
  listTicking(now: number): Array<RoleStatusRow & { tick_ms: number; tick_effect: string }> {
    return this.db.all<RoleStatusRow & { tick_ms: number; tick_effect: string }>(
      `SELECT rs.*, st.tick_ms AS tick_ms, st.tick_effect AS tick_effect
         FROM role_status rs
         JOIN statuses st ON st.id = rs.status_id
        WHERE rs.expire_at > ? AND st.tick_ms > 0
        ORDER BY rs.role_id ASC, rs.status_id ASC`,
      [now],
    );
  }

  /** 删这个角色这一条状态（到期 / 被驱散 / 死亡清空都用它，返回值给日志用） */
  deleteOne(roleId: string, statusId: string): { changes: number } {
    return this.db.execute("DELETE FROM role_status WHERE role_id = ? AND status_id = ?", [roleId, statusId]);
  }

  /** 删这个角色的全部状态（死亡 / 下线） */
  deleteByRole(roleId: string): { changes: number } {
    return this.db.execute("DELETE FROM role_status WHERE role_id = ?", [roleId]);
  }

  /** 删这个角色已过期的行（读取前惰性清理，返回删了几条） */
  deleteExpiredOfRole(roleId: string, now: number): { changes: number } {
    return this.db.execute("DELETE FROM role_status WHERE role_id = ? AND expire_at <= ?", [roleId, now]);
  }

  /** 全表清扫（定时器用）：只删过期的，不碰还在生效的 */
  deleteExpired(now: number): { changes: number } {
    return this.db.execute("DELETE FROM role_status WHERE expire_at <= ?", [now]);
  }
}
