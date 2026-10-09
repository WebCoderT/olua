import { ApiProperty } from "@nestjs/swagger";

/** 运行时信息 */
export class SystemRuntimeDto {
  @ApiProperty({ description: "服务端版本（读 server/package.json）", example: "0.1.0" })
  version: string;

  @ApiProperty({ description: "Node 版本", example: "v22.22.2" })
  nodeVersion: string;

  @ApiProperty({ description: "运行环境（NODE_ENV）", example: "production" })
  env: string;

  @ApiProperty({ description: "进程 id" })
  pid: number;

  @ApiProperty({ description: "已运行毫秒数" })
  uptimeMs: number;

  @ApiProperty({ description: "已运行时长（人读，如「3 天 2 小时」）" })
  uptimeText: string;

  @ApiProperty({ description: "进程启动时刻（毫秒时间戳）" })
  startedAt: number;

  @ApiProperty({ description: "操作系统平台", example: "darwin" })
  platform: string;

  @ApiProperty({ description: "操作系统版本" })
  platformRelease: string;

  @ApiProperty({ description: "CPU 架构", example: "arm64" })
  arch: string;

  @ApiProperty({ description: "常驻内存（字节）" })
  memoryRssBytes: number;

  @ApiProperty({ description: "堆已用内存（字节）" })
  memoryHeapUsedBytes: number;
}

/** 某张表的行数 */
export class SystemTableCountDto {
  @ApiProperty({ description: "表名", example: "roles" })
  table: string;

  @ApiProperty({ description: "行数", example: 42 })
  rows: number;
}

/** 数据库信息 */
export class SystemDatabaseDto {
  @ApiProperty({ description: "数据文件路径（`:memory:` = 内存库，无文件）", example: "data/olua.db" })
  path: string;

  @ApiProperty({ description: "数据文件体积（字节）；内存库为 null", type: "number", nullable: true })
  sizeBytes: number | null;

  @ApiProperty({ description: "数据文件最后修改时间（毫秒）；内存库为 null", type: "number", nullable: true })
  modifiedAt: number | null;

  @ApiProperty({ description: "各表行数（动态枚举 sqlite_master，加表不用改这里）", type: [SystemTableCountDto] })
  tables: SystemTableCountDto[];
}

/**
 * 脱敏配置快照里的一项
 *
 * `sensitive=false` 的项直接给值；`true` 的项只给「已配置 / 未配置」这类形态描述 ——
 * 密钥不该因为「有个便利的信息页」就变成可被管理员读出的明文。
 */
export class SystemConfigItemDto {
  @ApiProperty({ description: "配置项（环境变量名）", example: "LOGIN_MAX_FAILURES" })
  key: string;

  @ApiProperty({ description: "值（或脱敏后的描述）" })
  value: string;

  @ApiProperty({ description: "是否是脱敏项（值不是原文，只给形态）" })
  sensitive: boolean;

  @ApiProperty({ description: "是否需要运维注意（如仍在使用默认 JWT 密钥）" })
  warning: boolean;
}

/** 系统信息（管理端「系统信息」页） */
export class SystemInfoDto {
  @ApiProperty({ description: "运行时信息", type: SystemRuntimeDto })
  runtime: SystemRuntimeDto;

  @ApiProperty({ description: "数据库信息", type: SystemDatabaseDto })
  database: SystemDatabaseDto;

  @ApiProperty({ description: "脱敏后的配置快照（白名单：不列出 = 不暴露）", type: [SystemConfigItemDto] })
  config: SystemConfigItemDto[];

  @ApiProperty({ description: "服务端时间戳（毫秒）" })
  time: number;
}
