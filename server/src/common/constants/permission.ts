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

  /** 查看角色列表 / 详情（含完整 data） */
  ROLE_READ: "role:read",
  /** 修改角色属性（等级 / 金币 / 经验 / 战魂 / 称号 / 军衔…） */
  ROLE_WRITE: "role:write",
  /** 切换账号的在线角色 */
  ROLE_SELECT: "role:select",
  /** 删除角色 */
  ROLE_DELETE: "role:delete",

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
  /** 只读观察员：三个读权限，任何写操作都不行 */
  [AdminRole.VIEWER]: [Permission.STATS_READ, Permission.ACCOUNT_READ, Permission.ROLE_READ],
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
  [Permission.ROLE_READ]: "查看角色",
  [Permission.ROLE_WRITE]: "修改角色",
  [Permission.ROLE_SELECT]: "切换在线角色",
  [Permission.ROLE_DELETE]: "删除角色",
  [Permission.ADMIN_READ]: "查看管理员",
  [Permission.ADMIN_MANAGE]: "管理管理员",
  [Permission.AUDIT_READ]: "查看操作日志",
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
