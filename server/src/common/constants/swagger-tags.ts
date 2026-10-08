/**
 * Swagger 分组（**唯一来源**）
 *
 * 文档按「谁能调」分三组，与守卫的两层权限模型一一对应：
 * - 公共接口：不带令牌也能调（注册 / 登录 / 健康检查）
 * - 客户端：要 `player` 令牌，只能读写**自己账号**的数据
 * - 管理端：要 `admin` 令牌，且每个接口还各自要求权限点（见 constants/permission）
 *
 * 控制器不再用类级 `@ApiTags`：一个类里常常既有公共接口（register/login）又有需登录接口（me），
 * 类级 tag 会把方法钉死在一组里。统一走 `common/decorators/api-doc.decorator` 的组合装饰器，
 * 由它同时给出「分组 + 令牌 + 权限点」，保证三者不会各写各的。
 */
export const SWAGGER_TAGS = {
  PUBLIC: "公共接口",
  PLAYER: "客户端",
  ADMIN: "管理端",
} as const;

export type SwaggerTag = (typeof SWAGGER_TAGS)[keyof typeof SWAGGER_TAGS];

/** 分组定义（`addTag` 的声明顺序即文档里的展示顺序：公共 → 客户端 → 管理端） */
export const SWAGGER_TAG_DEFINITIONS: { name: SwaggerTag; description: string }[] = [
  {
    name: SWAGGER_TAGS.PUBLIC,
    description: "无需令牌：注册、登录、健康检查。任何人都可以调用。",
  },
  {
    name: SWAGGER_TAGS.PLAYER,
    description: [
      "需要**客户端令牌**（`player`）。",
      "在 `POST /auth/login` 或 `POST /auth/register` 拿到，请求头 `Authorization: Bearer <token>`。",
      "只能操作令牌所属账号自己的数据 —— 接口路径里没有 accountId，改 id 也动不了别人的角色。",
    ].join("\n\n"),
  },
  {
    name: SWAGGER_TAGS.ADMIN,
    description: [
      "需要**管理端令牌**（`admin`）。在 `POST /admin/auth/login` 拿到。",
      "两层校验：① 令牌受众必须是 admin（玩家令牌一律 401）；",
      "② 每个接口还要求一个权限点，由管理员角色决定 —— 见每个接口说明里的「所需权限」。",
      "角色：超级管理员（全部权限）/ 管理员（除「管理管理员」外全部）/ 只读观察员（只能查看）。",
    ].join("\n\n"),
  },
];
