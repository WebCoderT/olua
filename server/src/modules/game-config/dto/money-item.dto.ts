import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import {
  MONEY_AMOUNT_MAX,
  MONEY_ITEM_DESCRIPTION_MAX,
  MONEY_ITEM_ID_PATTERN,
  MONEY_ITEM_LABEL_MAX,
  MONEY_ITEM_STACK_MAX,
  MONEY_KINDS,
  MONEY_KIND_LABELS,
  MoneyKind,
} from "../../../common/constants/money-items";
import { MoneyItemRow } from "../../../database/rows";

/** 售价上限（与药品 / 物品同一档；货币道具默认 0 = 不可出售） */
export const MONEY_ITEM_SELL_PRICE_MAX = 100_000_000;

/** 管理端看到的一条货币物品 */
export class MoneyItemDto {
  @ApiProperty({ description: "物品 id（如 money_bind_gold_10；背包按它引用）" })
  id: string;

  @ApiProperty({ description: "名称（如「绑定元宝（10）」）" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "图标资源路径（resources 相对路径，如 item/currency/bind-gold-10）" })
  icon: string;

  @ApiProperty({
    description: "入账到哪个账本字段：" + MONEY_KINDS.map((kind) => `${kind} = ${MONEY_KIND_LABELS[kind]}`).join(" / "),
  })
  currency: string;

  @ApiProperty({ description: "单件入账金额（使用一个就加这么多）" })
  amount: number;

  @ApiProperty({ description: "最大叠加数量" })
  maxStack: number;

  @ApiProperty({ description: "售卖价（0 = 不可出售）" })
  sellPrice: number;

  @ApiProperty({ description: "掉落时强制绑定（#789）：true = 掉出来就绑定角色、不可交易" })
  bindOnDrop: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: MoneyItemRow): MoneyItemDto {
    const dto = new MoneyItemDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.description = row.description;
    dto.icon = row.icon;
    dto.currency = row.currency;
    dto.amount = row.amount;
    dto.maxStack = row.max_stack;
    dto.sellPrice = row.sell_price;
    dto.bindOnDrop = row.bind_on_drop === 1;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 货币物品列表查询入参 */
export class MoneyItemQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id / 名称 / 描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "只看某种货币（" + MONEY_KINDS.join(" / ") + "）" })
  @IsOptional()
  @IsString({ message: "货币类型必须是字符串" })
  @IsIn([...MONEY_KINDS], { message: "货币类型取值不合法" })
  currency?: string;
}

/** 货币物品分页结果 */
export class MoneyItemPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的货币物品", type: [MoneyItemDto] })
  list: MoneyItemDto[];
}

/**
 * 新建货币物品
 *
 * `id` / `label` / `description` / `icon` 都可省：缺省按「货币 + 面值」派生
 * （`money_bind_gold_10` / `绑定元宝（10）` / `item/currency/bind-gold-10`）。
 * 派生规则与服务端出厂清单（`common/constants/money-items`）是同一个函数 ——
 * 运营新建出来的行与出厂行长得一样，不必手填 4 个字段。
 */
export class CreateMoneyItemDto {
  @ApiPropertyOptional({
    description: "物品 id（缺省 = money_<货币>_<面值>，如 money_gold_100）；小写字母开头、字母数字下划线",
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: "id 必须是字符串" })
  @Matches(MONEY_ITEM_ID_PATTERN, { message: "id 只能用小写字母、数字与下划线，且以字母开头" })
  id?: string;

  @ApiProperty({ description: "货币类型：bindGold（绑定元宝）/ gold（元宝）/ silver（银子）" })
  @IsIn([...MONEY_KINDS], { message: "货币类型取值不合法" })
  currency: MoneyKind;

  @ApiProperty({ description: "单件入账金额（1 ~ 1000000）", minimum: 1, maximum: MONEY_AMOUNT_MAX, example: 100 })
  @IsInt({ message: "金额必须是整数" })
  @Min(1, { message: "金额必须大于 0" })
  @Max(MONEY_AMOUNT_MAX, { message: `金额不能超过 ${MONEY_AMOUNT_MAX}` })
  amount: number;

