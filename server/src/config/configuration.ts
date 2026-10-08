import { join } from "node:path";

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
  /** JWT 有效期 */
  jwtExpiresIn: string;
  /** 管理端注册码（空串 = 管理端开放注册） */
  adminRegisterCode: string;
  /** 每个账号的角色上限 */
  roleMaxPerAccount: number;
  /** 允许的跨域来源（["*"] = 全部） */
  corsOrigins: string[];
  /** 是否打印详细日志 */
  logRequests: boolean;
}

export default function configuration(): AppConfiguration {
  return {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3100),
    apiPrefix: process.env.API_PREFIX ?? "api",
    dbPath: process.env.DB_PATH ?? join(process.cwd(), "data", "olua.db"),
    jwtSecret: process.env.JWT_SECRET ?? "olua-dev-secret-please-change-me",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
    adminRegisterCode: process.env.ADMIN_REGISTER_CODE ?? "",
    roleMaxPerAccount: Number(process.env.ROLE_MAX_PER_ACCOUNT ?? 3),
    corsOrigins: (process.env.CORS_ORIGINS ?? "*")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    logRequests: (process.env.LOG_REQUESTS ?? "true") === "true",
  };
}
