/**
 * 业务码（响应体 code 字段）
 *
 * 约定：0 = 成功；其余按模块分段（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用）。
 * HTTP 状态码照旧语义化，code 只表达「业务上发生了什么」，客户端据 code 决定提示与分支。
 */
export const BizCode = {
  /** 成功 */
  OK: 0,

  //#region 通用
  /** 参数校验不通过 */
  PARAM_INVALID: 40000,
  /** 未登录 / 缺少令牌 */
  UNAUTHORIZED: 40100,
  /** 令牌非法 */
  TOKEN_INVALID: 40101,
  /** 令牌过期 */
  TOKEN_EXPIRED: 40102,
  /** 无权访问该资源 */
  FORBIDDEN: 40300,
  /** 资源不存在 */
  NOT_FOUND: 40400,
  /** 与现有数据冲突 */
  CONFLICT: 40900,
  /** 服务器内部错误 */
  INTERNAL: 50000,

  //#region 账号
  /** 账号已存在 */
  ACCOUNT_EXISTS: 10001,
  /** 账号不存在 */
  ACCOUNT_NOT_FOUND: 10002,
  /** 密码错误 */
  PASSWORD_WRONG: 10003,
  /** 账号已被封禁 */
  ACCOUNT_DISABLED: 10004,

  //#region 角色
  /** 角色数量已达上限 */
  ROLE_LIMIT: 20001,
  /** 角色不存在 */
  ROLE_NOT_FOUND: 20002,
  /** 角色数据不合法 */
  ROLE_DATA_INVALID: 20003,
  /** 角色 id 已存在 */
  ROLE_ID_EXISTS: 20004,
  /** 同一账号下角色重名 */
  ROLE_NAME_EXISTS: 20005,
  /**
   * 角色已被别处修改（乐观锁冲突）
   *
   * 客户端推送进度时带的 revision 与服务端当前值不一致 —— 典型场景是玩家在游戏里，
   * 管理员在后台改了这个角色。客户端收到它应当**拉取最新数据后再继续**，
   * 而不是拿本地旧数据覆盖（否则后台的改动会被玩家的下一次同步抹掉）。
   */
  ROLE_REVISION_CONFLICT: 20006,

  //#region 管理端
  /** 管理员账号已存在 */
  ADMIN_EXISTS: 30001,
  /** 管理员不存在 */
  ADMIN_NOT_FOUND: 30002,
  /** 管理员密码错误 */
  ADMIN_PASSWORD_WRONG: 30003,
  /** 管理端注册码错误 */
  ADMIN_REGISTER_CODE_WRONG: 30004,
  /** 管理员账号已停用 */
  ADMIN_DISABLED: 30005,
  /** 管理员权限不足（令牌有效，但角色没有该接口要求的权限点） */
  ADMIN_PERMISSION_DENIED: 30006,
  /** 保护性拒绝（如把最后一个超级管理员降级 / 停用） */
  ADMIN_PROTECTED: 30007,
  /** 管理员角色不合法 */
  ADMIN_ROLE_INVALID: 30008,
} as const;

export type BizCodeValue = (typeof BizCode)[keyof typeof BizCode];
