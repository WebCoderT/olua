import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** 版本列表的查询参数 */
export class ConfigRevisionQueryDto {
  @ApiPropertyOptional({ description: "取最近多少层（默认 20，上限 100）", example: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: "limit 必须是整数" })
  @Min(1, { message: "limit 至少 1" })
  @Max(100, { message: "limit 最多 100" })
  limit?: number;
}


/** 当前配置版本（`GET /game-config/version` 与 `GET /admin/config/version` 同一个形状） */
export class ConfigVersionDto {
  @ApiProperty({ description: "配置版本号：每次管理端写配置成功 +1（0 = 出厂状态，一次都没改过）" })
  version: number;

  static of(version: number): ConfigVersionDto {
    const dto = new ConfigVersionDto();
    dto.version = version;
    return dto;
  }
}

/** 一层回滚历史（列表用，不含 payload —— payload 每层几 MB，不跟着列表走） */
export class ConfigRevisionDto {
  @ApiProperty({ description: "版本号（这一层是「第几版」，与 config_version 同一个计数）" })
  version: number;

  @ApiProperty({ description: "这一层是什么改动（写接口的 operationId，如 adminSkill.update）" })
  label: string;

  @ApiProperty({ description: "payload 字节数（全量配置 JSON；超过 5MB 说明配置该拆了）" })
  byteSize: number;

  @ApiProperty({ description: "payload 里有几张配置表" })
  tableCount: number;

  @ApiProperty({ description: "payload 里一共多少行" })
  rowCount: number;

  @ApiProperty({ description: "操作人（管理端账号名；同一人 10 秒内的连点会合并成一层）" })
  createdBy: string;

  @ApiProperty({ description: "落层时间（毫秒）" })
  createdAt: number;
}

/** 版本列表 */
export class ConfigRevisionListDto {
  @ApiProperty({ description: "保留的层数（默认 20，`CONFIG_REVISION_RETAIN`）", example: 20 })
  total: number;

  @ApiProperty({ description: "按版本号倒序（最新在前）", type: [ConfigRevisionDto] })
  list: ConfigRevisionDto[];
}

/** 两张版本之间的差异（**按表**，到行数） */
export class ConfigRevisionTableDiffDto {
  @ApiProperty({ description: "表名（与 config-sync.sql 的节名一致）" })
  table: string;

  @ApiProperty({ description: "这张表在旧版有几行" })
  from: number;

  @ApiProperty({ description: "这张表在新版有几行" })
  to: number;

  @ApiProperty({ description: "新增行数（改一行也会体现成「一删一加」，所以它是行级不是字段级）" })
  added: number;

  @ApiProperty({ description: "删除行数" })
  removed: number;
}

/** 版本 diff 结果 */
export class ConfigRevisionDiffDto {
  @ApiProperty({ description: "旧版本号" })
  from: number;

  @ApiProperty({ description: "新版本号" })
  to: number;

  @ApiProperty({ description: "有变化的表数（行数一样但值改了也会出现在这个列表里）" })
  changed: number;

  @ApiProperty({ description: "逐表差异，只含有变化的表", type: [ConfigRevisionTableDiffDto] })
  tables: ConfigRevisionTableDiffDto[];
}

/** 回滚结果 */
export class ConfigRestoreResultDto {
  @ApiProperty({ description: "回滚后的新版本号（回滚本身也是一层新版本，历史不删）" })
  version: number;

  @ApiProperty({ description: "内容取自哪一层" })
  restoredFrom: number;

  @ApiProperty({ description: "恢复了多少张表" })
  tables: number;

  @ApiProperty({ description: "恢复了多少行" })
  rows: number;

  @ApiProperty({
    description: "被跳过的表（payload 里有、当前库里没有的表结构 —— 不做结构迁移，跳过并告警）",
    type: [String],
  })
  skipped: string[];
}