  @ApiPropertyOptional({ description: "名称（缺省 = 「货币中文名（面值）」）", maxLength: MONEY_ITEM_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(MONEY_ITEM_LABEL_MAX, { message: `名称最长 ${MONEY_ITEM_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（缺省 = 「使用后获得 N 点…」）", maxLength: MONEY_ITEM_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(MONEY_ITEM_DESCRIPTION_MAX, { message: `描述最长 ${MONEY_ITEM_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "图标资源路径（缺省 = item/currency/<货币>-<面值>）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标路径必须是字符串" })
  @MaxLength(200, { message: "图标路径最长 200 个字符" })
  icon?: string;

  @ApiPropertyOptional({ description: "最大叠加数量（缺省 999）", minimum: 1, maximum: MONEY_ITEM_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "叠加上限必须是整数" })
  @Min(1, { message: "叠加上限至少为 1" })
  @Max(MONEY_ITEM_STACK_MAX, { message: `叠加上限不能超过 ${MONEY_ITEM_STACK_MAX}` })
  maxStack?: number;

  @ApiPropertyOptional({ description: "售卖价（0 = 不可出售；缺省 0）", minimum: 0, maximum: MONEY_ITEM_SELL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(MONEY_ITEM_SELL_PRICE_MAX, { message: `售卖价不能超过 ${MONEY_ITEM_SELL_PRICE_MAX}` })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "掉落时强制绑定（#789；缺省 false）" })
  @IsOptional()
  @IsBoolean({ message: "掉落强制绑定必须是布尔值" })
  bindOnDrop?: boolean;
}

/**
 * 编辑货币物品（部分更新）
 *
 * **`id` 不可改**（路径参数就是主键）：改 id 等于换一件物品，背包里旧 id 会全变成认不出的格子。
 * 改 `currency` / `amount` 不会连带改 id —— id 只是键，运营想保持 `money_gold_10` 这个
 * 名字却也行（不推荐；新建时按面值派生更清楚）。
 */
export class UpdateMoneyItemDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: MONEY_ITEM_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(MONEY_ITEM_LABEL_MAX, { message: `名称最长 ${MONEY_ITEM_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: MONEY_ITEM_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(MONEY_ITEM_DESCRIPTION_MAX, { message: `描述最长 ${MONEY_ITEM_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "图标资源路径（不传则不改）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标路径必须是字符串" })
  @MaxLength(200, { message: "图标路径最长 200 个字符" })
  icon?: string;

  @ApiPropertyOptional({ description: "货币类型（不传则不改）" })
  @IsOptional()
  @IsIn([...MONEY_KINDS], { message: "货币类型取值不合法" })
  currency?: MoneyKind;

  @ApiPropertyOptional({ description: "单件入账金额（不传则不改）", minimum: 1, maximum: MONEY_AMOUNT_MAX })
  @IsOptional()
  @IsInt({ message: "金额必须是整数" })
  @Min(1, { message: "金额必须大于 0" })
  @Max(MONEY_AMOUNT_MAX, { message: `金额不能超过 ${MONEY_AMOUNT_MAX}` })
  amount?: number;

  @ApiPropertyOptional({ description: "最大叠加数量（不传则不改）", minimum: 1, maximum: MONEY_ITEM_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "叠加上限必须是整数" })
  @Min(1, { message: "叠加上限至少为 1" })
  @Max(MONEY_ITEM_STACK_MAX, { message: `叠加上限不能超过 ${MONEY_ITEM_STACK_MAX}` })
  maxStack?: number;

  @ApiPropertyOptional({ description: "售卖价（不传则不改）", minimum: 0, maximum: MONEY_ITEM_SELL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(MONEY_ITEM_SELL_PRICE_MAX, { message: `售卖价不能超过 ${MONEY_ITEM_SELL_PRICE_MAX}` })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "掉落时强制绑定（#789；不传则不改）" })
  @IsOptional()
  @IsBoolean({ message: "掉落强制绑定必须是布尔值" })
  bindOnDrop?: boolean;
}

/** 删除货币物品的结果（删掉了几行；不碰玩家存档） */
export class RemoveMoneyItemResultDto {
  @ApiProperty({ description: "被删除的物品 id" })
  id: string;

  @ApiProperty({ description: "实际删除的行数（正常为 1；0 说明刚被别人删掉了）" })
  removed: number;
}
