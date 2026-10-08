import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { SWAGGER_TAG_DEFINITIONS } from "./common/constants/swagger-tags";
import { SWAGGER_MODELS } from "./swagger/models";

/** 接口文档路径（固定，不带 API_PREFIX） */
const SWAGGER_PATH = "api-docs";

/**
 * 服务端入口
 *
 * 三件全局横切（其它地方不再重复注册）：
 * - ValidationPipe：入参校验 + 隐式类型转换（query 里的 page 传字符串也能过）
 * - TransformInterceptor：成功响应统一包裹 { code, message, data, timestamp }
 * - AllExceptionsFilter：失败响应同样形状（message 一定是可展示的中文）
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  const config = app.get(ConfigService);

  const prefix = config.get<string>("apiPrefix") ?? "api";
  const port = config.get<number>("port") ?? 3100;
  const corsOrigins = config.get<string[]>("corsOrigins") ?? ["*"];

  app.setGlobalPrefix(prefix);
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

  // —— Swagger：接口文档把「统一响应包裹」也画出来（见 common/decorators/api-data-response.decorator）——
  const builder = new DocumentBuilder()
    .setTitle("olua 游戏服务端 API")
    .setDescription(
      [
        "olua 客户端与管理端共用的服务端接口。",
        "",
        "**接口分三组**（左侧按组展示，顺序即权限层级）：",
        "1. **公共接口** —— 无需令牌（注册 / 登录 / 健康检查）",
        "2. **客户端** —— 需要 `player` 令牌（`/api/auth/login` 获取），只能操作自己账号的数据",
        "3. **管理端** —— 需要 `admin` 令牌（`/api/admin/auth/login` 获取），且每个接口还要求权限点",
        "",
        "**统一响应包裹**：所有接口（成功与失败）都是 `{ code, message, data, timestamp }`；",
        "`code = 0` 表示成功，其余见服务端 `common/constants/biz-code.ts`。",
        "",
        "**权限**：管理员分三级 —— 超级管理员 / 管理员 / 只读观察员，",
        "每个管理端接口的说明里都写了「所需权限」，由 `common/constants/permission.ts` 统一维护。",
        "请求头一律是 `Authorization: Bearer <token>`。",
      ].join("\n"),
    )
    .setVersion("0.1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT", description: "客户端令牌（/api/auth/login 获取）" }, "player")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT", description: "管理端令牌（/api/admin/auth/login 获取）" }, "admin");

  // 分组声明：顺序决定文档里的展示顺序（公共 → 客户端 → 管理端），描述写清各组要什么令牌
  for (const tag of SWAGGER_TAG_DEFINITIONS) builder.addTag(tag.name, tag.description);

  const swaggerConfig = builder.build();
  // autoTagControllers: false —— 关掉「没有类级 tag 就用控制器类名当分组」的默认行为，
  // 否则每个接口除了自己的分组，还会多挂一个 Health / Auth 之类的类名分组
  const document = SwaggerModule.createDocument(app, swaggerConfig, {
    extraModels: SWAGGER_MODELS,
    autoTagControllers: false,
  });
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: "none",
      // 顶部搜索框：接口多了之后按路径 / 摘要过滤（分组本身由 tag 折叠展示）
      filter: true,
    },
  });

  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log(`服务已启动：http://localhost:${port}/${prefix}`);
  logger.log(`接口文档：http://localhost:${port}/${SWAGGER_PATH}`);
}

void bootstrap();
