import { humanizeDuration } from "../common/utils/ban.util";

/**
 * 脱敏配置快照（**唯一来源**）
 *
 * 两个消费者，判据只有这一份：
 * 1. **启动自检**（`main.ts`）：把 `warning: true` 的项逐条打进启动日志；
 * 2. **管理端「系统信息」页**：整张表渲染出来。
 *
 * 收在一处是因为「什么算该报警」只能是同一条判据 —— 启动日志说没事、信息页却标红
 * （或反过来），是最难查的一类不一致。
 *
 * ## 为什么是白名单
 * 没登记过的配置项**不会出现在快照里**。将来新增一个敏感配置（又一个密钥）时，
 * 白名单的默认行为是「不暴露」，漏了只会少显示一项；换成黑名单就要靠人记得去加，
 * 漏一次就是静默泄漏。
 *
 * ## 三个可选钩子
 * - `render`：把值变成人读文本（布尔 → 开启/关闭、毫秒 → 3 天 2 小时）。不写就用原值。
 * - `sensitive: true`：值是**形态描述**而不是原文（密钥类）。这类项永远不回显原文。
 * - `warning`：该项当前是否值得运维注意；配 `advice` 给一句话，启动自检直接打它。
 */

/** 读一项配置（`ConfigService.get` 的窄化包装；参数是**服务端配置字段名**） */
export type ConfigRead = <T>(field: string) => T;

/**
 * 把 `ConfigService`（或任何同形的 `get`）包成 `ConfigRead`
 *
 * 快照里的声明式表要能不写类型断言地链式取值（`render` / `warning` 里常常一次读好几项），
 * 而 `ConfigService.get` 的返回类型是 `T | undefined`。转换只在这一处，表里就干净了。
 */
export function configReader(source: { get<T = unknown>(field: string): T | undefined }): ConfigRead {
  return <T>(field: string) => source.get<T>(field) as T;
}

/** 快照里的一项 */
export interface ConfigSnapshotItem {
  /** 环境变量名（运维改的是 `.env`，所以对外用变量名而不是字段名） */
  key: string;
  /** 值，或脱敏后的形态描述 */
  value: string;
  /** 值是形态描述而不是原文 */
  sensitive: boolean;
  /** 值得运维注意 */
  warning: boolean;
  /** 需要提醒时给的一句话（启动自检用；信息页只标红，不展示长文案） */
  advice?: string;
}

interface ConfigSnapshotSpec {
  key: string;
  field: string;
  render?: (read: ConfigRead) => string;
  sensitive?: boolean;
  warning?: (read: ConfigRead) => boolean;
  advice?: string;
}

