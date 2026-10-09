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
  /** 玩家登录失败次数过多（用户名或来源 IP 被临时锁定） */
  LOGIN_LOCKED: 10005,
  /** 角色已被管理员下线，需要重新选择角色进入游戏 */
  ROLE_KICKED: 20007,
  /** 管理员账号已停用 */
  ADMIN_DISABLED: 30005,
  /** 令牌有效但角色没有该接口要求的权限点 */
  ADMIN_PERMISSION_DENIED: 30006,
  /** 保护性拒绝（如最后一个超级管理员不能降级） */
  ADMIN_PROTECTED: 30007,
  /** 管理员登录失败次数过多（用户名或来源 IP 被临时锁定） */
  ADMIN_LOGIN_LOCKED: 30009,
  /** 改密码时原密码不正确 */
  ADMIN_OLD_PASSWORD_WRONG: 30010,
  /** 新密码与原密码相同 */
  ADMIN_PASSWORD_SAME: 30011,
  /** 未登录（缺令牌） */
  UNAUTHORIZED: 40100,
  /** 令牌非法 */
  TOKEN_INVALID: 40101,
  /** 令牌过期 */
  TOKEN_EXPIRED: 40102,
  /** 令牌已被主动作废（口令被重置 / 修改后，此前签发的令牌全部失效） */
  TOKEN_REVOKED: 40103,
} as const;

/**
 * 命中这些业务码 → 清会话并回登录页
 *
 * `TOKEN_REVOKED` 也必须在这里：超管把某个管理员的密码重置之后，那位管理员手里的
 * 旧令牌当场失效，他下一次点任何东西都应该被送回登录页，而不是看到一个「莫名的失败」。
 */
export const RELOGIN_CODES: readonly number[] = [
  BIZ_CODE.UNAUTHORIZED,
  BIZ_CODE.TOKEN_INVALID,
  BIZ_CODE.TOKEN_EXPIRED,
  BIZ_CODE.TOKEN_REVOKED,
  BIZ_CODE.ADMIN_DISABLED,
];

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
  /** 重置玩家密码（改口令，会让玩家现有令牌失效） */
  ACCOUNT_PASSWORD: "account:password",
  ROLE_READ: "role:read",
  ROLE_WRITE: "role:write",
  ROLE_SELECT: "role:select",
  ROLE_DELETE: "role:delete",
  ADMIN_READ: "admin:read",
  ADMIN_MANAGE: "admin:manage",
  /** 查看操作日志（只读观察员没有这一项） */
  AUDIT_READ: "audit:read",
} as const;

export type PermissionValue = (typeof PERMISSION)[keyof typeof PERMISSION];

/** 权限点中文名（与服务端 common/constants/permission.ts 的 PERMISSION_LABELS 一一对应） */
export const PERMISSION_LABELS: Record<string, string> = {
  [PERMISSION.STATS_READ]: "查看概览",
  [PERMISSION.ACCOUNT_READ]: "查看账号",
  [PERMISSION.ACCOUNT_STATUS]: "封禁 / 解封账号",
  [PERMISSION.ACCOUNT_PASSWORD]: "重置玩家密码",
  [PERMISSION.ACCOUNT_DELETE]: "删除账号",
  [PERMISSION.ROLE_READ]: "查看角色",
  [PERMISSION.ROLE_WRITE]: "修改角色",
  [PERMISSION.ROLE_SELECT]: "切换在线角色",
  [PERMISSION.ROLE_DELETE]: "删除角色",
  [PERMISSION.ADMIN_READ]: "查看管理员",
  [PERMISSION.ADMIN_MANAGE]: "管理管理员",
  [PERMISSION.AUDIT_READ]: "查看操作日志",
};

/** 权限点中文名（未登记的原样显示） */
export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

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

/** 口令长度约束（与服务端 modules/admin/dto/password.dto 一致；界面预校验用，服务端才是权威） */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 32;

