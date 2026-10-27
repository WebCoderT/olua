import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RoleMailRow } from "../rows";

/**
 * 游戏内邮件的数据访问（#429）
 *
 * 与 `MailRepository` 完全无关：那个读写 `mail_queue`（外发 SMTP 投递队列），
 * 这个读写 `role_mails`（玩家在游戏里打开的收件箱）。
 *
 * 两个约定都写在 SQL 里，不靠调用方自觉：
 * - **已读只写一次**（`WHERE read_at IS NULL`）—— 重复标已读不该把「第一次看到」的时刻往后推；
 * - **领取只写一次**（`WHERE claimed_at IS NULL`）—— 领奖是发东西的动作，让它幂等，
 *   并发点两次也不会发两份（返回值告诉调用方这次到底有没有命中）。
 */
@Injectable()
export class RoleMailRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: RoleMailRow): void {
    this.db.run(
      `INSERT INTO role_mails
         (id, role_id, kind, title, body, gold, exp, attachments, read_at, claimed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.role_id,
        row.kind,
        row.title,
        row.body,
        row.gold,
        row.exp,
        row.attachments,
        row.read_at,
        row.claimed_at,
        row.created_at,
      ],
    );
  }

  findByKey(id: string): RoleMailRow | undefined {
    return this.db.get<RoleMailRow>("SELECT * FROM role_mails WHERE id = ?", [id]);
  }

  /** 某角色的收件箱（新的在前） */
  listByRole(roleId: string): RoleMailRow[] {
    return this.db.all<RoleMailRow>(
      "SELECT * FROM role_mails WHERE role_id = ? ORDER BY created_at DESC, id DESC",
      [roleId],
    );
  }

  /** 未读数（入口红点用） */
  countUnread(roleId: string): number {
    return this.db.count("SELECT COUNT(*) AS n FROM role_mails WHERE role_id = ? AND read_at IS NULL", [roleId]);
  }

  /** 未领数（「一键领取」按钮与红点用） */
  countUnclaimed(roleId: string): number {
    return this.db.count("SELECT COUNT(*) AS n FROM role_mails WHERE role_id = ? AND claimed_at IS NULL", [roleId]);
  }

  /** 一键领取的候选（按发出的时间正序：先来的先领，背包满时停下的是最新的那几封） */
  listUnclaimed(roleId: string): RoleMailRow[] {
    return this.db.all<RoleMailRow>(
      "SELECT * FROM role_mails WHERE role_id = ? AND claimed_at IS NULL ORDER BY created_at ASC, id ASC",
      [roleId],
    );
  }

  /** 标已读（已经是已读时不动；返回是否本次改动） */
  markRead(id: string, now: number): boolean {
    return this.db.execute("UPDATE role_mails SET read_at = ? WHERE id = ? AND read_at IS NULL", [now, id]).changes > 0;
  }

  /** 标领取（**幂等**：已领过的行不会被改写，返回是否本次改动） */
  markClaimed(id: string, now: number): boolean {
    return this.db.execute("UPDATE role_mails SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL", [now, id]).changes > 0;
  }

  /** 删除（只允许删已领或无附件的行，判据在 service） */
  remove(id: string): boolean {
    return this.db.execute("DELETE FROM role_mails WHERE id = ?", [id]).changes > 0;
  }
}