const CONFIG_SNAPSHOT: ConfigSnapshotSpec[] = [
  { key: "NODE_ENV", field: "env" },
  { key: "PORT", field: "port" },
  { key: "API_PREFIX", field: "apiPrefix" },
  { key: "DB_PATH", field: "dbPath" },
  { key: "JWT_EXPIRES_IN", field: "jwtExpiresIn" },
  { key: "ROLE_MAX_PER_ACCOUNT", field: "roleMaxPerAccount", render: (read) => `${read<number>("roleMaxPerAccount")} 个` },
  { key: "LOG_REQUESTS", field: "logRequests", render: (read) => (read<boolean>("logRequests") ? "开启" : "关闭") },
  {
    key: "TRUST_PROXY",
    field: "trustProxy",
    render: (read) => (read<boolean>("trustProxy") ? "开启（信任 X-Forwarded-For，需在反向代理之后）" : "关闭（直连部署）"),
  },
  {
    key: "CORS_ORIGINS",
    field: "corsOrigins",
    render: (read) => read<string[]>("corsOrigins").join(", ") || "（空：不允许任何跨域来源）",
    // `*` 只在生产算问题：开发时前后端本来就是两个源，天天报警只会让人学会无视告警
    warning: (read) => read<string[]>("corsOrigins").includes("*") && read<string>("env") === "production",
    advice: "CORS_ORIGINS 是 *：任何站点都能让浏览器带着用户凭据调这些接口，生产环境请列出真实来源（逗号分隔）",
  },
  {
    key: "PLAYER_REGISTER_OPEN",
    field: "playerRegisterOpen",
    render: (read) => (read<boolean>("playerRegisterOpen") ? "开启（可自助注册）" : "关闭（只有已注册账号能登录）"),
  },
  {
    key: "ADMIN_REGISTER_OPEN",
    field: "adminRegisterOpen",
    render: (read) =>
      read<boolean>("adminRegisterOpen")
        ? "开启（未配注册码也允许自助注册）"
        : read<string>("adminRegisterCode")
          ? "关闭（以注册码为准）"
          : "关闭（未配注册码，谁也不许注册）",
    warning: (read) =>
      read<boolean>("adminRegisterOpen") && !read<string>("adminRegisterCode") && read<string>("env") === "production",
    advice:
      "ADMIN_REGISTER_OPEN 开着且没配 ADMIN_REGISTER_CODE：任何人都能注册后台，而第一个注册的自动是超级管理员",
  },
  {
    key: "ADMIN_REGISTER_CODE",
    field: "adminRegisterCode",
    sensitive: true,
    render: (read) => (read<string>("adminRegisterCode") ? "已设置（注册需带注册码）" : "未设置"),
  },
  { key: "LOGIN_MAX_FAILURES", field: "loginMaxFailures", render: (read) => `${read<number>("loginMaxFailures")} 次` },
  { key: "LOGIN_LOCK_MS", field: "loginLockMs", render: (read) => describeMs(read<number>("loginLockMs")) },
  { key: "LOGIN_IP_MAX_FAILURES", field: "loginIpMaxFailures", render: (read) => `${read<number>("loginIpMaxFailures")} 次` },
  { key: "LOGIN_IP_LOCK_MS", field: "loginIpLockMs", render: (read) => describeMs(read<number>("loginIpLockMs")) },
  { key: "AUDIT_LOG_MAX_ROWS", field: "auditLogMaxRows", render: (read) => describeLimit(read<number>("auditLogMaxRows"), "条") },
  { key: "AUDIT_RETENTION_DAYS", field: "auditRetentionDays", render: (read) => describeLimit(read<number>("auditRetentionDays"), "天") },
  { key: "AUDIT_EXPORT_MAX_ROWS", field: "auditExportMaxRows", render: (read) => describeLimit(read<number>("auditExportMaxRows"), "条") },
  {
    key: "JWT_SECRET",
    field: "jwtSecret",
    sensitive: true,
    render: (read) => (read<boolean>("jwtSecretIsDefault") ? "仍是内置默认值" : "已自定义"),
    warning: (read) => read<boolean>("jwtSecretIsDefault"),
    advice: "JWT_SECRET 仍是内置默认值：密钥写在代码里等于公开，任何人都能自签管理员令牌，请换成随机长串",
  },
];

/** 渲染整张快照（顺序即信息页的展示顺序） */
export function readConfigSnapshot(read: ConfigRead): ConfigSnapshotItem[] {
  return CONFIG_SNAPSHOT.map((item) => ({
    key: item.key,
    value: item.render ? item.render(read) : String(read(item.field) ?? "—"),
    sensitive: item.sensitive ?? false,
    warning: item.warning?.(read) ?? false,
    advice: item.advice,
  }));
}

/** 毫秒 → 人读（0 表示「关闭该维度」，别显示成「1 分钟」） */
function describeMs(ms: number): string {
  return ms <= 0 ? "关闭（不锁定）" : humanizeDuration(ms);
}

/** 数值型上限 → 人读（0 = 不限制） */
function describeLimit(value: number, unit: string): string {
  return value <= 0 ? "不限制" : `${value} ${unit}`;
}
