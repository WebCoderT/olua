import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";

/**
 * 实时进程入口（#37 拆进程）
 *
 * 与 `main.ts`（存档进程）**共用同一个镜像 / 同一份代码**，只装载实时一侧的依赖图：
 * WS 实时通道 + 取票接口 + 世界权威 + 伤害结算。HTTP 侧只剩这些 —— 玩家 / 管理端 /
 * 邮件 / 备份等全部留在存档进程。
 *
 * ## 部署形态
 *
 * - 客户端**零改动**：取票 `POST /api/realtime/ticket` 与 WS 建连走同一个路径前缀
 *   `/api/realtime*`，nginx 按路径把这一段反代到本进程，其余照旧进存档进程 ——
 *   `configs/network.ts` 的单一来源约定不破；
 * - 本进程与存档进程**共享同一个 SQLite 文件**（WAL + busy_timeout，见 FAQ「存储与多进程」）：
 *   本进程写 `world_monsters`（5 秒批量）与结算血量，存档进程写账号 / 角色表，
 *   各写各的表，低频并发由 WAL 承接；
 * - **不挂 Swagger**：本进程不是契约源，接口文档只从存档进程生成一份。
 */
async function bootstrap() {
  // 显式声明成 Express 应用（与 main.ts 同口径，见那边注释）
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ realtime: true }),
    { logger: ["log", "warn", "error"] },
  );
  const config = app.get(ConfigService);

  const prefix = config.get<string>("apiPrefix") ?? "api";
  const port = config.get<number>("realtimePort") ?? 3101;
  const corsOrigins = config.get<string[]>("corsOrigins") ?? ["*"];

  app.setGlobalPrefix(prefix);
  app.enableShutdownHooks();
  // 与存档进程同一口径：反代后面必须开，直连不能开（见 main.ts 的完整说明）
  app.set("trust proxy", config.get<boolean>("trustProxy") ?? false);
  app.enableCors({ origin: corsOrigins.includes("*") ? true : corsOrigins });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log(`实时进程已启动：ws://localhost:${port}/${prefix}/realtime（世界权威 + 伤害结算同进程）`);
}

void bootstrap();