/** 时间戳 → 本地时间文本（空值显示 —） */
export function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时间戳 → 本地时间文本（到秒）。操作日志要按秒看顺序，故不复用上面那个到分的版本 */
export function formatTimeFull(value: number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${formatTime(value)}:${pad(date.getSeconds())}`;
}

/** 时间戳 → `<input type="datetime-local">` 的值（本地时区，空值给空串） */
export function msToLocalInput(value: number | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `<input type="datetime-local">` 的值 → 毫秒时间戳（空串或非法值给 undefined） */
export function localInputToMs(text: string): number | undefined {
  if (!text) return undefined;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

//#endregion

//#region 封禁（原因 / 时长 / 到期）

/** 封禁时长快选；`null` = 永久。界面只做快选，服务端接收任意 1~8760 的整数小时 */
export const BAN_DURATION_PRESETS: readonly { hours: number | null; label: string }[] = [
  { hours: 1, label: "1 小时" },
  { hours: 6, label: "6 小时" },
  { hours: 24, label: "1 天" },
  { hours: 72, label: "3 天" },
  { hours: 168, label: "7 天" },
  { hours: 720, label: "30 天" },
  { hours: null, label: "永久" },
];

/** 封禁原因长度上限（与服务端 dto/query.dto 的 UpdateAccountStatusDto 一致） */
export const BAN_REASON_MAX_LENGTH = 100;

/** 封禁时长上限（小时，一年）—— 与服务端 BAN_DURATION_MAX_HOURS 同口径 */
export const BAN_DURATION_MAX_HOURS = 24 * 365;

/** 毫秒时长 → 人话（口径与后端 humanizeDuration 一致：已经有「天」就不报分钟） */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} 分钟`);
  return parts.join(" ") || "1 分钟";
}

/**
 * 封禁的展示状态
 *
 * **不能只看 `status`**：后端为了让「到期自动解封」不依赖定时器，判定一律按时间算，
 * 于是库里可能出现 `status = disabled` 而 `banUntil` 已经过去的情况（定时器最多晚一分钟扫到）。
 * 那种账号现在就能登录 —— 界面必须用与后端同一套判据，否则会把一个能玩的号显示成封禁中。
 */
export function banStateOf(
  account: { status: string; banUntil: number | null },
  now: number = Date.now(),
): { banned: boolean; expired: boolean; text: string } {
  if (account.status !== "disabled") return { banned: false, expired: false, text: "正常" };
  if (account.banUntil !== null && account.banUntil <= now) return { banned: false, expired: true, text: "封禁已到期" };
  if (account.banUntil === null) return { banned: true, expired: false, text: "永久封禁" };
  return { banned: true, expired: false, text: `封禁中 · 剩余 ${formatDuration(account.banUntil - now)}` };
}

//#endregion

//#region 操作日志的展示字典

/** 审计目标类型中文名 */
export const AUDIT_TARGET_LABELS: Record<string, string> = {
  account: "玩家账号",
  role: "角色",
  admin: "管理员",
};

/** 目标类型中文名（未知类型原样显示） */
export function auditTargetLabel(type: string | null | undefined): string {
  if (!type) return "—";
  return AUDIT_TARGET_LABELS[type] ?? type;
}

/**
 * 动作中文名
 *
 * 键 = 接口的 `operationId`（审计日志里的 action 就是它，两处永远是同一个字符串）。
 * 这里只做**展示**：界面上的「动作」下拉是从 `/admin/audit-logs/actions` 拉的，
 * 出现没登记过的动作时原样显示标识符，不影响任何逻辑。
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.register": "玩家注册",
  "auth.login": "玩家登录",
  "adminAuth.register": "管理员注册",
  "adminAuth.login": "管理员登录",
  "adminAuth.changePassword": "管理员改密（自己）",
  "adminAccount.updateStatus": "封禁 / 解封玩家账号",
  "adminAccount.remove": "删除玩家账号",
  "adminAccount.purgeRoles": "清空账号角色",
  "adminAccount.resetPassword": "重置玩家密码",
  "adminAccount.kick": "把玩家踢下线",
  "adminAdmin.update": "修改管理员（角色 / 启停）",
  "adminAdmin.remove": "删除管理员",
  "adminAdmin.resetPassword": "重置管理员密码",
  "adminRole.patch": "修改角色",
  "adminRole.remove": "删除角色",
  "adminRole.batchRemove": "批量删除角色",
  "adminRole.select": "设为在线角色",
  "role.create": "创建角色",
  "role.save": "保存角色进度",
  "role.remove": "删除角色",
  "role.select": "选择角色（进游戏）",
};

/** 动作中文名（未登记的原样返回标识符） */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

//#endregion
