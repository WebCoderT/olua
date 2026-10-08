import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { SWAGGER_TAG_DEFINITIONS } from "../common/constants/swagger-tags";
import { SWAGGER_MODELS } from "./models";

/** 接口文档路径（固定，不带 API_PREFIX） */
export const SWAGGER_PATH = "api-docs";

/**
 * 挂载 Swagger 文档
 *
 * 抽成函数（而不是写在 main.ts 里）是为了让**自动化测试也能把文档跑起来**：
 * 「分组对不对、权限点标没标、有没有悬空 $ref」这些只有真生成一次文档才验得出来
 * （见 test/e2e.cjs 的文档断言与 test/e2e-roles.cjs 的第七段）。
 */
export function setupSwagger(app: INestApplication): void {
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
}
