import { Module } from "@nestjs/common";
import { EventLogController } from "./event-log.controller";
import { EventLogListener } from "./event-log.listener";
import { EventLogService } from "./event-log.service";

/**
 * 玩家行为流水模块（#886 / J3）
 *
 * **必须挂在 AppModule 的公共 imports 里**（不在 `options.realtime` 分支内）：
 * 进图事件由实时进程写、登录 / 拾取 / 消耗由 API 进程写，拆进程形态下两边都要有这个模块。
 *
 * 依赖 `GameEventsModule`（`@Global`，不用显式 import）拿总线订阅；
 * 仓储由 `DatabaseModule`（`@Global`）提供。
 *
 * 导出 `EventLogService`：登录 / 进图 / 拾取 / 获得 / 消耗 / 邮件六条链路要直接调它。
 */
@Module({
  controllers: [EventLogController],
  providers: [EventLogService, EventLogListener],
  exports: [EventLogService],
})
export class EventLogModule {}
