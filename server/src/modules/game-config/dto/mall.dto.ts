import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { EQUIPMENT_SLOT_KEYS } from "./equipment.dto";

/** 售价与购买等级的防御性上限（绑定元宝计价；与装备售卖价同一量级） */
export const MALL_PRICE_MAX = 100_000_000;
/** 购买等级上限（与角色等级表同一量级） */
export const MALL_LEVEL_MAX = 10_000;

/**
 * 商城可上架的品类（#763）
 *
 * 商品是**关联数据**，所以「能卖什么」由目录决定而不是运营手输：目前两类 ——
 * 装备变体（`equipment_variants`，每件基础件 15 行）与药品（`drugs`，11 行）。
 * 材料（`items`）暂不上架：它们没有可用的图标/等级口径，卖了玩家也不知道是干什么的。
 */
export const MALL_GOOD_KINDS = ["equipment", "drug"] as const;

/** 上架弹窗「分类」下拉里表示药品的那一项（其余取值 = 装备部位 key） */
export const MALL_CATEGORY_DRUG = "drug";

/** 商城分类（运营自建的陈列分组） */
export class MallCategoryDto {
  @ApiProperty({ description: "分类 id（自建时由服务端生成）" })
  id: string;

  @ApiProperty({ description: "显示名（管理端与客户端页签共用）" })
  label: string;

  @ApiProperty({ description: "排序值（小者在先）" })
  sortOrder: number;

