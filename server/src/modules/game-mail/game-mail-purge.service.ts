import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoleMailRepository } from "../../database/repositories/role-mail.repository";

/**
 * 收件箱过期清理（#439）
 *
 * 与封禁到期扫描（`ban-scheduler.service`）、邮件投递调度（`mail-scheduler.service`）
 * 同一个套路：带生命周期钩子的独立服务，定时器 `unref()`（不阻止进程退出 —— 否则 e2e 跑完会挂在那里）。
 *
 * 两条纪律：
 * - **一次只删一批**（`MAIL_PURGE_BATCH`）：清理是后台回收，不该长时间持有写锁 ——
   实时进程的存档写入会被卡住；剩下的下一轮再清；
 * - **带未领附件的行删不掉**（判据在 `RoleMailRepository.purgeExpired` 的 SQL 里）：
   过期等于替玩家扔奖励 —— 真要清，做法是「过期时把附件自动入包 + 落一条入包记录」，
   那是另一个 issue 的事，这里先只清已领 / 无附件的行。
 */
@Injectable()
export class GameMailPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameMailPurgeService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly mails: RoleMailRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval = this.intervalMs();
    if (interval <= 0) {
      this.logger.warn("MAIL_PURGE_INTERVAL_MS 非正数：收件箱过期清理未启动（过期行只会在读口被滤掉，不回收磁盘）");
      return;
    }
    this.timer = setInterval(() => this.sweep(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 清一轮（测试可直接调用，不用等定时器）
   *
   * @returns 本批删掉的条数
   */
  sweep(now: number = Date.now()): number {
    try {
      const removed = this.mails.purgeExpired(now, this.batchSize());
      if (removed > 0) this.logger.log(`收件箱过期清理：本批删除 ${removed} 条`);
      return removed;
    } catch (error) {
      // 清理是旁路：失败不挡主流程，下一轮会再试
      this.logger.warn(`收件箱过期清理失败：${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  private batchSize(): number {
    return Math.max(1, Number(this.config.get<number>("mailPurgeBatch") ?? 500));
  }

  private intervalMs(): number {
    return Number(this.config.get<number>("mailPurgeIntervalMs") ?? 60_000);
  }
}
