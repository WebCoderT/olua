import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { AuthGuard } from "./common/guards/auth.guard";
import { PermissionGuard } from "./common/guards/permission.guard";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { SecurityModule } from "./common/security/security.module";
import { DatabaseModule } from "./database/database.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AnnouncementModule } from "./modules/announcement/announcement.module";
import { GameConfigModule } from "./modules/game-config/game-config.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { MailModule } from "./modules/mail/mail.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { RolesModule } from "./modules/roles/roles.module";
import { SystemModule } from "./modules/system/system.module";
import { TokenModule } from "./modules/token/token.module";
import { WorldModule } from "./modules/world/world.module";
import { ZoneModule } from "./modules/zone/zone.module";
import { SocialModule } from "./modules/social/social.module";
import { QuestModule } from "./modules/quest/quest.module";
import { PartyModule } from "./modules/party/party.module";
import { LeaderboardModule } from "./modules/leaderboard/leaderboard.module";

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
 *
 * ## 工厂形态（#37 拆进程）
 *
 * `AppModule.register({ realtime })` 决定是否装载实时模块（WS 通道 + 取票接口 + 世界权威）：
 * - `realtime: true`（默认，`REALTIME_EMBEDDED` 不设或非 `false`）：**单进程形态**，
 *   全部能力在一个进程里 —— 本地开发与全部既有 e2e 的形态；
 * - `realtime: false`：**独立进程形态**的存档进程，HTTP API 照常、实时通道不在
 *   （由 `main.realtime.ts` 单独起实时进程，nginx 按路径把 `/api/realtime*` 反代过去）。
 *
 * 为什么用工厂而不是运行期开关：模块装载是启动期的事，拆进程要拆的是**依赖图**
 * （存档进程压根不该能 new 出 WebSocketServer），不是加个 if 的行为开关。
 */
@Module({})
export class AppModule {
  static register(options: { realtime: boolean }): DynamicModule {
    return {
      module: AppModule,
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
        SystemModule,
        AnnouncementModule,
        GameConfigModule,
        MailModule,
        ZoneModule,
        SocialModule,
        QuestModule,
        PartyModule,
        LeaderboardModule,
        ...(options.realtime ? [RealtimeModule, WorldModule] : []),
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
      ],
    };
  }
}
