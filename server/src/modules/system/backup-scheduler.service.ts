import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isBackupDue, backupCheckMs } from "../../common/utils/backup.util";
import { BackupService } from "./backup.service";

/**
 * 自动备份的节拍
 *
 * 定时器**不是**间隔本身，而是「多久瞄一眼到点没有」：判据在 `isBackupDue` 里，
 * 这里只负责按点叫醒它。这么分是因为进程重启后 backup service 会从磁盘上的产物
 * 推断出上次备份时间 —— 于是「今天已经备过」这件事不会因重启而丢，调度也不用把
 * 上次时间存进数据库再担心它跟磁盘不一致。
 *
 * 定时器 `unref()`：不阻止进程退出 —— 否则 e2e 跑完会挂在那里等定时器。
 */
@Injectable()
export class BackupSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupSchedulerService.name);
  private readonly intervalHours: number;
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    private readonly backups: BackupService,
  ) {
    this.intervalHours = Number(config.get<number>("backupIntervalHours") ?? 24);
  }

  onModuleInit(): void {
    const checkMs = backupCheckMs(this.intervalHours);
    if (checkMs <= 0) {
      const reason = this.backups.snapshot().reason;
      this.logger.log(`自动备份未启用：${reason}`);
      return;
    }
    // 启动就瞄一眼：新部署的服务不该空等一个周期才拿到第一份备份
    this.tick();
    this.timer = setInterval(() => this.tick(), checkMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 到点判断 + 触发（对测试也是入口：不用等定时器） */
  tick(now: number = Date.now()): boolean {
    const state = this.backups.snapshot();
    if (!state.enabled) return false;
    if (!isBackupDue(state.lastAttemptAt, now, this.intervalHours)) return false;
    // 不 await：备份是几秒的事，让它自己跑完写账，别把启动流程挂在上面
    void this.backups.runOnce(now);
    return true;
  }
}
