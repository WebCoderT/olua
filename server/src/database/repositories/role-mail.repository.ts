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
         (id, role_id, channel, kind, title, body, bind_gold, exp, attachments, read_at, claimed_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.role_id,
        row.channel,
        row.kind,
        row.title,
        row.body,
        row.bind_gold,
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
   * 「待领」的判据是「未领 **且** 绑定元宝/经验/附件任一存在」—— 一条 `claimed_at IS NULL`
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
   * 清理一批过期的收件箱行（#439 / #867）
   *
   * 判据全在 SQL 里，与玩家侧「删一封」的 `remove` 同一个理由的两面：
   * - `expires_at <= ?`：真的过期了（NULL = 永不过期，永远不进来）；
   * - **`claimed_at IS NOT NULL OR 三样奖励都没有`**：已领、或者压根没奖励 ——
   *   只要还有**没领的奖励**（绑定元宝 / 经验 / 附件任一），就不允许物理删除。
   *
   * #867 之前这里写的是 `attachments = '[]'`，于是「纯绑定元宝 / 纯经验」的补偿邮件
   * **未领就被删掉**（奖励凭空蒸发）。现在改成与 `hasUnclaimedReward()` 同源的判据：
   * 那种行只能靠 `GameMailAutoClaimService` 入包后（`claimed_at` 非空）再被清掉；
   * 入包一直失败（背包满到上限）的行会一直留着 —— 那是**有意的**，等人工。
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
          AND (claimed_at IS NOT NULL
               OR (bind_gold <= 0 AND exp <= 0 AND (attachments = '[]' OR attachments = '')))
        LIMIT ?`,
      [now, limit],
    );
    if (batch.length === 0) return 0;
    const placeholders = batch.map(() => "?").join(", ");
    return this.db.execute(`DELETE FROM role_mails WHERE id IN (${placeholders})`, batch.map((row) => row.id)).changes;
  }

  /**
   * 挑一批「快过期、还没领、有奖励、且主人此刻离线」的邮件（#867）
   *
   * 三个判据写在 SQL 里，缺一个都会出事：
   * - **`expires_at <= ?`（传入 now + 提前量）**：只扫快过期的，早就不动；
   * - **`(bind_gold > 0 OR exp > 0 OR attachments 非空)`**：与 `hasUnclaimedReward()` 同源 ——
   *   只认 `attachments` 会漏掉纯绑定元宝那批（那正是 #867 要救的）；
   * - **主人离线**（`accounts.online_role_id` 不是这个角色）：在线角色的存档在客户端手里，
   *   服务端改了库会被下一次全量覆盖冲掉，入包等于白做还可能丢东西。
   *
   * `auto_attempts` 到上限的不再入选：反复失败的行每轮都重试等于把 5 次机会几分钟用光。
   */
  listAutoClaimCandidates(deadline: number, maxAttempts: number, limit: number): RoleMailRow[] {
    return this.db.all<RoleMailRow>(
      `SELECT m.* FROM role_mails m
         JOIN roles r    ON r.id = m.role_id
         LEFT JOIN accounts a ON a.id = r.account_id
        WHERE m.claimed_at IS NULL
          AND m.expires_at IS NOT NULL AND m.expires_at <= ?
          AND m.auto_claimed_at = 0
          AND m.auto_attempts < ?
          AND (m.bind_gold > 0 OR m.exp > 0 OR (m.attachments <> '[]' AND m.attachments <> ''))
          AND (a.online_role_id IS NULL OR a.online_role_id <> m.role_id)
        ORDER BY m.expires_at ASC, m.id ASC
        LIMIT ?`,
      [deadline, maxAttempts, limit],
    );
  }

  /** 标「这批奖励是系统自动入包的」（#867；成功后立刻写，与 `markClaimed` 同一个事务） */
  markAutoClaimed(id: string, now: number): boolean {
    return this.db.execute("UPDATE role_mails SET auto_claimed_at = ? WHERE id = ?", [now, id]).changes > 0;
  }

  /**
   * 自动入包失败一次（#867）
   *
   * **必须在事务外面调**：失败时事务已经回滚，写在里面会一起被抹掉，于是
   * `auto_attempts` 永远是 0、每轮都重试同一封（背包满的行会把整轮预算吃光）。
   */
  bumpAutoAttempts(id: string): number {
    return this.db.execute("UPDATE role_mails SET auto_attempts = auto_attempts + 1 WHERE id = ?", [id]).changes;
  }

  /** 往正文末尾追加一行（#867：入包成功后告诉玩家一句，**不改原文**） */
  appendBody(id: string, line: string): number {
    return this.db.execute("UPDATE role_mails SET body = body || ? WHERE id = ?", [line, id]).changes;
  }
}
