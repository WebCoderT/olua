import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RoleMailRow } from "../rows";

/**
 * 游戏内邮件的数据访问（#429）
 *
 * 与 `MailRepository` 完全无关：那个读写 `mail_queue`（外发 SMTP 投递队列），
 * 这个读写 `role_mails`（玩家在游戏里打开的收件箱）。
 *
 * 三个约定都写在 SQL 里，不靠调用方自觉：
 * - **已读只写一次**（`WHERE read_at IS NULL`）—— 重复标已读不该把「第一次看到」的时刻往后推；
 * - **领取只写一次**（`WHERE claimed_at IS NULL`）—— 领奖是发东西的动作，让它幂等，
 *   并发点两次也不会发两份（返回值告诉调用方这次到底有没有命中）；
 * - **过期即不存在**（#439，`expires_at IS NULL OR expires_at > ?`）—— 收件箱的读口
 *   一律滤掉过了保质期的行，物理删除交给清理任务（分批，见 `purgeExpired`）；
 *   读口先滤是让「消失」即时生效，清理只是回收磁盘。
 */
@Injectable()
export class RoleMailRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 事务透传（#868）：「标已领 + 发奖 + 标已读」必须同生共死。
   *
   * 只透传 `DatabaseService.transaction`，业务侧不碰 SQL —— 与 `PartyRepository` /
   * `SocialRepository` 同一写法（`audit-server-boundaries` 只许仓储注入 `DatabaseService`）。
   * 事务里要改的角色存档走 `RolesService`，同一个连接，所以跨表没问题。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  insert(row: RoleMailRow): void {
    this.db.run(
      `INSERT INTO role_mails
         (id, role_id, channel, kind, title, body, gold, exp, attachments, read_at, claimed_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.role_id,
        row.channel,
        row.kind,
        row.title,
        row.body,
        row.gold,
        row.exp,
        row.attachments,
        row.read_at,
        row.claimed_at,
        row.expires_at,
        row.created_at,
      ],
    );
  }

  findByKey(id: string): RoleMailRow | undefined {
    return this.db.get<RoleMailRow>("SELECT * FROM role_mails WHERE id = ?", [id]);
  }

  /** 某角色的收件箱（新的在前；过了保质期的行按「不存在」处理，#439） */
  listByRole(roleId: string, now: number): RoleMailRow[] {
    return this.db.all<RoleMailRow>(
      "SELECT * FROM role_mails WHERE role_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC",
      [roleId, now],
    );
  }

  /** 未读数（入口红点用） */
  countUnread(roleId: string): number {
    return this.db.count("SELECT COUNT(*) AS n FROM role_mails WHERE role_id = ? AND read_at IS NULL", [roleId]);
  }

  /*
   * 这里**没有** `countUnclaimed`（#869 删掉）。
   *
   * 「待领」的判据是「未领 **且** 金币/经验/附件任一存在」—— 一条 `claimed_at IS NULL`
   * 的 COUNT 把它简化成「未领」，于是公告邮件永远算待领，红点清不掉、一键领取永远亮着。
   * 这个判据需要解析 JSON 附件，SQL 写不干净，所以它只存在于
   * `game-mail.service.ts` 的 `hasUnclaimedReward()`（与 `hasReward()` 同源），
   * 由 `boxOf()` 从同一份列表算出来。别在这里再加一个简化版 COUNT。
   */

  /**
   * 一键领取的候选（按发出的时间正序：先来的先领，背包满时停下的是最新的那几封）
   *
   * 传 `channel` 就只领这一栏（面板按频道一键领取的口径）；不传 = 全部频道。
   * 过期的行不在候选里（#439）：列表里都看不见的信，不该被「一键领取」顺手领掉。
   */
  listUnclaimed(roleId: string, channel: string | undefined, now: number): RoleMailRow[] {
    if (!channel) {
      return this.db.all<RoleMailRow>(
        "SELECT * FROM role_mails WHERE role_id = ? AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC, id ASC",
        [roleId, now],
      );
    }
    return this.db.all<RoleMailRow>(
      "SELECT * FROM role_mails WHERE role_id = ? AND channel = ? AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC, id ASC",
      [roleId, channel, now],
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

  /**
   * 清理一批过期的收件箱行（#439）
   *
   * 判据全在 SQL 里，与玩家侧「删一封」的 `remove` 同一个理由的两面：
   * - `expires_at <= ?`：真的过期了（NULL = 永不过期，永远不进来）；
   * - **`claimed_at IS NOT NULL OR attachments = '[]'`**：已领或无附件 ——
   *   带未领附件的行**不允许过期**（过期等于替玩家扔掉奖励，与「未领不能删」50143 同一个理由）。
   *
   * 分批：先按 `LIMIT` 选出这一批的 id 再删（`DELETE ... LIMIT` 依赖 SQLite 的编译开关，
   * 不默认可用），一次大清理不长时间占着写锁 —— 剩下的下一轮再清，
   * 清理是后台回收，不是关键路径。
   *
   * @returns 本批实际删掉的条数
   */
  purgeExpired(now: number, limit: number): number {
    const batch = this.db.all<{ id: string }>(
      `SELECT id FROM role_mails
        WHERE expires_at IS NOT NULL AND expires_at <= ?
          AND (claimed_at IS NOT NULL OR attachments = '[]')
        LIMIT ?`,
      [now, limit],
    );
    if (batch.length === 0) return 0;
    const placeholders = batch.map(() => "?").join(", ");
    return this.db.execute(`DELETE FROM role_mails WHERE id IN (${placeholders})`, batch.map((row) => row.id)).changes;
  }
}
