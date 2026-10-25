import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { DrugRow } from "../../../database/rows";

/** 名称 / 描述长度上限（与称号 / 军衔同一档） */
export const DRUG_LABEL_MAX = 20;
export const DRUG_DESCRIPTION_MAX = 200;

/** 防御性上限（药品数值量级远够不着；百分比按整数百分比计） */
export const DRUG_EFFECT_MAX = 100_000_000;
export const DRUG_COOLDOWN_MAX = 3600;
export const DRUG_MAX_STACK_MAX = 9_999;
export const DRUG_SELL_PRICE_MAX = 100_000_000;

/** 管理端看到的一条药品配置 */
export class DrugDto {
  @ApiProperty({ description: "药品 id（如 drug_hp_1；被掉落表与背包引用，不可增删行）" })
  id: string;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "使用等级需求（暂不开放编辑）" })
  level: number;

  @ApiProperty({ description: "售卖价（0 = 不可售卖；商城售价归商城定价管理，不在这里）" })
  sellPrice: number;

  @ApiProperty({ description: "最大叠加数量" })
  maxStack: number;

  @ApiProperty({ description: "使用冷却（秒，0 = 无冷却）" })
  cooldown: number;

  @ApiProperty({ description: "固定回复生命（effects 数组按键求和的结果）" })
  effectHp: number;

  @ApiProperty({ description: "固定回复魔法" })
  effectMp: number;

  @ApiProperty({ description: "按角色 maxHp 的百分比回复（50 = 50%）" })
  effectHpPercent: number;

  @ApiProperty({ description: "按角色 maxMp 的百分比回复（50 = 50%）" })
  effectMpPercent: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: DrugRow): DrugDto {
    const dto = new DrugDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.description = row.description;
    dto.level = row.level;
    dto.sellPrice = row.sell_price;
    dto.maxStack = row.max_stack;
    dto.cooldown = row.cooldown;
    dto.effectHp = row.effect_hp;
    dto.effectMp = row.effect_mp;
    dto.effectHpPercent = row.effect_hp_percent;
    dto.effectMpPercent = row.effect_mp_percent;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 药品列表查询入参 */
export class DrugQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id / 名称 / 描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 药品分页结果 */
export class DrugPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的药品配置", type: [DrugDto] })
  list: DrugDto[];
}

/**
 * 编辑药品入参（**部分更新**）
 *
 * **没有 Create / Delete**：药品 id 清单固定（被掉落表与背包引用），后台只允许改数值 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * `level` 不开放编辑（使用等级需求属客户端成长曲线定标的一部分，改曲线要连着改）。
 * 四项回复量按**键求和**后的单值提交（客户端 resolveDrugRecovery 逐项累加，语义等价）。
 */
export class UpdateDrugDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: DRUG_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(DRUG_LABEL_MAX, { message: `名称最长 ${DRUG_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: DRUG_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(DRUG_DESCRIPTION_MAX, { message: `描述最长 ${DRUG_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({
    description: "售卖价（不传则不改；0 = 不可售卖。**商城售价不在这里** —— 唯一写入口归商城定价管理）",
    minimum: 0,
    maximum: DRUG_SELL_PRICE_MAX,
  })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(DRUG_SELL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "最大叠加数量（不传则不改）", minimum: 1, maximum: DRUG_MAX_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "堆叠上限必须是整数" })
  @Min(1, { message: "堆叠上限至少为 1" })
  @Max(DRUG_MAX_STACK_MAX, { message: "堆叠上限超出防御性上限" })
  maxStack?: number;

  @ApiPropertyOptional({ description: "使用冷却秒数（不传则不改；0 = 无冷却）", minimum: 0, maximum: DRUG_COOLDOWN_MAX })
  @IsOptional()
  @IsInt({ message: "冷却必须是整数" })
  @Min(0, { message: "冷却不能为负" })
  @Max(DRUG_COOLDOWN_MAX, { message: "冷却超出防御性上限（1 小时）" })
  cooldown?: number;

  @ApiPropertyOptional({ description: "固定回复生命（不传则不改）", minimum: 0, maximum: DRUG_EFFECT_MAX })
  @IsOptional()
  @IsInt({ message: "回复量必须是整数" })
  @Min(0, { message: "回复量不能为负" })
  @Max(DRUG_EFFECT_MAX, { message: "回复量超出防御性上限" })
  effectHp?: number;

  @ApiPropertyOptional({ description: "固定回复魔法（不传则不改）", minimum: 0, maximum: DRUG_EFFECT_MAX })
  @IsOptional()
  @IsInt({ message: "回复量必须是整数" })
  @Min(0, { message: "回复量不能为负" })
  @Max(DRUG_EFFECT_MAX, { message: "回复量超出防御性上限" })
  effectMp?: number;

  @ApiPropertyOptional({ description: "按 maxHp 的百分比回复，整数（不传则不改；50 = 50%）", minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt({ message: "百分比必须是整数" })
  @Min(0, { message: "百分比不能为负" })
  @Max(100, { message: "百分比不能超过 100" })
  effectHpPercent?: number;

  @ApiPropertyOptional({ description: "按 maxMp 的百分比回复，整数（不传则不改；50 = 50%）", minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt({ message: "百分比必须是整数" })
  @Min(0, { message: "百分比不能为负" })
  @Max(100, { message: "百分比不能超过 100" })
  effectMpPercent?: number;
}
