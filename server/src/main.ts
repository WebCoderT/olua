import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { setupSwagger, SWAGGER_PATH } from "./swagger/setup";

/**
 * 服务端入口
 *
 * 三件全局横切（其它地方不再重复注册）：
 * - ValidationPipe：入参校验 + 隐式类型转换（query 里的 page 传字符串也能过）
 * - TransformInterceptor：成功响应统一包裹 { code, message, data, timestamp }
 * - AllExceptionsFilter：失败响应同样形状（message 一定是可展示的中文）
 *
 * Swagger 文档的挂载在 swagger/setup（抽出去是为了让自动化测试也能生成一次文档，
 * 好断言分组 / 权限标注 / 没有悬空 $ref）。
 */
async function bootstrap() {
  // 显式声明成 Express 应用：`app.set("trust proxy", ...)` 只有 Express 适配器才有
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "warn", "error"] });
  const config = app.get(ConfigService);

  const prefix = config.get<string>("apiPrefix") ?? "api";
  const port = config.get<number>("port") ?? 3100;
  const corsOrigins = config.get<string[]>("corsOrigins") ?? ["*"];

  app.setGlobalPrefix(prefix);
  // 反向代理后面必须开（否则 req.ip 全是代理的地址，登录限流会把所有人当成同一个人一起锁死）；
  // 直连暴露时**不能**开 —— 开着等于允许调用方伪造 X-Forwarded-For 绕过 IP 限流
  app.set("trust proxy", config.get<boolean>("trustProxy") ?? false);
  // 跨域：客户端（Cocos Web 预览）与管理端（Vite dev server）都是独立源，必须开
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

  setupSwagger(app);

  const logger = new Logger("Bootstrap");
  // 默认密钥是**写在代码里**的常量，等于公开；生产忘了替换就等于任何人可自签 admin 令牌。
  // 这是启动期就该喊出来的事（判据只有 configuration 那一处），管理端「系统信息」页也会标红
  if (config.get<boolean>("jwtSecretIsDefault")) {
    logger.warn("JWT_SECRET 仍是内置默认值，生产环境请务必替换，否则令牌可被伪造");
  }

  await app.listen(port);

  logger.log(`服务已启动：http://localhost:${port}/${prefix}`);
  logger.log(`接口文档：http://localhost:${port}/${SWAGGER_PATH}`);
}

void bootstrap();
