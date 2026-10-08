/**
 * 接口层里**手写**的那部分：请求错误、业务码、权限点、展示字典
 *
 * 另一半（接口路径 / 接口方法 / 实体类型）由 `tools/gen-api.cjs` 从服务端 OpenAPI 文档生成：
 * - `./routes`     —— 路径表（唯一来源）
 * - `./endpoints`  —— 接口方法（authApi / accountsApi / adminsApi / rolesApi）
 * - `./models`     —— 实体类型（服务端 DTO 的镜像）
 *
 * 这里只放**服务端文档里没有的东西**：客户端的错误模型、业务码子集、权限点清单、中文展示字典。
 */

/** 统一响应包裹（与服务端 common/interfaces/api-envelope.interface 一一对应） */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: number;
  path?: string;
}

/**
 * 分页结果（与服务端的 `PageMetaDto` + list 结构一致）
 *
 * 服务端每个列表接口都有自己的分页 DTO（`AccountPage` / `AdminPage` / `AdminRolePage`），
 * 结构完全一致；这里留一个泛型别名，页面上写 `PageResult<Account>` 更省事。
 * 二者结构相同，可以互相赋值。
 */
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
