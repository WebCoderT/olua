import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { AuthGuard } from "./common/guards/auth.guard";
import { PermissionGuard } from "./common/guards/permission.guard";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { SecurityModule } from "./common/security/security.module";
import { DatabaseModule } from "./database/database.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { RolesModule } from "./modules/roles/roles.module";
import { TokenModule } from "./modules/token/token.module";

/**
 * 应用根模块
 *
 * 全局注册两件横切能力（顺序有意义，见注释）：
 * - AuthGuard：默认「全部接口都要登录」，开放接口用 `@Public()` 标注 —— 负责「你是谁」
 * - PermissionGuard：在 AuthGuard 之后跑，按 `@RequirePermissions` 判管理员权限点 —— 负责「你能不能干这件事」
 * - LoggingInterceptor：请求日志（配置开关）
 *
 * 审计拦截器不在这一层注册：它跟 AuditService 绑在一起放在 AuditModule 里
 * （见 modules/audit/audit.module），免得出现「拦截器装了但服务没导出」的运行期问题。
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], envFilePath: [".env"] }),
    DatabaseModule,
    SecurityModule,
    TokenModule,
    HealthModule,
    AuthModule,
    RolesModule,
    AdminModule,
    AuditModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
