import { AdminRoleValue } from "../constants/permission";

/** 调用方类型：玩家（客户端） / 管理员（管理端） */
export type Audience = "player" | "admin";

/**
 * 统一响应包裹（**所有**接口无论成功失败都是这个形状）
 *
 * 客户端与管理端的请求层据此做「二次封装」：解包 data、按 code 判定成败、
 * 401 系列统一跳登录 —— 因为形状唯一，业务层不必各自处理 HTTP 细节。
 */
export interface ApiEnvelope<T> {
  /** 业务码，0 = 成功（见 common/constants/biz-code） */
  code: number;
  /** 面向调用方的提示信息（可安全直接展示） */
  message: string;
  /** 业务数据；无数据时为 null */
  data: T;
  /** 服务端时间戳（毫秒） */
  timestamp: number;
  /** 出错时的请求路径（排查用） */
  path?: string;
}

/** 分页结果（列表接口统一用它，避免每个接口各造一套字段名） */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

/** 登录成功后返回给调用方的身份信息 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  kind: Audience;
  /**
   * 管理员角色（仅 kind = "admin" 时有值）
   *
   * 由 AuthGuard 查库后填入，PermissionGuard 据此判权 —— 所以管理员的角色变更
   * 与封禁一样是「下一次请求立即生效」，不用等令牌过期。
   */
  role?: AdminRoleValue;
}

/** JWT 载荷（aud 区分玩家 / 管理员，两种令牌不能互相冒用） */
export interface JwtPayload {
  /** 主体 id（账号 id 或管理员 id） */
  sub: string;
  /** 用户名 */
  username: string;
  /** 受众（player / admin） */
  aud: Audience;
  iat?: number;
  exp?: number;
}
