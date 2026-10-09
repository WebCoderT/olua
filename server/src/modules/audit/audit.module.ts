import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuditInterceptor } from "../../common/interceptors/audit.interceptor";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";

/**
 * 操作日志模块
 *
 * 两件事一起收在这里：
 * - **导出 AuditService**：认证模块（登录成功 / 失败、改密）要显式记事件；
 * - **注册全局 AuditInterceptor**：管理端写接口自动留痕 —— 把「拦截器」和「它依赖的服务」
 *   放在同一个模块里，避免出现「拦截器装了但服务没导出」这类只在运行期才炸的接线问题。
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
