import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { SoulRow } from "../../../database/rows";
import {
  attributesFromRow,
  ConfigAttributesDto,
  TITLE_ANIMATION_MAX,
  TITLE_DESCRIPTION_MAX,
  TITLE_LABEL_MAX,
} from "./title.dto";

/** 管理端看到的一条战魂配置 */
export class SoulDto {
  @ApiProperty({ description: "阶数（1 起；序列固定，不可增删行）" })
  level: number;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "动画资源目录（resources 相对路径）" })
  animation: string;

  @ApiProperty({ description: "动画帧率" })
  animationFrameRate: number;

  @ApiProperty({ description: "升到该阶消耗的绑定元宝" })
  bindGold: number;

  @ApiProperty({ description: "战魂成长列表顺序（1 起；37 阶全量持有，拖动排序改的就是它，与阶数解耦）" })
  upgradeOrder: number;

  @ApiProperty({ description: "八项属性加成", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: SoulRow): SoulDto {
    const dto = new SoulDto();
    dto.level = row.level;
    dto.label = row.label;
    dto.description = row.description;
    dto.animation = row.animation;
    dto.animationFrameRate = row.animation_frame_rate;
    dto.bindGold = row.bind_gold;
    dto.upgradeOrder = row.upgrade_order ?? 0;
    dto.attributes = attributesFromRow(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 战魂列表查询入参 */
export class SoulQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配名称与描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/**
 * 编辑战魂入参（**部分更新**）
 *
 * 与称号同构，只少 `acquireChannel` —— 战魂没有「获得渠道」语义（37 阶逐阶购买）。
 * **没有 Create / Delete**：阶数序列固定，后台只允许改。
 */
export class UpdateSoulDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: TITLE_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(TITLE_LABEL_MAX, { message: `名称最长 ${TITLE_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: TITLE_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(TITLE_DESCRIPTION_MAX, { message: `描述最长 ${TITLE_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "动画资源目录（不传则不改）", maxLength: TITLE_ANIMATION_MAX })
  @IsOptional()
  @IsString({ message: "动画资源必须是字符串" })
  @MinLength(1, { message: "动画资源不能为空" })
  @MaxLength(TITLE_ANIMATION_MAX, { message: `动画资源最长 ${TITLE_ANIMATION_MAX} 个字` })
  animation?: string;

  @ApiPropertyOptional({ description: "动画帧率（不传则不改）", minimum: 1 })
  @IsOptional()
  @IsInt({ message: "帧率必须是整数" })
  @Min(1, { message: "帧率至少为 1" })
  animationFrameRate?: number;

  @ApiPropertyOptional({ description: "升到该阶消耗的绑定元宝（不传则不改）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "消耗必须是整数" })
  @Min(0, { message: "消耗不能为负" })
  bindGold?: number;

  @ApiPropertyOptional({
    description: "八项属性（**整份提交、整份替换**，不传则不改；区间型要求 0 ≤ min ≤ max）",
    type: ConfigAttributesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigAttributesDto)
  attributes?: ConfigAttributesDto;
}

/** 战魂分页结果 */
export class SoulPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的战魂配置", type: [SoulDto] })
  list: SoulDto[];
}
