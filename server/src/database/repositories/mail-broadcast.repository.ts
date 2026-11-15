import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MailBroadcastRow } from "../rows";

/**
 * 运营群发批次的数据访问（#438）
 *
 * 这张表是**幂等的唯一闸门**：`id`（批次号）由管理端生成并在重试时复用，
 * 服务端靠 `INSERT OR IGNORE` + `changes === 0` 判断「这个批次已经发过」，
 * 于是「点两下发送 / 网断了重试」都不会给玩家多塞一封。
 *
 * 为什么幂等不靠「标题 + 正文」去重：运营完全可能连着发两条一模一样的补偿（先发错了再补一份），
 * 内容不是身份，**批次号才是**。
 *
 * 与 `RoleMailRepository` 分开：一个管「一批」（几十行），一个管「一封」（几万行），
 * 读写节奏差两个数量级，混在一个类里会让「哪个方法是批量的」变模糊。
 */
@Injectable()
export class MailBroadcastRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 抢占批次号
   *
   * `INSERT OR IGNORE` 而不是先查后插：并发两次同一批次时，先查后插会双双查到「不存在」，
   * 然后一个成功一个抛唯一键冲突；OR IGNORE 把「谁抢到」交给 SQLite，返回 0 行就是「别人先到了」。
   *
   * @returns 是否本次新建（false = 这个批次号已经存在）
   */
  tryInsert(row: MailBroadcastRow): boolean {
    return (
      this.db.execute(
        `INSERT OR IGNORE INTO mail_broadcasts
           (id, channel, kind, title, body, bind_gold, exp, attachments, filter,
            target_count, sent_count, operator_id, operator_name, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.channel,
          row.kind,
          row.title,
          row.body,
          row.bind_gold,
          row.exp,
          row.attachments,
          row.filter,
          row.target_count,
          row.sent_count,
          row.operator_id,
          row.operator_name,
          row.created_at,
          row.finished_at,
        ],
      ).changes > 0
    );
  }

  findByKey(id: string): MailBroadcastRow | undefined {
    return this.db.get<MailBroadcastRow>("SELECT * FROM mail_broadcasts WHERE id = ?", [id]);
  }

  /** 累加实发条数（每批一次，与那批 `role_mails` 插入同一个事务） */
  addSent(id: string, count: number): void {
    this.db.execute("UPDATE mail_broadcasts SET sent_count = sent_count + ? WHERE id = ?", [count, id]);
  }

  /** 标完成（`finished_at` 为 NULL 的行就是「写到一半」—— 进程挂在中间时它会一直停在那里） */
  markFinished(id: string, now: number): void {
    this.db.execute("UPDATE mail_broadcasts SET finished_at = ? WHERE id = ? AND finished_at IS NULL", [now, id]);
  }

  /** 最近批次（管理端列表；新发的在前） */
  listRecent(limit: number): MailBroadcastRow[] {
    return this.db.all<MailBroadcastRow>("SELECT * FROM mail_broadcasts ORDER BY created_at DESC, id DESC LIMIT ?", [
      limit,
    ]);
  }
}
