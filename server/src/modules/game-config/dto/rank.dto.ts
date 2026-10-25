import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { RankRow } from "../../../database/rows";
import { RANK_LABELS } from "../../../shared/game-data.generated";
import { ConfigAttributesDto, ConfigAttributeRangeDto, SoulRowShape } from "./title.dto";

/** 名称 / 描述 / 大段名的长度上限（与称号同一档） */
export const RANK_LABEL_MAX = 20;
export const RANK_TIER_MAX = 20;
export const RANK_DESCRIPTION_MAX = 200;

/** 大段名清单（**派生**自生成物的 RANK_LABELS，不手写字面量清单） */
export const RANK_TIERS = [...new Set(Object.values(RANK_LABELS).map((item) => item.tier))];

/** 管理端看到的一条军衔配置 */
export class RankDto {
  @ApiProperty({ description: "阶数（1..100；序列固定，不可增删行）" })
  level: number;

  @ApiProperty({ description: "衔名（如「陪戎校尉」）" })
  label: string;

  @ApiProperty({ description: "大段名（如「校尉」；10 段 × 10 阶）" })
  tier: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "晋到该阶消耗的绑定元宝（价格唯一显示/修改口 = 军衔成长列表）" })
  bindGold: number;

  @ApiProperty({ description: "八项属性加成", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: RankRow): RankDto {
    const dto = new RankDto();
    dto.level = row.level;
    dto.label = row.label;
    dto.tier = row.tier;
    dto.description = row.description;
    dto.bindGold = row.bind_gold;
    dto.attributes = attributesFromRankRow(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 军衔属性列 → 嵌套属性对象（与称号 / 战魂同一形状；属性列同构，直接借 SoulRowShape 表达） */
function attributesFromRankRow(row: RankRow): ConfigAttributesDto {
  const shape = row as RankRow & SoulRowShape;
  const range = (min: number, max: number): ConfigAttributeRangeDto => {
    const out = new ConfigAttributeRangeDto();
    out.min = min;
    out.max = max;
    return out;
  };
  const out = new ConfigAttributesDto();
  out.maxHp = shape.max_hp;
  out.hpRecover = shape.hp_recover;
  out.physicalAttack = range(shape.physical_attack_min, shape.physical_attack_max);
  out.magicAttack = range(shape.magic_attack_min, shape.magic_attack_max);
  out.taoistAttack = range(shape.taoist_attack_min, shape.taoist_attack_max);
  out.physicalDefense = range(shape.physical_defense_min, shape.physical_defense_max);
  out.magicDefense = range(shape.magic_defense_min, shape.magic_defense_max);
  out.taoistDefense = range(shape.taoist_defense_min, shape.taoist_defense_max);
  return out;
}

/** 军衔列表查询入参 */
export class RankQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配衔名 / 大段名 / 描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "按大段名筛（取值：" + RANK_TIERS.join(" / ") + "；枚举清单派生自客户端配置，不落 schema 以免中文联合类型进两端生成物）" })
  @IsOptional()
  @IsString({ message: "大段名必须是字符串" })
  @IsIn(RANK_TIERS, { message: "大段名取值不合法" })
  tier?: string;
}

/** 军衔分页结果 */
export class RankPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的军衔配置", type: [RankDto] })
  list: RankDto[];
}

/**
 * 编辑军衔入参（**部分更新**）
 *
 * **没有 Create / Delete**：军衔阶数序列固定（1..100），后台只允许改 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * 价格（bindGold）不在编辑弹窗里 —— 唯一修改口是军衔成长列表（行内改价走同一接口）。
 */
export class UpdateRankDto {
  @ApiPropertyOptional({ description: "衔名（不传则不改）", maxLength: RANK_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "衔名必须是字符串" })
  @MinLength(1, { message: "衔名不能为空" })
  @MaxLength(RANK_LABEL_MAX, { message: `衔名最长 ${RANK_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "大段名（不传则不改）", maxLength: RANK_TIER_MAX })
  @IsOptional()
  @IsString({ message: "大段名必须是字符串" })
  @MinLength(1, { message: "大段名不能为空" })
  @MaxLength(RANK_TIER_MAX, { message: `大段名最长 ${RANK_TIER_MAX} 个字` })
  tier?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: RANK_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(RANK_DESCRIPTION_MAX, { message: `描述最长 ${RANK_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "晋到该阶消耗的绑定元宝（不传则不改；编辑弹窗会原样带回当前值）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "价格必须是整数" })
  @Min(0, { message: "价格不能为负" })
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
