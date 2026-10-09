import { join } from "node:path";

/** 内置的开发用 JWT 密钥（生产必须换掉；唯一出现处，比较也只用 `jwtSecretIsDefault`） */
const DEFAULT_JWT_SECRET = "olua-dev-secret-please-change-me";

/**
 * 应用配置（**唯一来源**）
 *
 * 端口、数据文件、密钥、上限、跨域来源一律从这里取；
 * 代码里不允许出现这些值的字面量（自查见 tools/audit-api-hardcode.cjs）。
 * 取值优先级：环境变量 / .env 文件 → 这里的默认值。
 */
export interface AppConfiguration {
  /** 运行环境 */
  env: string;
  /** 监听端口 */
  port: number;
  /** 全局路由前缀 */
  apiPrefix: string;
  /** SQLite 数据文件路径（:memory: = 内存库） */
  dbPath: string;
  /** JWT 签名密钥 */
  jwtSecret: string;
  /**
   * JWT 密钥是否仍是内置默认值
   *
   * 单独留一个派生字段，是为了让「生产环境忘了改密钥」这件事**可被检查**：
   * 系统信息页据此报警，启动时也据此打一条警告（见 main.ts）。判据只能有一处，
   * 所以由这里算好，别处不许再拿默认值字符串比一次。
   */
  jwtSecretIsDefault: boolean;
  /** JWT 有效期 */
  jwtExpiresIn: string;
  /** 管理端注册码（空串 = 未配置；配了就必须带对码才能注册） */
  adminRegisterCode: string;
  /**
   * 是否允许**玩家**自助注册
   *
   * 默认开（单机 / 内测都靠它开号）。正式服往往要关掉（配合客户端隐藏注册入口），
   * 关掉后只有已注册账号能登录 —— 这是防批量刷号的第一道闸。
   */
  playerRegisterOpen: boolean;
  /**
   * 是否开放**管理端**自助注册（**只在未配置 `ADMIN_REGISTER_CODE` 时生效**）
   *
   * 默认**关**。原来的行为是「没配注册码 = 人人可注册」，而**第一个注册的管理员自动是超级管理员**
   * —— 一个忘记配注册码的公网部署，等于把后台拱手让人。所以默认值反过来：
   * 没配注册码就谁也不许注册，要用 `.env` 里显式打开（或干脆配一个注册码）。
   */
  adminRegisterOpen: boolean;
  /** 每个账号的角色上限 */
  roleMaxPerAccount: number;
  /** 允许的跨域来源（["*"] = 全部） */
  corsOrigins: string[];
  /** 是否打印详细日志 */
  logRequests: boolean;
  /**
   * 是否信任反向代理传来的客户端 IP（`X-Forwarded-For`）
   *
   * 生产环境挂在 Nginx / 网关后面时必须开（否则所有请求的来源 IP 都是代理的，
   * 登录限流会把全部玩家当成同一个人，一起锁死）；**直连暴露时不要开** ——
   * 开着等于允许调用方随便伪造 `X-Forwarded-For` 绕过 IP 限流。
   */
  trustProxy: boolean;
  /** 登录限流：同一用户名连续失败多少次锁定 */
  loginMaxFailures: number;
  /** 登录限流：用户名维度的锁定时长（毫秒） */
  loginLockMs: number;
  /** 登录限流：同一 IP 在窗口内失败多少次锁定 */
  loginIpMaxFailures: number;
  /** 登录限流：IP 维度的锁定时长（毫秒） */
  loginIpLockMs: number;
  /** 操作日志保留条数上限（超出后按时间清理最旧的；0 = 不清理） */
  auditLogMaxRows: number;
  /**
   * 操作日志保留天数（早于该天数的日志会被清理；0 = 不按时间清理）
   *
   * 与 `auditLogMaxRows` 是**两道各自独立**的闸：条数上限防「刷爆磁盘」，
   * 天数上限防「量不大但陈年堆积」（一个月只写几百条同样会越攒越多）。
   */
  auditRetentionDays: number;
  /** 一次最多导出多少条操作日志（防止一次「全部条件」导出把几万行塞进内存与响应体） */
  auditExportMaxRows: number;

