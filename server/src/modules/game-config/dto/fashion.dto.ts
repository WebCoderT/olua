import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { ACQUIRE_CHANNELS } from "../../../common/constants/game-config";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { FashionRow } from "../../../database/rows";
import { attributesFromRow, ConfigAttributesDto } from "./title.dto";
import { MALL_PRICE_MAX } from "./mall.dto";

/**
 * 时装配置（#257）—— 形状与称号 / 战魂高度同构（八项属性 + 渠道 + 价格），
 * 所以属性嵌套对象与行转换**直接复用** title.dto 的 ConfigAttributesDto / attributesFromRow
 * （FashionRow 的属性列与 TitleRow 拍平列同构）。
 */

/** 名称 / 描述的长度上限（与称号同一量级；描述给宽一点，是给运营写卖点的） */
export const FASHION_LABEL_MAX = 50;
export const FASHION_DESCRIPTION_MAX = 500;

/** 管理端看到的一条时装配置 */
export class FashionDto {
  @ApiProperty({ description: "时装 id（configs/fashionClothes，如 \"cloth_2\"；序列固定，不可增删行）" })
  id: string;

  @ApiProperty({ description: "名称（后台可改）" })
  label: string;

  @ApiProperty({ description: "描述文案（后台可改）" })
  description: string;

  @ApiProperty({ description: "图标资源路径（resources 相对路径；不开放编辑）" })
  icon: string;

  @ApiProperty({ description: "内观资源路径（空串 = 无；不开放编辑）" })
  inRes: string;

  @ApiProperty({ description: "外观资源路径（空串 = 无；不开放编辑）" })
  outRes: string;

  @ApiProperty({ description: "售卖价（绑定元宝/件，后台可改）" })
  sellPrice: number;

  @ApiProperty({ description: "获得渠道（upgrade / grant / unavailable，默认 unavailable；后台可改）", enum: [...ACQUIRE_CHANNELS] })
  acquireChannel: string;

  @ApiProperty({ description: "八项属性加成（seed 时全 0，后台可改）", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: FashionRow): FashionDto {
    const dto = new FashionDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.description = row.description;
    dto.icon = row.icon;
    dto.inRes = row.in_res;
    dto.outRes = row.out_res;
    dto.sellPrice = row.sell_price;
    dto.acquireChannel = row.acquire_channel;
    dto.attributes = attributesFromRow(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 时装列表查询入参 */
export class FashionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "按获得渠道筛（不落 schema 以免枚举键进两端生成物）", enum: [...ACQUIRE_CHANNELS] })
  @IsOptional()
  @IsString({ message: "获得渠道必须是字符串" })
  @IsIn([...ACQUIRE_CHANNELS], { message: "获得渠道取值不合法" })
  acquireChannel?: string;
}

/** 时装分页结果 */
export class FashionPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的时装配置", type: [FashionDto] })
  list: FashionDto[];
}

/**
 * 编辑时装入参（**部分更新**）
 *
 * **没有 Create / Delete**：时装 id 被客户端配置与未来的穿戴 / 衣柜链路引用，
 * 清单固定 —— 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * `icon` / `inRes` / `outRes` 是客户端资源路径（表现层），不开放编辑 ——
 * e2e 会固化「传了也被白名单剥离」。
 */
export class UpdateFashionDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: FASHION_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(FASHION_LABEL_MAX, { message: `名称最长 ${FASHION_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述文案（不传则不改）", maxLength: FASHION_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(FASHION_DESCRIPTION_MAX, { message: `描述最长 ${FASHION_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "售卖价（绑定元宝/件，不传则不改）", minimum: 0, maximum: MALL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(MALL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "获得渠道（不传则不改）", enum: [...ACQUIRE_CHANNELS] })
  @IsOptional()
  @IsString({ message: "获得渠道必须是字符串" })
  @IsIn([...ACQUIRE_CHANNELS], { message: "获得渠道取值不合法" })
  acquireChannel?: string;

  @ApiPropertyOptional({
    description: "八项属性（**整份提交、整份替换**，不传则不改；区间型要求 0 ≤ min ≤ max）",
    type: ConfigAttributesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigAttributesDto)
  attributes?: ConfigAttributesDto;
}
