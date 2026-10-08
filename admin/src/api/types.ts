/** 统一响应包裹（与服务端 common/interfaces/api-envelope.interface 一一对应） */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: number;
  path?: string;
}

/** 分页结果 */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

/** 业务码（与服务端 common/constants/biz-code.ts 对应，只列管理端会用到的） */
export const BIZ_CODE = {
  OK: 0,
  /** 管理员账号已停用 */
  ADMIN_DISABLED: 30005,
  /** 令牌有效但角色没有该接口要求的权限点 */
  ADMIN_PERMISSION_DENIED: 30006,
  /** 保护性拒绝（如最后一个超级管理员不能降级） */
  ADMIN_PROTECTED: 30007,
  /** 未登录（缺令牌） */
  UNAUTHORIZED: 40100,
  /** 令牌非法 */
  TOKEN_INVALID: 40101,
  /** 令牌过期 */
  TOKEN_EXPIRED: 40102,
} as const;

/** 命中这些业务码 → 清会话并回登录页 */
export const RELOGIN_CODES: readonly number[] = [BIZ_CODE.UNAUTHORIZED, BIZ_CODE.TOKEN_INVALID, BIZ_CODE.TOKEN_EXPIRED, BIZ_CODE.ADMIN_DISABLED];

/**
 * 请求错误
 *
 * 统一把「网络失败 / HTTP 非 2xx / 业务码非 0」三种情况归一成它，
 * 于是页面上只写 `catch (error) { showError(error) }` 一种处理。
 */
export class ApiError extends Error {
  /** 业务码（网络层失败时为 -1） */
  readonly code: number;
  /** HTTP 状态码（网络层失败时为 0） */
  readonly status: number;

  constructor(message: string, code = -1, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }

  /** 是否需要重新登录 */
  get needRelogin(): boolean {
    return this.status === 401 || RELOGIN_CODES.includes(this.code);
  }
}

//#region 业务实体（字段与服务端 DTO 一致）

