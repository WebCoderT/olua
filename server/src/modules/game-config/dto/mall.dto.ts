import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { EQUIPMENT_SLOT_KEYS } from "./equipment.dto";

/** 售价的防御性上限（绑定元宝计价；与装备售卖价同一量级） */
export const MALL_PRICE_MAX = 100_000_000;

/** 统一价（管理端看到的那一行单行配置） */
export class MallSettingsDto {
  @ApiProperty({ description: "全场统一售价（绑定元宝/件；特殊价优先于它）" })
  defaultPrice: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: { default_price: number; updated_at: number }): MallSettingsDto {
    const dto = new MallSettingsDto();
    dto.defaultPrice = row.default_price;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 修改统一价入参 */
export class UpdateMallSettingsDto {
  @ApiProperty({ description: "全场统一售价（绑定元宝/件）", minimum: 0, maximum: MALL_PRICE_MAX })
  @IsInt({ message: "统一价必须是整数" })
  @Min(0, { message: "统一价不能为负" })
  @Max(MALL_PRICE_MAX, { message: "统一价超出防御性上限" })
  defaultPrice!: number;
}

/** 一条商品定价视图（商品清单来自生成物，价格来自 mall_prices；未定价 price = null） */
export class MallPriceItemDto {
  @ApiProperty({ description: "商品 id（装备变体 id，如 cloth_1_p3s2）" })
  id: string;

  @ApiProperty({ description: "显示名（生成物已拼好前后缀）" })
  label: string;

  @ApiProperty({ description: "部位（EQUIPMENT_TYPE 的枚举值）" })
  slot: string;

  @ApiProperty({ description: "等级需求（与基础件一致）" })
  level: number;

  @ApiProperty({ description: "特殊售价；null = 未定价（走统一价）", nullable: true, type: Number })
  price: number | null;

  @ApiProperty({ description: "特殊价的最近更新时间；未定价为 null", nullable: true, type: Number })
  updatedAt: number | null;
}

/** 商城定价列表查询入参 */
export class MallPriceQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配商品 id 与显示名" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({
    description: "按部位筛（取值：" + EQUIPMENT_SLOT_KEYS.join(" / ") + "）",
  })
  @IsOptional()
  @IsString({ message: "部位必须是字符串" })
  @IsIn(EQUIPMENT_SLOT_KEYS, { message: "部位取值不合法" })
  slot?: string;

  @ApiPropertyOptional({ description: "按定价状态筛：true 只看特殊价，false 只看未定价（走统一价）的商品" })
  @IsOptional()
  @IsIn(["true", "false"], { message: "priced 取值只能是 true / false" })
  priced?: string;
}

/** 商城定价分页结果 */
export class MallPricePageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的商品定价视图", type: [MallPriceItemDto] })
  list: MallPriceItemDto[];
}

/** 设置单件特殊价入参（PUT = upsert） */
export class PutMallPriceDto {
  @ApiProperty({ description: "特殊售价（绑定元宝/件）", minimum: 0, maximum: MALL_PRICE_MAX })
  @IsInt({ message: "售价必须是整数" })
  @Min(0, { message: "售价不能为负" })
  @Max(MALL_PRICE_MAX, { message: "售价超出防御性上限" })
  price!: number;
}

/** 删除特殊价的响应（回到统一价） */
export class MallPriceRemoveDto {
  @ApiProperty({ description: "被删除特殊价的商品 id" })
  id!: string;

  @ApiProperty({ description: "恒为 true（删除成功）" })
  removed!: boolean;
}
