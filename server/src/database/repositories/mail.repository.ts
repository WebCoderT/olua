import { Injectable } from "@nestjs/common";
import { MailStatus } from "../../common/constants/mail";
import { DatabaseService, SqlParam } from "../database.service";
import { MailQueueRow, MailQueueWithAccountRow } from "../rows";
import { MAIL_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 邮件投递列表查询条件 */
export interface MailListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配收件邮箱 / 标题 / 收件账号名 */
  keyword?: string;
  /** 状态筛选（见 MailStatus） */
  status?: string;
  sort?: string;
  order?: string;
}

/** 可被调度器捡起来投递的状态（拼进 SQL 的 IN 列表） */
const DELIVERABLE = `('${MailStatus.PENDING}', '${MailStatus.RETRYING}')`;

/**
 * 邮件投递队列的数据访问
 *
 * 状态流转的**每一次写入都在 SQL 里带 `status` 条件**（`WHERE id = ? AND status IN (…)`）：
 * 调度器的两次扫描、或「扫描」与「运营手动重投」撞在一起时，没有条件就会互相覆盖 ——
 * 表现为同一封信被发两遍，而收件人只会觉得运营在骚扰他。
 *
 * `attempts` 的自增同样写在 SQL 里（`attempts = attempts + 1`），理由与角色修订号一致：
 * 读出来加一再写回，在并发下会丢掉一次自增。
 */
@Injectable()
export class MailRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: MailQueueRow): void {
    this.db.run(
      `INSERT INTO mail_queue
        (id, to_email, account_id, template_key, subject, body, status, attempts,
         next_retry_at, last_error, created_by, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.to_email,
        row.account_id,
        row.template_key,
        row.subject,
        row.body,
        row.status,
        row.attempts,
        row.next_retry_at,
        row.last_error,
        row.created_by,
        row.created_at,
        row.updated_at,
        row.sent_at,
      ],
    );
  }

  findById(id: string): MailQueueRow | undefined {
    return this.db.get<MailQueueRow>("SELECT * FROM mail_queue WHERE id = ?", [id]);
  }

  /** 取一条**带收件账号名**的任务（单条接口用：界面要显示账号名，不能退回显示 id） */
  findWithAccountById(id: string): MailQueueWithAccountRow | undefined {
    return this.db.get<MailQueueWithAccountRow>(
      `SELECT m.*, a.username AS account_name FROM mail_queue m LEFT JOIN accounts a ON a.id = m.account_id WHERE m.id = ?`,
      [id],
    );
  }

  /**
   * 认领一批到期任务（**原子**：认领到的行会被立刻改成 `sending`）
   *
   * 先 SELECT 出候选 id，再逐条带条件 UPDATE —— 只有 UPDATE 真的改动了行才算认领成功。
   * 这样两个调度周期重叠时（或调度器与手动重投相撞）同一条任务只会被一个执行者拿到。
   *
   * `next_retry_at IS NULL` 也在条件里：`pending` 的新任务没有这一列的值，但要能立刻发。
   */
  claimDue(now: number, limit: number): MailQueueRow[] {
    const due = this.db.all<{ id: string }>(
      `SELECT id FROM mail_queue
       WHERE status IN ${DELIVERABLE} AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [now, limit],
    );
    const claimed: MailQueueRow[] = [];
    due.forEach((candidate) => {
      const { changes } = this.db.execute(
        `UPDATE mail_queue SET status = ?, updated_at = ? WHERE id = ? AND status IN ${DELIVERABLE}`,
        [MailStatus.SENDING, now, candidate.id],
      );
      if (changes === 0) return;
      const row = this.findById(candidate.id);
      if (row) claimed.push(row);
    });
    return claimed;
  }

  /** 标记投递成功（`attempts` 在 SQL 里自增：这一次的尝试也算数） */
  markSent(id: string, now: number): void {
    this.db.execute(
      `UPDATE mail_queue
       SET status = ?, attempts = attempts + 1, sent_at = ?, last_error = NULL, next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      [MailStatus.SENT, now, now, id, MailStatus.SENDING],
    );
  }

  /** 标记一次失败并安排重试（下一次的时间由调用方算好，退避公式不在这里） */
  markRetry(id: string, error: string, nextRetryAt: number, now: number): void {
    this.db.execute(
      `UPDATE mail_queue
       SET status = ?, attempts = attempts + 1, last_error = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
      [MailStatus.RETRYING, error, nextRetryAt, now, id, MailStatus.SENDING],
    );
  }

  /** 标记最终失败（重试次数用尽；原因留在 `last_error` 供界面展示） */
  markFailed(id: string, error: string, now: number): void {
    this.db.execute(
      `UPDATE mail_queue
       SET status = ?, attempts = attempts + 1, last_error = ?, next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      [MailStatus.FAILED, error, now, id, MailStatus.SENDING],
    );
  }

  /**
   * 把一条最终失败的任务重新放回队列（手动重投）
   *
   * `attempts` 归零而不是续着数：重投的前提是「故障已经排除」（SMTP 修好了、邮箱改对了），
   * 让它重新获得完整次数；续着数会让一条只差一次就到上限的任务重投后**第一次失败就终结**。
   *
   * 带 `status = failed` 条件：只有终态可重投，正在发送 / 已成功的任务不受影响。
   */
  resetForRetry(id: string, now: number): { changes: number } {
    return this.db.execute(
      `UPDATE mail_queue
       SET status = ?, attempts = 0, last_error = NULL, next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      [MailStatus.PENDING, now, id, MailStatus.FAILED],
    );
  }

  /**
   * 回收「卡在发送中」的任务（进程在投递中途被杀时留下的孤儿）
   *
   * 判据是 `updated_at < cutoff`：认领时会写一次 updated_at，正常投递结束（成功或失败）
   * 也会再写一次 —— 所以超过一定时间还停在 `sending` 的，只可能是执行者已经没了。
   */
  recoverStuck(cutoff: number, now: number): number {
    return this.db.execute(
      `UPDATE mail_queue SET status = ?, next_retry_at = ?, updated_at = ? WHERE status = ? AND updated_at < ?`,
      [MailStatus.RETRYING, now, now, MailStatus.SENDING, cutoff],
    ).changes;
  }

  /** 分页检索（默认按创建时间倒序） */
  list(options: MailListOptions): MailQueueWithAccountRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<MailQueueWithAccountRow>(
      `SELECT m.*, a.username AS account_name
       FROM mail_queue m
       LEFT JOIN accounts a ON a.id = m.account_id
       ${clause}
       ORDER BY ${resolveSort(MAIL_SORT, options.sort, options.order)}, m.id DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: MailListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(
      `SELECT COUNT(1) AS total FROM mail_queue m LEFT JOIN accounts a ON a.id = m.account_id ${clause}`,
      params,
    );
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: MailListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义，否则邮箱里的 `_` 会被当成单字符通配符
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(m.to_email LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (options.status) {
      where.push("m.status = ?");
      params.push(options.status);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
