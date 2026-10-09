import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AdminService } from "./admin.service";

/** 扫描间隔：1 分钟。一条 UPDATE 的开销可忽略，晚一分钟解封对体验没有影响 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * 到期封禁的自动解封
 *
 * 单独一个服务而不是塞进 AdminService：它带生命周期钩子（定时器），
 * 与「处理一次请求」的业务方法混在一起会让测试难写、也让 AdminService 的职责含糊。
 *
 * 定时器 `unref()`：不阻止进程退出 —— 否则 e2e 跑完会挂在那里等定时器。
 */
@Injectable()
export class BanSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BanSchedulerService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly admin: AdminService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 立即扫一次（测试可直接调用，不用等定时器） */
  sweep(now: number = Date.now()): string[] {
    const ids = this.admin.unbanExpired(now);
    if (ids.length > 0) this.logger.log(`临时封禁到期，已自动解封 ${ids.length} 个账号`);
    return ids;
  }
}
