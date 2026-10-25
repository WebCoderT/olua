import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { EquipmentRow } from "../../../database/rows";
import { EQUIPMENT_SLOTS } from "../../../shared/game-data.generated";
import { attributesFromRow, ConfigAttributesDto, SoulRowShape } from "./title.dto";

/** 部位取值清单（**派生**自生成物的 EQUIPMENT_SLOTS，键即 EQUIPMENT_TYPE 的枚举值） */
export const EQUIPMENT_SLOT_KEYS = Object.keys(EQUIPMENT_SLOTS);

/** 等级需求上下限（客户端曲线铺到 roleMaxLevel；防御性校验，正常配置远够不着上限） */
export const EQUIPMENT_LEVEL_MIN = 1;
export const EQUIPMENT_LEVEL_MAX = 1000;

/** 售卖价上限（绑定元宝计价的防御性上限；0 = 不可售卖） */
export const EQUIPMENT_SELL_PRICE_MAX = 100_000_000;

/** 管理端看到的一条装备基础件配置 */
export class EquipmentDto {
  @ApiProperty({ description: "装备基础件 id（如 cloth_1；变体 id 带 _pXsY 不进管理端）" })
  id: string;

  @ApiProperty({ description: "部位（EQUIPMENT_TYPE 的枚举值，如 cloth）" })
  slot: string;

  @ApiProperty({ description: "穿戴需求等级（装备定强的锚点）" })
  level: number;

  @ApiProperty({ description: "售卖价（0 = 不可售卖；商城售价归商城定价管理，不在这里）" })
  sellPrice: number;

  @ApiProperty({ description: "名称（seed 自客户端条目，暂不开放编辑）" })
  label: string;

  @ApiProperty({ description: "八项基础属性（普通的·人级；变体是它乘前后缀倍率展开的）", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipmentRow): EquipmentDto {
    const dto = new EquipmentDto();
    dto.id = row.id;
    dto.slot = row.slot;
    dto.level = row.level;
    dto.sellPrice = row.sell_price;
    dto.label = row.label;
    dto.attributes = attributesFromRow(row as EquipmentRow & SoulRowShape);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 装备列表查询入参 */
export class EquipmentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({
    description: "按部位筛（取值：" + EQUIPMENT_SLOT_KEYS.join(" / ") + "；枚举清单派生自客户端配置，不落 schema 以免英文/中文键进两端生成物）",
  })
  @IsOptional()
  @IsString({ message: "部位必须是字符串" })
  @IsIn(EQUIPMENT_SLOT_KEYS, { message: "部位取值不合法" })
  slot?: string;

  @ApiPropertyOptional({ description: "等级段下限（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级下限必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级下限不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  minLevel?: number;

  @ApiPropertyOptional({ description: "等级段上限（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级上限必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级上限不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  maxLevel?: number;
}

/** 装备分页结果 */
export class EquipmentPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的装备基础件配置", type: [EquipmentDto] })
  list: EquipmentDto[];
}

/**
 * 编辑装备基础件入参（**部分更新**）
 *
 * **没有 Create / Delete**：装备 id / 部位结构固定（变体生成规则在客户端配置，属代码不是运营数据），
 * 后台只允许改数值 —— 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * `slot` / `label` 不开放编辑（部位结构与文案属客户端资源约定，改了会与两端资源对不上）。
 */
export class UpdateEquipmentDto {
  @ApiPropertyOptional({ description: "穿戴需求等级（不传则不改）", minimum: EQUIPMENT_LEVEL_MIN, maximum: EQUIPMENT_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  @Max(EQUIPMENT_LEVEL_MAX, { message: `等级不能大于 ${EQUIPMENT_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({
    description: "售卖价（不传则不改；0 = 不可售卖。**商城售价不在这里** —— 唯一写入口归商城定价管理）",
    minimum: 0,
    maximum: EQUIPMENT_SELL_PRICE_MAX,
  })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(EQUIPMENT_SELL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({
    description: "八项基础属性（**整份提交、整份替换**，不传则不改；区间型要求 0 ≤ min ≤ max）。变体属性 = 基础属性 × 前后缀倍率，在客户端展开",
    type: ConfigAttributesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigAttributesDto)
  attributes?: ConfigAttributesDto;
}