  @ApiProperty({ description: "分类下的上架商品数" })
  goodCount: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: { id: string; label: string; sort_order: number; updated_at: number }, goodCount = 0): MallCategoryDto {
    const dto = new MallCategoryDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.sortOrder = row.sort_order;
    dto.goodCount = goodCount;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 新建分类入参（id 由服务端生成，运营只给名字与排序） */
export class CreateMallCategoryDto {
  @ApiProperty({ description: "分类显示名（1~20 字）", minLength: 1, maxLength: 20 })
  @IsString({ message: "分类名必须是字符串" })
  @MinLength(1, { message: "分类名不能为空" })
  @MaxLength(20, { message: "分类名最长 20 字" })
  label!: string;

  @ApiPropertyOptional({ description: "排序值（缺省排到最后）" })
  @IsOptional()
  @IsInt({ message: "排序值必须是整数" })
  sortOrder?: number;
}

/** 修改分类入参（只许改名字与排序；分类不带任何数值） */
export class UpdateMallCategoryDto {
  @ApiPropertyOptional({ description: "分类显示名（1~20 字）" })
  @IsOptional()
  @IsString({ message: "分类名必须是字符串" })
  @MinLength(1, { message: "分类名不能为空" })
  @MaxLength(20, { message: "分类名最长 20 字" })
  label?: string;

  @ApiPropertyOptional({ description: "排序值（小者在先）" })
  @IsOptional()
  @IsInt({ message: "排序值必须是整数" })
  sortOrder?: number;
}

/** 删除分类的响应 */
export class MallCategoryRemoveDto {
  @ApiProperty({ description: "被删除的分类 id" })
  id!: string;

  @ApiProperty({ description: "恒为 true（删除成功）" })
  removed!: boolean;
}

/**
 * 一条上架商品视图（商品本体字段来自装备 / 药品数据，价格与等级来自 mall_goods）
 *
 * `kind / label / icon / slot / level / prefix / suffix` 是**只读展示** ——
 * 商品是关联数据，运营只改 `price`（售价）与 `requiredLevel`（购买等级）。
 *
 * 前后缀只给序号不给中文名：文案住在 `equipment_meta`（「装备设置」页可改），
 * 一处改动全场跟着变，管理端按序号查表显示。药品没有部位与前后缀（`slot` 空、两位 0）。
 */
export class MallGoodItemDto {
  @ApiProperty({ description: "商品 id（装备变体 id，如 cloth_1_p3s2；药品为其 drugs.id）" })
  id: string;

  @ApiProperty({ description: "所属分类 id" })
  categoryId: string;

  @ApiProperty({ description: "品类：equipment（装备）/ drug（药品）" })
  kind: string;

  @ApiProperty({ description: "显示名（装备取变体名，药品取 drugs.label）" })
  label: string;

  @ApiProperty({ description: "图标（resources 相对路径；装备取基础件图标，药品取 drugs.icon）" })
  icon: string;

  @ApiProperty({ description: "部位（EQUIPMENT_TYPE 的枚举值；药品为空串）" })
  slot: string;

  @ApiProperty({ description: "装备的等级需求（装备数据，只读展示）" })
  level: number;

  @ApiProperty({ description: "前缀序号（品质；文案在 equipment_meta.prefix_labels，只读展示）" })
  prefix: number;

  @ApiProperty({ description: "后缀序号（阶级；文案在 equipment_meta.suffix_labels，只读展示）" })
  suffix: number;

  @ApiProperty({ description: "售价（绑定元宝/件；0 = 免费）" })
  price: number;

  @ApiProperty({ description: "购买等级（角色等级不足时禁购）" })
  requiredLevel: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;
}

/** 上架商品列表查询入参 */
export class MallGoodQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "按分类筛（分类 id）" })
  @IsOptional()
  @IsString({ message: "分类 id 必须是字符串" })
  categoryId?: string;

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

  @ApiPropertyOptional({ description: "按品类筛：equipment（装备）/ drug（药品）" })
  @IsOptional()
  @IsString({ message: "品类必须是字符串" })
  @IsIn(MALL_GOOD_KINDS, { message: "品类取值不合法" })
  kind?: string;

  @ApiPropertyOptional({ description: "按物品等级精确筛（装备等级需求 / 药品等级；留空 = 全部）", minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级必须是整数" })
  @Min(0, { message: "等级不能为负" })
  level?: number;
}

/**
 * 上架弹窗的「可上架目录」查询（#763）
 *
 * `category` 是**物品自己的分类**，不是商城的陈列分类：装备填部位 key（weapon / cloth …），
 * 药品填 `drug`，留空 = 全部。`level` 是精确等级（装备等级需求 / 药品等级），留空 = 全部。
 */
export class MallCatalogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: "物品分类：部位 key（" + EQUIPMENT_SLOT_KEYS.join(" / ") + "）或 drug（药品）；留空 = 全部",
  })
  @IsOptional()
  @IsString({ message: "分类必须是字符串" })
  @IsIn([...EQUIPMENT_SLOT_KEYS, MALL_CATEGORY_DRUG], { message: "分类取值不合法" })
  category?: string;

  @ApiPropertyOptional({ description: "精确等级（留空 = 全部等级）", minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级必须是整数" })
  @Min(0, { message: "等级不能为负" })
  level?: number;

  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 上架弹窗里的一条候选物品（`listed` 已在商城上架的行也照实列出，好让运营知道别再点） */
export class MallCatalogItemDto {
  @ApiProperty({ description: "物品 id（装备变体 id / 药品 id）" })
  id: string;

  @ApiProperty({ description: "品类：equipment（装备）/ drug（药品）" })
  kind: string;

  @ApiProperty({ description: "显示名" })
  label: string;

  @ApiProperty({ description: "图标（resources 相对路径）" })
  icon: string;

  @ApiProperty({ description: "部位（药品为空串）" })
  slot: string;

  @ApiProperty({ description: "等级（装备等级需求 / 药品等级）" })
  level: number;

  @ApiProperty({ description: "前缀序号（品质；药品恒 0）" })
  prefix: number;

  @ApiProperty({ description: "后缀序号（阶级；药品恒 0）" })
  suffix: number;

  @ApiProperty({ description: "是否已在商城上架（一件物品全商城只能挂一行）" })
  listed: boolean;
}

/** 可上架目录分页结果（`levels` = 当前分类下出现过的等级，给弹窗的等级下拉用） */
export class MallCatalogPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的候选物品", type: [MallCatalogItemDto] })
  list: MallCatalogItemDto[];

  @ApiProperty({ description: "当前分类下出现过的等级（升序去重；与关键字无关）", type: [Number] })
  levels: number[];
}

/** 商城商品分页结果（`levels` = 当前分类范围内出现过的物品等级，给检索下拉用） */
export class MallGoodPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的上架商品视图", type: [MallGoodItemDto] })
  list: MallGoodItemDto[];

  @ApiProperty({ description: "当前分类范围内出现过的物品等级（升序去重；与关键字/等级筛选无关）", type: [Number] })
  levels: number[];
}

