import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { ItemRow } from "../../../database/rows";
import { GOOD_TYPE_VALUES } from "../../../common/constants/game-config";

/** 名称 / 描述长度上限（与称号 / 军衔 / 药品同一档） */
export const ITEM_LABEL_MAX = 20;
export const ITEM_DESCRIPTION_MAX = 200;

/** 防御性上限 */
export const ITEM_MAX_STACK_MAX = 9_999;
export const ITEM_SELL_PRICE_MAX = 100_000_000;

/** 管理端看到的一条物品配置 */
export class ItemDto {
  @ApiProperty({ description: "物品 id（如 material_hide；被掉落表与脚本引用，不可增删行）" })
  id: string;

  @ApiProperty({ description: "物品大类（GOOD_TYPE 的枚举值，如 material；结构字段不开放编辑）" })
  type: string;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "等级需求（暂不开放编辑）" })
  level: number;

  @ApiProperty({ description: "售卖价（0 = 不可售卖；商城售价归商城定价管理，不在这里）" })
  sellPrice: number;

  @ApiProperty({ description: "最大叠加数量" })
  maxStack: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: ItemRow): ItemDto {
    const dto = new ItemDto();
    dto.id = row.id;
    dto.type = row.type;
    dto.label = row.label;
    dto.description = row.description;
    dto.level = row.level;
    dto.sellPrice = row.sell_price;
    dto.maxStack = row.max_stack;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 物品列表查询入参 */
export class ItemQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id / 名称 / 描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({
    description: "按物品大类筛（取值：" + GOOD_TYPE_VALUES.join(" / ") + "；枚举清单派生自客户端配置，不落 schema 以免枚举字面量进两端生成物）",
  })
  @IsOptional()
  @IsString({ message: "物品大类必须是字符串" })
  @IsIn(GOOD_TYPE_VALUES, { message: "物品大类取值不合法" })
  type?: string;
}

/** 物品分页结果 */
export class ItemPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的物品配置", type: [ItemDto] })
  list: ItemDto[];
}

/**
 * 编辑物品入参（**部分更新**）
 *
 * **没有 Create / Delete**：物品 id 清单固定（被掉落表与脚本引用），后台只允许改数值 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * `type` / `level` 不开放编辑（大类与等级属客户端结构约定）。
 */
export class UpdateItemDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: ITEM_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(ITEM_LABEL_MAX, { message: `名称最长 ${ITEM_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: ITEM_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(ITEM_DESCRIPTION_MAX, { message: `描述最长 ${ITEM_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({
    description: "售卖价（不传则不改；0 = 不可售卖。**商城售价不在这里** —— 唯一写入口归商城定价管理）",
    minimum: 0,
    maximum: ITEM_SELL_PRICE_MAX,
  })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(ITEM_SELL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "最大叠加数量（不传则不改）", minimum: 1, maximum: ITEM_MAX_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "堆叠上限必须是整数" })
  @Min(1, { message: "堆叠上限至少为 1" })
  @Max(ITEM_MAX_STACK_MAX, { message: "堆叠上限超出防御性上限" })
  maxStack?: number;
}