  //#region 邮件通道
  /** SMTP 主机（空 = 未配置） */
  smtpHost: string;
  /** SMTP 端口 */
  smtpPort: number;
  /** 是否走 TLS（465 是隐式 TLS，587 是 STARTTLS） */
  smtpSecure: boolean;
  /** SMTP 账号 */
  smtpUser: string;
  /** SMTP 密码 / 授权码（**只在配置快照里以「已配置 / 未配置」形态出现**，从不回显原文） */
  smtpPass: string;
  /** 发件人地址（不配则回退到 SMTP 账号） */
  smtpFrom: string;
  /**
   * 邮件通道是否可用（**派生字段**：主机 / 账号 / 密码三者都非空才算配齐）
   *
   * 与「令牌是否仍是默认值」同理 —— 让「能不能发信」这件事**可被检查**且只有一处判据，
   * 别处不许再自己比一次空串。未启用时发信接口直接返回 50003，而不是静默吞掉邮件。
   */
  mailEnabled: boolean;
  /**
   * 发信器实现（**测试注入点**）
   *
   * - `smtp`（默认）：真发信
   * - `fake`：不发信，一律成功 —— e2e 用它验「队列流转到已发送」
   * - `fail`：不发信，一律失败 —— e2e 用它验「重试与用尽上限后标失败」
   *
   * 之所以做成配置而不是在代码里 new：e2e 是**独立进程**起服务，拿不到进程内的对象，
   * 只能靠环境变量把「外部边界」换成可替换实现（与客户端 net-sandbox 同一思路）。
   */
  mailTransport: string;
  /** 单封邮件的最大投递尝试次数（用尽后标为最终失败） */
  mailMaxAttempts: number;
  /** 重试退避基数（毫秒）：第 n 次失败后等待 `base * 2^(n-1)` */
  mailRetryBaseMs: number;
  /** 调度器扫描间隔（毫秒） */
  mailPollMs: number;
}

export default function configuration(): AppConfiguration {
  const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;
  const adminRegisterCode = process.env.ADMIN_REGISTER_CODE ?? "";
  return {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3100),
    apiPrefix: process.env.API_PREFIX ?? "api",
    dbPath: process.env.DB_PATH ?? join(process.cwd(), "data", "olua.db"),
    jwtSecret,
    jwtSecretIsDefault: jwtSecret === DEFAULT_JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
    adminRegisterCode,
    playerRegisterOpen: (process.env.PLAYER_REGISTER_OPEN ?? "true") === "true",
    adminRegisterOpen: (process.env.ADMIN_REGISTER_OPEN ?? "false") === "true",
    roleMaxPerAccount: Number(process.env.ROLE_MAX_PER_ACCOUNT ?? 3),
    corsOrigins: (process.env.CORS_ORIGINS ?? "*")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    logRequests: (process.env.LOG_REQUESTS ?? "true") === "true",
    trustProxy: (process.env.TRUST_PROXY ?? "false") === "true",
    loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
    loginLockMs: Number(process.env.LOGIN_LOCK_MS ?? 10 * 60 * 1000),
    loginIpMaxFailures: Number(process.env.LOGIN_IP_MAX_FAILURES ?? 20),
    loginIpLockMs: Number(process.env.LOGIN_IP_LOCK_MS ?? 10 * 60 * 1000),
    auditLogMaxRows: Number(process.env.AUDIT_LOG_MAX_ROWS ?? 20000),
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
    auditExportMaxRows: Number(process.env.AUDIT_EXPORT_MAX_ROWS ?? 5000),
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: Number(process.env.SMTP_PORT ?? 465),
    smtpSecure: (process.env.SMTP_SECURE ?? "true") === "true",
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    smtpFrom: process.env.SMTP_FROM ?? "",
    mailEnabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    mailTransport: process.env.MAIL_TRANSPORT ?? "smtp",
    mailMaxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS ?? 5),
    mailRetryBaseMs: Number(process.env.MAIL_RETRY_BASE_MS ?? 60 * 1000),
    mailPollMs: Number(process.env.MAIL_POLL_MS ?? 15 * 1000),
  };
}
