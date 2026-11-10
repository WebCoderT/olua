import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EventLogModule } from "../event-log/event-log.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * 客户端认证模块
 *
 * 依赖 AuditModule：登录成功 / 失败要在**操作日志**里留痕（安全线，查扫号）。
 * 依赖 EventLogModule：同一次登录也要进**行为流水**（#886，与进图 / 击杀连成时序）。
 */
@Module({
  imports: [AuditModule, EventLogModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
