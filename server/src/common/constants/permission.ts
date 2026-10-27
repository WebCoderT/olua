/**
 * 管理端权限点 + 管理员角色（**唯一来源**）
 *
 * 服务端的权限模型分两层，缺一不可：
 * 1. **受众（audience）**：`player` / `admin` 两套令牌 —— 解决「谁能进这扇门」，
 *    见 common/guards/auth.guard。玩家令牌连管理端接口都进不来。
 * 2. **权限点（permission）**：管理员内部「进门之后能干什么」——
 *    只读观察员能看数据但不能封号，就是这一层在管，见 common/guards/permission.guard。
 *
 * 新增管理端接口时：先在这里加权限点 → 再在控制器上 `@RequirePermissions(Xxx)`，
 * 然后**决定哪些角色该有这个点**（只改 ROLE_PERMISSIONS，不要在业务里写角色判断）。
 * 文档上的「所需权限」由装饰器自动从这张表反查角色，不会与实现漂移。
 */

/** 权限点（`资源:动作` 命名；值即对外暴露的字符串） */
export const Permission = {
  /** 查看概览统计 */
  STATS_READ: "stats:read",

  /** 查看账号列表 / 详情 */
  ACCOUNT_READ: "account:read",
  /** 封禁 / 解封账号 */
  ACCOUNT_STATUS: "account:status",
  /**
   * 重置玩家账号的密码
   *
   * 单独一个权限点（而不是并进 account:status）：这是能**接管他人账号**的操作，
   * 敏感度高于封禁，值得让「谁能做」单独可调。
   */
  ACCOUNT_PASSWORD: "account:password",
  /** 删除账号（级联删角色，不可恢复） */
  ACCOUNT_DELETE: "account:delete",
  /**
   * 补录 / 查看玩家邮箱
   *
   * 单独一个权限点（而不是并进 `account:read`）：邮箱是**个人信息**，
   * 给了只读观察员 `account:read` 不代表该让他看到一串玩家联系方式。
   * 补录与查看共用这一个权限点 —— 能改就能看（ADMIN / SUPER 持有，VIEWER 不持有）。
   */
  ACCOUNT_EMAIL: "account:email",

  /** 查看角色列表 / 详情（含完整 data） */
  ROLE_READ: "role:read",
  /** 修改角色属性（等级 / 金币 / 经验 / 战魂 / 称号 / 军衔…） */
  ROLE_WRITE: "role:write",
  /** 切换账号的在线角色 */
  ROLE_SELECT: "role:select",
  /** 删除角色 */
  ROLE_DELETE: "role:delete",

  /**
   * 查看公告列表
   *
   * 观察员也给：公告是**面向全服的公开内容**，读了不等于能改，
   * 与「审计日志 / 系统信息」那种会暴露人与部署形态的数据不同。
   */
  ANNOUNCEMENT_READ: "announcement:read",
  /** 发布 / 编辑 / 删除公告（会直接推送给全服玩家，属于对外发声，单列一个权限点） */
  ANNOUNCEMENT_WRITE: "announcement:write",

  /**
   * 查看邮件投递记录
   *
   * 与公告的 `announcement:read` **不同，观察员不给**：投递记录里有玩家的**邮箱地址**
   * （个人信息），而公告是面向全服的公开内容。观察员的定位是看业务数据，
   * 不该顺手拿到一份可导出的玩家联系方式。
   *
   * 这条界线写在注释里是因为它看起来「只是又一个读权限」，很容易顺手加进 viewer。
   */
  MAIL_READ: "mail:read",
  /** 发送邮件（对外投递，可能触达真实用户，与公告同级：写操作单列） */
  MAIL_WRITE: "mail:write",

  /** 查看管理员列表 */
  ADMIN_READ: "admin:read",
  /** 管理管理员（改角色 / 启停 / 删除 / 重置密码） */
  ADMIN_MANAGE: "admin:manage",

  /**
   * 查看操作日志
   *
   * 审计日志会暴露「谁做了什么」，因此只读观察员不给（它的定位是看数据，不是查人）。
   */
  AUDIT_READ: "audit:read",

  /**
   * 查看系统信息（版本 / 运行时长 / 数据库体积与行数 / 脱敏配置快照）
   *
   * 同样不给只读观察员：这一页暴露部署形态（数据文件路径、限流与保留策略的具体阈值），
   * 是运维信息而不是业务数据。快照本身走**白名单**，密钥类只报「已配置 / 未配置」。
   */
  SYSTEM_READ: "system:read",

  /**
   * 查看养成配置（称号 / 战魂的等级序列、属性与价格）
   *
   * 与公告同级给观察员：配置表是**业务数据**（玩家看到的一切数值都出自这里），
   * 读了不等于能改 —— 改动走 `gameConfig:write` 单独管控。
   */
  GAME_CONFIG_READ: "gameConfig:read",
  /**
   * 修改养成配置（称号渠道与升级价格 / 战魂消耗 / 双方属性数值）
   *
   * 这份配置**直接决定玩家侧数值**（战斗属性、升级开销），改错一行全服生效，
   * 与 `role:write`（改一个角色）不同量级，单列一个权限点。
   */
  GAME_CONFIG_WRITE: "gameConfig:write",

  /**
   * 查看区服列表
   *
   * 与公告同级给观察员：区服清单是业务数据（玩家注册时选的就是它），
   * 读了不等于能改 —— 开区 / 合并走 `zone:write` 单独管控。
   */
  ZONE_READ: "zone:read",
  /**
   * 开新区 / 合并区
   *
   * 合并区会**整体搬迁玩家数据**（账号换区、世界实例改牌），执行后玩家无感但数据
   * 面目全非，误操作的代价高 —— 与 `account:delete` 同量级，单列一个权限点。
   */
  ZONE_WRITE: "zone:write",

  /**
   * 查看帮会列表 / 成员 / 申请（#388）
   *
   * 与区服同级给观察员：帮会是**玩家自己组织出来的公开信息**（谁在哪个帮、多少人），
   * 读了不等于能改 —— 改公告与解散走 `guild:write`。
   */
  GUILD_READ: "guild:read",
  /**
   * 改帮会公告 / 强制解散帮会（#388）
   *
   * 解散会**抹掉一整群人的组织关系**（成员表连删），误操作代价与删账号同量级，
   * 单列一个权限点，只给管理员及以上。
   */
  GUILD_WRITE: "guild:write",

  /**
   * 查看玩家举报（#398）
   *
   * **不给只读观察员**：举报里有「谁指控谁」与具体描述（玩家之间的冲突），
   * 与邮件投递记录里的邮箱同属个人信息一档 —— 观察员的定位是看业务数据，不是查人。
   * 这一刀只有读（没有处置写接口），所以也只加一个点。
   */
  REPORT_READ: "report:read",
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

/** 全部权限点（超级管理员 = 全给，别手抄一份） */
export const ALL_PERMISSIONS: PermissionValue[] = Object.values(Permission);

/**
 * 管理员角色（**身份角色**，与游戏角色 AdminRoleDto 无关）
 *
 * 分三级：超级管理员（能管管理员）/ 管理员（能管玩家数据）/ 只读观察员（只能看）。
 */
export const AdminRole = {
  SUPER: "super_admin",
  ADMIN: "admin",
  VIEWER: "viewer",
} as const;

export type AdminRoleValue = (typeof AdminRole)[keyof typeof AdminRole];

/** 全部管理员角色（注册校验、DTO 枚举都用它） */
export const ADMIN_ROLES: AdminRoleValue[] = Object.values(AdminRole);

/** 角色 → 权限点映射（**唯一来源**；改权限只改这里） */
export const ROLE_PERMISSIONS: Record<AdminRoleValue, PermissionValue[]> = {
  /** 超级管理员：全部权限 */
  [AdminRole.SUPER]: ALL_PERMISSIONS,
  /** 管理员：除「管理管理员」外全部 —— 管理员之间不能互相提权 */
  [AdminRole.ADMIN]: ALL_PERMISSIONS.filter((item) => item !== Permission.ADMIN_MANAGE),
  /** 只读观察员：读权限，任何写操作都不行 */
  [AdminRole.VIEWER]: [
    Permission.STATS_READ,
    Permission.ACCOUNT_READ,
    Permission.ROLE_READ,
    Permission.ANNOUNCEMENT_READ,
    Permission.GAME_CONFIG_READ,
    Permission.ZONE_READ,
    Permission.GUILD_READ,
  ],
};

/** 中文名（管理端界面与文档都用它） */
export const ADMIN_ROLE_LABELS: Record<AdminRoleValue, string> = {
  [AdminRole.SUPER]: "超级管理员",
  [AdminRole.ADMIN]: "管理员",
  [AdminRole.VIEWER]: "只读观察员",
};

/** 权限点中文名（文档与管理端展示用） */
export const PERMISSION_LABELS: Record<PermissionValue, string> = {
  [Permission.STATS_READ]: "查看概览",
  [Permission.ACCOUNT_READ]: "查看账号",
  [Permission.ACCOUNT_STATUS]: "封禁 / 解封账号",
  [Permission.ACCOUNT_PASSWORD]: "重置玩家密码",
  [Permission.ACCOUNT_DELETE]: "删除账号",
  [Permission.ACCOUNT_EMAIL]: "补录 / 查看玩家邮箱",
  [Permission.ROLE_READ]: "查看角色",
  [Permission.ROLE_WRITE]: "修改角色",
  [Permission.ROLE_SELECT]: "切换在线角色",
  [Permission.ROLE_DELETE]: "删除角色",
  [Permission.ANNOUNCEMENT_READ]: "查看公告",
  [Permission.ANNOUNCEMENT_WRITE]: "发布 / 编辑公告",
  [Permission.MAIL_READ]: "查看邮件投递记录",
  [Permission.MAIL_WRITE]: "发送邮件",
  [Permission.ADMIN_READ]: "查看管理员",
  [Permission.ADMIN_MANAGE]: "管理管理员",
  [Permission.AUDIT_READ]: "查看操作日志",
  [Permission.SYSTEM_READ]: "查看系统信息",
  [Permission.GAME_CONFIG_READ]: "查看养成配置",
  [Permission.GAME_CONFIG_WRITE]: "修改养成配置",
  [Permission.ZONE_READ]: "查看区服",
  [Permission.ZONE_WRITE]: "开区 / 合并区",
  [Permission.GUILD_READ]: "查看帮会",
  [Permission.GUILD_WRITE]: "改帮会公告 / 解散帮会",
  [Permission.REPORT_READ]: "查看玩家举报",
};

/** 是否是合法的管理员角色（注册入参 / 数据列兜底用） */
export function isAdminRole(value: unknown): value is AdminRoleValue {
  return typeof value === "string" && ADMIN_ROLES.includes(value as AdminRoleValue);
}

/**
 * 取某个角色拥有的权限点
 *
 * 未知 / 空角色返回**空数组**（最小权限原则）：数据里出现脏角色时，
 * 宁可让人进不去，也不能因为认不出角色就默认放行。
 */
export function permissionsOfRole(role: string | null | undefined): PermissionValue[] {
  if (!isAdminRole(role)) return [];
  return ROLE_PERMISSIONS[role];
}

/** 判断角色是否拥有某权限点 */
export function roleHasPermission(role: string | null | undefined, permission: PermissionValue): boolean {
  return permissionsOfRole(role).includes(permission);
}

/** 反查「哪些角色拥有该权限点」（文档里自动写出来，不手抄） */
export function rolesWithPermission(permission: PermissionValue): AdminRoleValue[] {
  return ADMIN_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/** 权限点的中文描述（文档用）：`account:write（修改角色；角色：管理员 / 超级管理员）` */
export function describePermission(permission: PermissionValue): string {
  const roles = rolesWithPermission(permission)
    .map((role) => ADMIN_ROLE_LABELS[role])
    .join(" / ");
  return `\`${permission}\`（${PERMISSION_LABELS[permission]}；角色：${roles}）`;
}
