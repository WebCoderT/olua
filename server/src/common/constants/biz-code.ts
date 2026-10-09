/**
 * 业务码（响应体 code 字段）
 *
 * 约定：0 = 成功；其余按模块分段（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用 / 5xxxx 公告）。
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
  /**
   * 令牌已被主动作废（口令被重置 / 修改后重新签发）
   *
   * 令牌是无状态的，光改密码不会让已签发的旧令牌失效 —— 所以账号与管理员的表里各有
   * 一个 `token_version`，签发时写进载荷、每次请求回查库比对（见 AuthGuard）。
   * 收到这个码应当清掉本地令牌、回到登录界面（与 TOKEN_EXPIRED 同样处理）。
   */
  TOKEN_REVOKED: 40103,
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
  /** 登录失败次数过多，临时锁定（限流见 common/security/login-throttle.service） */
  LOGIN_LOCKED: 10005,
  /**
   * 本服已关闭新账号注册
   *
   * 与「账号已存在」区分开：前者是运营开关（不该提示玩家换个名字重试），
   * 后者是重名。客户端只需原样展示服务端文案。
   */
  REGISTER_CLOSED: 10006,

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
  /**
   * 角色已被管理员下线（不再是账号当前的在线角色）
   *
   * 管理员在后台「踢下线」后清掉 `accounts.online_role_id`，此时客户端手上那份存档
   * 就不该再写回来了 —— 否则踢了等于没踢（玩家本地缓存还在，会一直推进度）。
   * 客户端收到它应当提示并回到选角界面。
   */
  ROLE_KICKED: 20007,

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
  /** 管理端登录失败次数过多，临时锁定 */
  ADMIN_LOGIN_LOCKED: 30009,
  /** 管理员自助改密时原密码不正确 */
  ADMIN_OLD_PASSWORD_WRONG: 30010,
  /** 新密码与当前密码相同 */
  ADMIN_PASSWORD_SAME: 30011,
  /**
   * 管理端注册已关闭
   *
   * 与「注册码不正确」（30004）区分开：那个是「码填错了」，这个是「压根没开注册」——
   * 运维看到 30004 会去翻注册码，看到这个才会去改 `.env`。
   */
  ADMIN_REGISTER_CLOSED: 30012,

  //#region 公告
  /** 公告不存在（已被删，或 id 传错） */
  ANNOUNCEMENT_NOT_FOUND: 50001,
  /**
   * 公告生效时间窗不合法（结束时间不晚于开始时间）
   *
   * 单独给一个码而不是并进「参数校验不通过」（40000）：前者是**跨字段**的组合错误，
   * 管理端要能把它定位到「时间窗」这一组控件上，而不是丢一句泛泛的「参数不合法」。
   */
  ANNOUNCEMENT_TIME_RANGE_INVALID: 50002,

  //#region 邮件
  /**
   * 邮件通道未启用（SMTP 没配齐）
   *
   * 单独一个码而不是复用「服务不可用」：运维看到这个码要去配 `.env`，
   * 看到通用的 500 只会去翻日志。通道未启用是**配置问题**，接口要能把它
   * 说成人话给界面显示，而不是静默让邮件消失。
   */
  MAIL_DISABLED: 50003,
  /** 收件账号不存在（关联玩家时传了不存在的 accountId） */
  MAIL_ACCOUNT_NOT_FOUND: 50004,
  /** 收件邮箱缺失：既没传 `to`，账号上也没有邮箱 */
  MAIL_ADDRESS_MISSING: 50005,
  /** 模板不存在 */
  MAIL_TEMPLATE_NOT_FOUND: 50006,
  /** 模板必填变量缺失（宁可拒发，也不要发出「亲爱的 ，」这种信） */
  MAIL_VARIABLE_MISSING: 50007,
  /** 投递任务不存在 */
  MAIL_JOB_NOT_FOUND: 50008,
  /**
   * 重投的前提不满足（只有最终失败的任务能重投）
   *
   * 与 50008 分开：任务不存在是「id 传错了」，这个是「任务在，但当前状态不允许这个动作」。
   */
  MAIL_JOB_NOT_RETRYABLE: 50009,
} as const;

export type BizCodeValue = (typeof BizCode)[keyof typeof BizCode];
