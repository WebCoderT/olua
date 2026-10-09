import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { humanizeDuration } from "../../common/utils/ban.util";
import { SystemRepository } from "../../database/repositories/system.repository";
import { SystemConfigItemDto, SystemDatabaseDto, SystemInfoDto, SystemRuntimeDto } from "./dto/system.dto";

/** 从 ConfigService 读一个键（收成函数，好把配置快照写成一张纯声明式的表） */
type ConfigRead = <T>(key: string) => T;

/**
 * 配置快照的**白名单**
 *
 * 用白名单而不是黑名单：将来新增一个敏感配置项（又一个密钥）时，黑名单需要有人想起来
 * 把它加进去，漏了就静默泄漏；白名单的默认行为是「没列出来 = 不暴露」，漏了只会少显示一项。
 *
 * `key` 用环境变量名（运维改的是 `.env`），`field` 是服务端配置里的字段名。
 * `sensitive: true` 的项只报形态（已配置 / 未配置），绝不回显原文。
 */
const CONFIG_SNAPSHOT: {
  key: string;
  field: string;
  render?: (read: ConfigRead) => string;
  sensitive?: boolean;
  warning?: (read: ConfigRead) => boolean;
}[] = [
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
    warning: (read) => read<string[]>("corsOrigins").includes("*"),
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
  },
  {
    key: "ADMIN_REGISTER_CODE",
    field: "adminRegisterCode",
    sensitive: true,
    render: (read) => (read<string>("adminRegisterCode") ? "已设置（注册需带注册码）" : "未设置"),
  },
];

/**
 * 系统信息（管理端「系统信息」页）
 *
 * 定位是**运维自查**：版本 / 运行时长 / 数据文件体积与各表行数 / 脱敏配置快照。
 * 它不参与任何业务流程，所以这里也不写日志、不改状态，只读。
 */
@Injectable()
export class SystemService {
  constructor(
    private readonly config: ConfigService,
    private readonly tables: SystemRepository,
  ) {}

  info(): SystemInfoDto {
    const dto = new SystemInfoDto();
    dto.runtime = this.runtime();
    dto.database = this.database();
    dto.config = CONFIG_SNAPSHOT.map((item) => this.configItem(item));
    dto.time = Date.now();
    return dto;
  }

  private runtime(): SystemRuntimeDto {
    const dto = new SystemRuntimeDto();
    const uptimeMs = Math.round(process.uptime() * 1000);
    const memory = process.memoryUsage();
    dto.version = appVersion();
    dto.nodeVersion = process.version;
    dto.env = this.config.get<string>("env") ?? "unknown";
    dto.pid = process.pid;
    dto.uptimeMs = uptimeMs;
    dto.uptimeText = humanizeDuration(uptimeMs);
    dto.startedAt = Date.now() - uptimeMs;
    dto.platform = platform();
    dto.platformRelease = release();
    dto.arch = arch();
    dto.memoryRssBytes = memory.rss;
    dto.memoryHeapUsedBytes = memory.heapUsed;
    return dto;
  }

  private database(): SystemDatabaseDto {
    const dto = new SystemDatabaseDto();
    const dbPath = this.config.get<string>("dbPath") ?? "";
    dto.path = dbPath;
    dto.sizeBytes = null;
    dto.modifiedAt = null;
    // 内存库没有文件；文件还没落盘 / 路径不可达时也只是统计不到 —— 两者都不该让整页失败
    if (dbPath !== ":memory:") {
      try {
        const stat = statSync(dbPath);
        dto.sizeBytes = stat.size;
        dto.modifiedAt = stat.mtimeMs;
      } catch {
        /* 保持 null，界面显示「—」 */
      }
    }
    dto.tables = this.tables.listTableCounts();
    return dto;
  }

  /** 把快照表里的一项渲染成 DTO（取值只经 `field`，白名单外的配置读不到） */
  private configItem(item: (typeof CONFIG_SNAPSHOT)[number]): SystemConfigItemDto {
    const read: ConfigRead = <T>(key: string) => this.config.get<T>(key) as T;
    const dto = new SystemConfigItemDto();
    dto.key = item.key;
    dto.sensitive = item.sensitive ?? false;
    dto.warning = item.warning?.(read) ?? false;
    dto.value = item.render ? item.render(read) : String(read(item.field) ?? "—");
    return dto;
  }
}

/**
 * 读 package.json 取版本号
 *
 * 从 `__dirname` 往上三级：`dist/modules/system`（跑编译产物）与 `src/modules/system`
 * （ts-node 跑源码）都指到 `server/package.json`。读不到就返回 unknown ——
 * 一个版本号不该让整页 500。
 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 毫秒 → 人读（0 表示「关闭该维度」，别显示成「1 分钟」） */
function describeMs(ms: number): string {
  return ms <= 0 ? "关闭（不锁定）" : humanizeDuration(ms);
}

/** 数值型上限 → 人读（0 = 不限制） */
function describeLimit(value: number, unit: string): string {
  return value <= 0 ? "不限制" : `${value} ${unit}`;
}
