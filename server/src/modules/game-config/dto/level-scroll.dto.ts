import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import {
  LEVEL_SCROLL_DESCRIPTION_MAX,
  LEVEL_SCROLL_ID_PATTERN,
  LEVEL_SCROLL_LABEL_MAX,
  LEVEL_SCROLL_LEVEL_MAX,
  LEVEL_SCROLL_LEVEL_MIN,
  LEVEL_SCROLL_SELL_PRICE_MAX,
  LEVEL_SCROLL_STACK_MAX,
} from "../../../common/constants/level-scrolls";
import { LevelScrollRow } from "../../../database/rows";

/** 管理端看到的一条升级卷轴 */
export class LevelScrollDto {
  @ApiProperty({ description: "物品 id（如 level_scroll_1；背包按它引用）" })
  id: string;

  @ApiProperty({ description: "名称（如「升级卷轴 Lv1」）" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "图标资源路径（resources 相对路径，如 item/scroll/level-scroll）" })
  icon: string;

  @ApiProperty({ description: "可用等级下限（含）：角色等级低于它就用不了" })
  minLevel: number;

  @ApiProperty({ description: "可用等级上限（含）：用完之后角色就会超出这段，需要换下一卷" })
  maxLevel: number;

  @ApiProperty({ description: "最大叠加数量" })
  maxStack: number;

  @ApiProperty({ description: "售卖价（0 = 不可出售）" })
  sellPrice: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: LevelScrollRow): LevelScrollDto {
    const dto = new LevelScrollDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.description = row.description;
    dto.icon = row.icon;
    dto.minLevel = row.min_level;
    dto.maxLevel = row.max_level;
    dto.maxStack = row.max_stack;
    dto.sellPrice = row.sell_price;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 升级卷轴列表查询入参 */
export class LevelScrollQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id / 名称 / 描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 升级卷轴分页结果 */
export class LevelScrollPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的升级卷轴", type: [LevelScrollDto] })
  list: LevelScrollDto[];
}

/**
 * 新建升级卷轴
 *
 * **只填等级区间就能建**：`id` / 名称 / 描述 / 图标都可省 ——
 * 区间正好落在出厂切法（1~999 / 1000~1999 / …）时派生 `level_scroll_<卷号>`、
 * 否则派生 `level_scroll_<下限>_<上限>`；名称同理。
 */
export class CreateLevelScrollDto {
  @ApiPropertyOptional({
    description: "物品 id（缺省按等级区间派生）；小写字母开头、字母数字下划线",
    maxLength: 64,
  })
  @IsOptional()
  @IsString({ message: "id 必须是字符串" })
  @Matches(LEVEL_SCROLL_ID_PATTERN, { message: "id 只能用小写字母、数字与下划线，且以字母开头" })
  id?: string;

  @ApiProperty({ description: "可用等级下限（含）", minimum: LEVEL_SCROLL_LEVEL_MIN, example: 7000 })
  @IsInt({ message: "等级下限必须是整数" })
  @Min(LEVEL_SCROLL_LEVEL_MIN, { message: `等级下限至少为 ${LEVEL_SCROLL_LEVEL_MIN}` })
  @Max(LEVEL_SCROLL_LEVEL_MAX, { message: `等级下限不能超过 ${LEVEL_SCROLL_LEVEL_MAX}` })
  minLevel: number;

  @ApiProperty({ description: "可用等级上限（含），必须不小于下限", minimum: LEVEL_SCROLL_LEVEL_MIN, example: 7999 })
  @IsInt({ message: "等级上限必须是整数" })
  @Min(LEVEL_SCROLL_LEVEL_MIN, { message: `等级上限至少为 ${LEVEL_SCROLL_LEVEL_MIN}` })
  @Max(LEVEL_SCROLL_LEVEL_MAX, { message: `等级上限不能超过 ${LEVEL_SCROLL_LEVEL_MAX}` })
  maxLevel: number;

