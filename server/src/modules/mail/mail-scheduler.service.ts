import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MAIL_BATCH_SIZE, MAIL_STUCK_TIMEOUT_MS } from "../../common/constants/mail";
import { MailRepository } from "../../database/repositories/mail.repository";
import { MailService } from "./mail.service";

/**
 * 邮件投递调度器
 *
 * 与封禁到期扫描（`ban-scheduler.service`）同一个套路：带生命周期钩子的独立服务，
 * 定时器 `unref()`（不阻止进程退出 —— 否则 e2e 跑完会挂在那里等定时器）。
 *
 * ## 为什么要「先认领再投递」
 * 认领（claim）把任务改成 `sending` 是一次**带条件的数据库写**，
 * 于是两个周期重叠、或调度器与手动重投相撞时，同一条任务只会被一个执行者拿到 ——
 * 否则玩家会收到两封一模一样的邮件。
 *
 * ## 为什么要串行 `await`
 * 一次 tick 里并发发 20 封信，SMTP 服务器多半会直接判定为骚扰而拒连。
 * 逐封发是慢一点，但邮件本来就不是低延迟通道。
 */
@Injectable()
export class MailSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailSchedulerService.name);
  private timer?: NodeJS.Timeout;
  /** 上一轮还在跑就跳过本轮（定时器不等待异步：慢 SMTP 会让两轮重叠） */
  private running = false;

  constructor(
    private readonly mails: MailRepository,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // 启动时先回收「卡在发送中」的孤儿任务：上一次进程可能在投递中途被杀
    const recovered = this.recoverStuck(Date.now());
    if (recovered > 0) this.logger.warn(`启动时回收了 ${recovered} 条卡在发送中的邮件任务`);

    const interval = this.pollMs();
    if (interval <= 0) {
      this.logger.warn("MAIL_POLL_MS 非正数：邮件调度器未启动（队列里的信不会被投递）");
      return;
    }
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 扫一轮：认领到期任务并逐封投递（测试可直接调用，不用等定时器）
   *
   * @returns 本轮认领到的条数（**不是**成功条数：投递结果在记录里）
   */
  async tick(now: number = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = this.mails.claimDue(now, MAIL_BATCH_SIZE);
      for (const row of claimed) {
        await this.mailService.deliver(row, now);
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  /** 回收卡在 `sending` 的任务（超过 `MAIL_STUCK_TIMEOUT_MS` 还停在那里 = 执行者已消失） */
  recoverStuck(now: number = Date.now()): number {
    return this.mails.recoverStuck(now - MAIL_STUCK_TIMEOUT_MS, now);
  }

  private pollMs(): number {
    return Number(this.config.get<number>("mailPollMs") ?? 0);
  }
}