export interface AdminInfo {
  id: string;
  username: string;
  status: string;
  /** super_admin / admin / viewer */
  role: string;
  /** 角色中文名 */
  roleLabel: string;
  /** 权限点清单（服务端权限表的副本，界面据此显隐；服务端仍会独立校验） */
  permissions: string[];
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AdminAuthResult {
  token: string;
  expiresIn: string;
  admin: AdminInfo;
}

export interface Account {
  id: string;
  username: string;
  /** active 正常 / disabled 封禁 */
  status: string;
  onlineRoleId: string | null;
  roleCount?: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface RoleSummary {
  id: string;
  accountId: string;
  name: string;
  occupation: string;
  sex: string;
  level: number;
  online: boolean;
  /** 修订号（每次落库 +1；玩家推进度时用它做乐观锁，管理端只展示） */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** 角色完整信息（data 是客户端 entities/Role 的快照） */
export interface AdminRole extends RoleSummary {
  accountName: string | null;
  data: Record<string, unknown>;
}

export interface AccountDetail {
  account: Account;
  roles: RoleSummary[];
}

export interface AdminStats {
  accountCount: number;
  roleCount: number;
  onlineAccountCount: number;
  todayNewAccountCount: number;
  adminCount: number;
}

/**
 * 管理端可编辑的角色字段（与服务端 AdminPatchRoleDto 一致）
 *
 * 分成三组：基础信息 / 常用数值 / 运行时数据（结构化）。
 * 保存时只提交改动过的字段（见 RoleDetailPage.buildPatch），避免把并发改动覆盖掉。
 */
export interface RolePatchPayload {
  // 基础信息
  name?: string;
  occupation?: string;
  sex?: string;
  level?: number;
  /** 时装（外观）id；null = 取消时装 */
  fashionCloth?: number | null;
  avatar?: number;
  /** 所在地图 id（客户端 configs/map 的 key） */
  onMap?: string;
  // 常用数值
  gold?: number;
  bindGold?: number;
  silver?: number;
  exp?: number;
  soulOfWar?: number;
  title?: number;
  rank?: number;
  // 运行时数据（结构化）
  /** 装备穿戴表：槽位名 → 装备 id（null 表示该槽位空着） */
  equipments?: Record<string, string | null>;
  /** 技能等级表：技能 id → 等级 */
  skills?: Record<string, number>;
  /** 背包格子（稀疏：只报有东西的格子）；空数组 = 清空背包 */
  bag?: RoleBagCell[];
}

/** 背包里的一个格子（服务端 RoleBagCellDto） */
export interface RoleBagCell {
  row: number;
  col: number;
  id: string;
  count: number;
}

/**
 * 角色列表筛选条件（与服务端 RoleQueryDto 一致）
 *
 * 刻意写成 type 而不是 interface：请求层的 query 参数类型是个 Record，
 * 只有对象**类型别名**才会被推断出隐式索引签名（interface 不会，赋值时会报「缺少索引签名」）。
 */
export type RoleListQuery = {
  page?: number;
  size?: number;
  /** 同时匹配角色名与角色 id */
  keyword?: string;
  accountId?: string;
  /** "true" 只看在线（账号当前选中的）角色；"false" 只看离线 */
  online?: string;
  occupation?: string;
  sex?: string;
  minLevel?: number;
  maxLevel?: number;
};

/** 批量删除 / 清空角色 的结果 */
export interface BatchDeleteResult {
  requested: number;
  deleted: number;
  ids: string[];
  clearedOnlineAccountIds: string[];
}

/** 管理端改管理员（改角色 / 启停；仅 admin:manage 可调） */
export interface AdminUpdatePayload {
  role?: string;
  status?: string;
}

//#endregion

//#region 权限（与服务端 common/constants/permission.ts 一一对应）

/**
 * 权限点
 *
 * 「界面按权限显隐」只是体验，**服务端才是权威**：即使按钮被强行点出来，
 * 请求也会被 PermissionGuard 拦成 403 / 30006。
 */
export const PERMISSION = {
  STATS_READ: "stats:read",
  ACCOUNT_READ: "account:read",
  ACCOUNT_STATUS: "account:status",
  ACCOUNT_DELETE: "account:delete",
  ROLE_READ: "role:read",
  ROLE_WRITE: "role:write",
  ROLE_SELECT: "role:select",
  ROLE_DELETE: "role:delete",
  ADMIN_READ: "admin:read",
  ADMIN_MANAGE: "admin:manage",
} as const;

export type PermissionValue = (typeof PERMISSION)[keyof typeof PERMISSION];

/** 管理员角色 */
export const ADMIN_ROLE = {
  SUPER: "super_admin",
  ADMIN: "admin",
  VIEWER: "viewer",
} as const;

export const ADMIN_ROLE_LABELS: Record<string, string> = {
  [ADMIN_ROLE.SUPER]: "超级管理员",
  [ADMIN_ROLE.ADMIN]: "管理员",
  [ADMIN_ROLE.VIEWER]: "只读观察员",
};

/** 角色中文名（未知角色原样显示） */
export function adminRoleLabel(role: string): string {
  return ADMIN_ROLE_LABELS[role] ?? role;
}

//#endregion

//#region 展示用的字典

export const OCCUPATION_LABELS: Record<string, string> = { "1": "战士", "2": "魔法师", "3": "道士", "4": "全职业" };
export const SEX_LABELS: Record<string, string> = { "1": "男", "2": "女", "3": "全性别" };

/**
 * 背包格子的行 / 列上限（与服务端 role-data.util.ROLE_BAG_AXIS_MAX 一致）
 *
 * 界面用它做输入约束（只是体验，服务端才是权威）。
 */
export const ROLE_BAG_AXIS_MAX = 64;

/** 时间戳 → 本地时间文本（空值显示 —） */
export function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

//#endregion