  @ApiPropertyOptional({ description: "名称（缺省按等级区间派生）", maxLength: LEVEL_SCROLL_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(LEVEL_SCROLL_LABEL_MAX, { message: `名称最长 ${LEVEL_SCROLL_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（缺省按等级区间生成）", maxLength: LEVEL_SCROLL_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(LEVEL_SCROLL_DESCRIPTION_MAX, { message: `描述最长 ${LEVEL_SCROLL_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "图标资源路径（缺省 = item/scroll/level-scroll）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标路径必须是字符串" })
  @MaxLength(200, { message: "图标路径最长 200 个字符" })
  icon?: string;

  @ApiPropertyOptional({ description: "最大叠加数量（缺省 999）", minimum: 1, maximum: LEVEL_SCROLL_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "叠加上限必须是整数" })
  @Min(1, { message: "叠加上限至少为 1" })
  @Max(LEVEL_SCROLL_STACK_MAX, { message: `叠加上限不能超过 ${LEVEL_SCROLL_STACK_MAX}` })
  maxStack?: number;

  @ApiPropertyOptional({ description: "售卖价（0 = 不可出售；缺省 0）", minimum: 0, maximum: LEVEL_SCROLL_SELL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(LEVEL_SCROLL_SELL_PRICE_MAX, { message: `售卖价不能超过 ${LEVEL_SCROLL_SELL_PRICE_MAX}` })
  sellPrice?: number;
}

/**
 * 编辑升级卷轴（部分更新）
 *
 * **`id` 不可改**（路径参数就是主键）：改 id 等于换一件物品，背包里旧 id 会全变成认不出的格子。
 * 两列区间可以只改一个 —— 但改完 `minLevel > maxLevel` 会被拒（40000），
 * 所以「把区间整体挪上去」要分两次调用，或者一次把两个都传上。
 */
export class UpdateLevelScrollDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: LEVEL_SCROLL_LABEL_MAX })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(LEVEL_SCROLL_LABEL_MAX, { message: `名称最长 ${LEVEL_SCROLL_LABEL_MAX} 个字` })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改）", maxLength: LEVEL_SCROLL_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(LEVEL_SCROLL_DESCRIPTION_MAX, { message: `描述最长 ${LEVEL_SCROLL_DESCRIPTION_MAX} 个字` })
  description?: string;

  @ApiPropertyOptional({ description: "图标资源路径（不传则不改）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标路径必须是字符串" })
  @MaxLength(200, { message: "图标路径最长 200 个字符" })
  icon?: string;

  @ApiPropertyOptional({ description: "可用等级下限（不传则不改）", minimum: LEVEL_SCROLL_LEVEL_MIN })
  @IsOptional()
  @IsInt({ message: "等级下限必须是整数" })
  @Min(LEVEL_SCROLL_LEVEL_MIN, { message: `等级下限至少为 ${LEVEL_SCROLL_LEVEL_MIN}` })
  @Max(LEVEL_SCROLL_LEVEL_MAX, { message: `等级下限不能超过 ${LEVEL_SCROLL_LEVEL_MAX}` })
  minLevel?: number;

  @ApiPropertyOptional({ description: "可用等级上限（不传则不改）", minimum: LEVEL_SCROLL_LEVEL_MIN })
  @IsOptional()
  @IsInt({ message: "等级上限必须是整数" })
  @Min(LEVEL_SCROLL_LEVEL_MIN, { message: `等级上限至少为 ${LEVEL_SCROLL_LEVEL_MIN}` })
  @Max(LEVEL_SCROLL_LEVEL_MAX, { message: `等级上限不能超过 ${LEVEL_SCROLL_LEVEL_MAX}` })
  maxLevel?: number;

  @ApiPropertyOptional({ description: "最大叠加数量（不传则不改）", minimum: 1, maximum: LEVEL_SCROLL_STACK_MAX })
  @IsOptional()
  @IsInt({ message: "叠加上限必须是整数" })
  @Min(1, { message: "叠加上限至少为 1" })
  @Max(LEVEL_SCROLL_STACK_MAX, { message: `叠加上限不能超过 ${LEVEL_SCROLL_STACK_MAX}` })
  maxStack?: number;

  @ApiPropertyOptional({ description: "售卖价（不传则不改）", minimum: 0, maximum: LEVEL_SCROLL_SELL_PRICE_MAX })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(LEVEL_SCROLL_SELL_PRICE_MAX, { message: `售卖价不能超过 ${LEVEL_SCROLL_SELL_PRICE_MAX}` })
  sellPrice?: number;
}

/** 删除升级卷轴的结果（删掉了几行；不碰玩家存档） */
export class RemoveLevelScrollResultDto {
  @ApiProperty({ description: "被删除的卷轴 id" })
  id: string;

  @ApiProperty({ description: "实际删除的行数（正常为 1；0 说明刚被别人删掉了）" })
  removed: number;
}
