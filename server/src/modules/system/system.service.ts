import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { configReader, readConfigSnapshot } from "../../config/config-snapshot";
import { humanizeDuration } from "../../common/utils/ban.util";
import { SystemRepository } from "../../database/repositories/system.repository";
import { SystemConfigItemDto, SystemDatabaseDto, SystemInfoDto, SystemRuntimeDto } from "./dto/system.dto";

/**
 * 系统信息（管理端「系统信息」页）
 *
 * 定位是**运维自查**：版本 / 运行时长 / 数据文件体积与各表行数 / 脱敏配置快照。
 * 它不参与任何业务流程，所以这里也不写日志、不改状态，只读。
 *
 * 配置快照的表与判据**不在这个文件里**，在 `config/config-snapshot.ts` —— 启动自检
 * （main.ts）读的是同一份，免得「启动日志说没事、信息页却标红」。
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
    dto.config = readConfigSnapshot(configReader(this.config)).map((item) => {
      const row = new SystemConfigItemDto();
      row.key = item.key;
      row.value = item.value;
      // `sensitive` 与 `warning` 是两个独立的意思：「值不是原文」与「运维该去改」
      row.sensitive = item.sensitive;
      row.warning = item.warning;
      return row;
    });
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
