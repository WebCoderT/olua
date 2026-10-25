import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { NpcRow } from "../../../database/rows";

/** 管理端看到的一条 NPC 基础数据 */
export class NpcDto {
  @ApiProperty({ description: "NPC id（Tiled 对象组的关联键，如 \"0002\"）" })
  id: string;

  @ApiProperty({ description: "名称（后台可改）" })
  label: string;

  @ApiProperty({ description: "对话文案（客户端暂无对话数据形态，seed 为空串；消费等 #248/#249）" })
  dialog: string;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: NpcRow): NpcDto {
    const dto = new NpcDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.dialog = row.dialog;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** NPC 列表查询入参 */
export class NpcQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** NPC 分页结果 */
export class NpcPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的 NPC 基础数据", type: [NpcDto] })
  list: NpcDto[];
}

/**
 * 编辑 NPC 基础数据入参（**部分更新**）
 *
 * **没有 Create / Delete**：NPC id 被 Tiled 地图对象组引用，清单固定 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * 外观资源（src / scale / position）是表现层配置，不进服务端。
 */
export class UpdateNpcDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  label?: string;

  @ApiPropertyOptional({ description: "对话文案（不传则不改；空串 = 清空）", maxLength: 2000 })
  @IsOptional()
  @IsString({ message: "对话文案必须是字符串" })
  @MaxLength(2000, { message: "对话文案不能超过 2000 字" })
  dialog?: string;
}
