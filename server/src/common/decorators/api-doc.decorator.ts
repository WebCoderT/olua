import { applyDecorators } from "@nestjs/common";
import { ApiExtension, ApiOperation, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { describePermission, PermissionValue } from "../constants/permission";
import { SWAGGER_TAGS } from "../constants/swagger-tags";
import { RequirePermissions } from "./permission.decorator";

/**
 * 接口文档组合装饰器（**每个路由方法都要用其中一个**）
 *
 * 把「Swagger 分组 + 令牌要求 + 所需权限点」三件事收在一处，避免三类信息各写各的：
 * - `ApiPublicDoc`：公共接口（无令牌）
 * - `ApiPlayerDoc`：客户端接口（player 令牌）
 * - `ApiAdminDoc`：管理端接口（admin 令牌 + 权限点，文档里的「所需权限」由权限表反查生成）
 *
 * 这样新增接口时：分组、文档锁标识、权限声明一次到位，漏标权限点会立刻体现在文档上。
 * 权限的**实际校验**在 common/guards/permission.guard，与本装饰器同源（constants/permission）。
 */

interface ApiDocOptions {
  /** 一句话说明（文档列表里的标题） */
  summary: string;
  /** 补充说明（支持 markdown） */
  description?: string;
}

interface ApiAdminDocOptions extends ApiDocOptions {
  /** 所需权限点；不传表示「只操作当前登录管理员自身」的接口 */
  permissions?: PermissionValue[];
}

/** 把鉴权说明追加到业务说明后面（业务说明可以为空） */
function withAuthNote(description: string | undefined, note: string): string {
  return description ? `${description}\n\n---\n\n${note}` : note;
}

/** 公共接口：无需令牌 */
export function ApiPublicDoc(options: ApiDocOptions) {
  return applyDecorators(
    ApiTags(SWAGGER_TAGS.PUBLIC),
    ApiExtension("x-olua-audience", "public"),
    ApiOperation({
      summary: options.summary,
      description: withAuthNote(options.description, "**鉴权**：无需令牌，公开接口。"),
    }),
  );
}

/** 客户端接口：player 令牌 */
export function ApiPlayerDoc(options: ApiDocOptions) {
  return applyDecorators(
    ApiTags(SWAGGER_TAGS.PLAYER),
    ApiBearerAuth("player"),
    ApiExtension("x-olua-audience", "player"),
    ApiOperation({
      summary: options.summary,
      description: withAuthNote(options.description, "**鉴权**：客户端令牌（`player`），只能操作令牌所属账号自己的数据。"),
    }),
  );
}

/** 管理端接口：admin 令牌 +（可选）权限点（**同时**落成文档说明与运行时校验） */
export function ApiAdminDoc(options: ApiAdminDocOptions) {
  const permissions = options.permissions ?? [];
  const authNote = permissions.length
    ? [
        "**鉴权**：管理端令牌（`admin`）。",
        `**所需权限**：${permissions.map((item) => describePermission(item)).join("；")}`,
      ].join("\n\n")
    : "**鉴权**：管理端令牌（`admin`）；本接口只操作当前登录管理员自身，不需要额外权限点。";

  return applyDecorators(
    ApiTags(SWAGGER_TAGS.ADMIN),
    ApiBearerAuth("admin"),
    // 文档里画的权限点与守卫真实读的是**同一份**元数据，不会出现「文档写了但没拦」
    RequirePermissions(...permissions),
    ApiExtension("x-olua-audience", "admin"),
    ApiExtension("x-olua-permissions", permissions),
    ApiOperation({
      summary: options.summary,
      description: withAuthNote(options.description, authNote),
    }),
  );
}