/** 上架商品入参（商品 id 必须是装备变体；一件装备只能挂一行） */
export class CreateMallGoodDto {
  @ApiProperty({ description: "商品 id（装备变体 id，如 cloth_1_p3s2）" })
  @IsString({ message: "商品 id 必须是字符串" })
  @MinLength(1, { message: "商品 id 不能为空" })
  id!: string;

  @ApiProperty({ description: "所属分类 id" })
  @IsString({ message: "分类 id 必须是字符串" })
  @MinLength(1, { message: "分类 id 不能为空" })
  categoryId!: string;

  @ApiPropertyOptional({ description: "售价（缺省 0 = 免费）", minimum: 0, maximum: MALL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售价必须是整数" })
  @Min(0, { message: "售价不能为负" })
  @Max(MALL_PRICE_MAX, { message: "售价超出防御性上限" })
  price?: number;

  @ApiPropertyOptional({ description: "购买等级（缺省 0 = 不限等级）", minimum: 0, maximum: MALL_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "购买等级必须是整数" })
  @Min(0, { message: "购买等级不能为负" })
  @Max(MALL_LEVEL_MAX, { message: "购买等级超出防御性上限" })
  requiredLevel?: number;
}

/**
 * 修改商品入参 —— **只许改商城自己的三个字段**（分类 / 售价 / 购买等级）
 *
 * 商品本体是关联数据（装备变体 / 药品），名称 / 图标 / 部位 / 等级归各自的配置页管，
 * 这里一个字都不接受。`categoryId` 是「在商城陈列里挪个位置」，与本体无关。
 */
export class UpdateMallGoodDto {
  @ApiPropertyOptional({ description: "所属分类 id（改分类 = 在商城陈列里挪个位置）" })
  @IsOptional()
  @IsString({ message: "分类 id 必须是字符串" })
  @MinLength(1, { message: "分类 id 不能为空" })
  categoryId?: string;

  @ApiPropertyOptional({ description: "售价（绑定元宝/件）", minimum: 0, maximum: MALL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售价必须是整数" })
  @Min(0, { message: "售价不能为负" })
  @Max(MALL_PRICE_MAX, { message: "售价超出防御性上限" })
  price?: number;

  @ApiPropertyOptional({ description: "购买等级", minimum: 0, maximum: MALL_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "购买等级必须是整数" })
  @Min(0, { message: "购买等级不能为负" })
  @Max(MALL_LEVEL_MAX, { message: "购买等级超出防御性上限" })
  requiredLevel?: number;
}

/** 下架商品的响应 */
export class MallGoodRemoveDto {
  @ApiProperty({ description: "被下架的商品 id" })
  id!: string;

  @ApiProperty({ description: "恒为 true（下架成功）" })
  removed!: boolean;
}

/** 快照段：一条上架商品（客户端陈列与购买都以这段为准） */
export class MallGoodEntryDto {
  @ApiProperty({ description: "商品 id（装备变体 id）" })
  id: string;

  @ApiProperty({ description: "所属分类 id" })
  categoryId: string;

  @ApiProperty({ description: "售价（绑定元宝/件）" })
  price: number;

  @ApiProperty({ description: "购买等级（0 = 不限）" })
  requiredLevel: number;
}
