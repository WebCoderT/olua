import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { ACQUIRE_CHANNELS, AcquireChannel, AcquireChannelValue } from "../../../common/constants/game-config";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { TitleRow } from "../../../database/rows";

/** 名称 / 描述 / 动画资源的长度上限（描述给宽一点，是给运营写玩法说明的） */
export const TITLE_LABEL_MAX = 20;
export const TITLE_DESCRIPTION_MAX = 200;
export const TITLE_ANIMATION_MAX = 100;

/** 一项区间型属性（下限 / 上限；跨字段的大小关系由 service 合并后校验） */
export class ConfigAttributeRangeDto {
  @ApiProperty({ description: "下限", minimum: 0 })
  @IsInt({ message: "属性下限必须是整数" })
  @Min(0, { message: "属性下限不能为负" })
  min: number;

  @ApiProperty({ description: "上限", minimum: 0 })
  @IsInt({ message: "属性上限必须是整数" })
  @Min(0, { message: "属性上限不能为负" })
  max: number;
}

/** 八项属性（与客户端 TitleAttributes / SoulAttributes 同构；整份提交、整份替换） */
export class ConfigAttributesDto {
  @ApiProperty({ description: "生命上限加成" })
  @IsInt({ message: "maxHp 必须是整数" })
  @Min(0, { message: "maxHp 不能为负" })
  maxHp: number;

  @ApiProperty({ description: "每 5 秒回血" })
  @IsInt({ message: "hpRecover 必须是整数" })
  @Min(0, { message: "hpRecover 不能为负" })
  hpRecover: number;

  @ApiProperty({ description: "物理攻击 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  physicalAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔法攻击 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  magicAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道术攻击 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  taoistAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "物理防御 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  physicalDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔法防御 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  magicDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道术防御 [下限, 上限]", type: ConfigAttributeRangeDto })
  @ValidateNested()
  @Type(() => ConfigAttributeRangeDto)
  taoistDefense: ConfigAttributeRangeDto;
}

/** 管理端看到的一条称号配置 */
export class TitleDto {
  @ApiProperty({ description: "等级（1 起；序列固定，不可增删行）" })
  level: number;

  @ApiProperty({ description: "名称" })
  label: string;

  @ApiProperty({ description: "描述" })
  description: string;

  @ApiProperty({ description: "动画资源目录（resources 相对路径）" })
  animation: string;

  @ApiProperty({ description: "动画帧率" })
  animationFrameRate: number;

  @ApiProperty({ description: "升到该级消耗的绑定元宝（仅 upgrade 渠道实际使用）" })
  bindGold: number;

  @ApiProperty({ description: "获得渠道", enum: [...ACQUIRE_CHANNELS] })
  acquireChannel: string;

  @ApiProperty({ description: "八项属性加成", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: TitleRow): TitleDto {
    const dto = new TitleDto();
    dto.level = row.level;
    dto.label = row.label;
    dto.description = row.description;
    dto.animation = row.animation;
    dto.animationFrameRate = row.animation_frame_rate;
    dto.bindGold = row.bind_gold;
    dto.acquireChannel = row.acquire_channel;
    dto.attributes = attributesFromRow(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 拍平的属性列 → 与客户端同构的嵌套对象（TitleRow / SoulRow 共用这一份转换） */
export function attributesFromRow(row: TitleRow | SoulRowShape): ConfigAttributesDto {
  const out = new ConfigAttributesDto();
  out.maxHp = row.max_hp;
  out.hpRecover = row.hp_recover;
  out.physicalAttack = range(row.physical_attack_min, row.physical_attack_max);
  out.magicAttack = range(row.magic_attack_min, row.magic_attack_max);
  out.taoistAttack = range(row.taoist_attack_min, row.taoist_attack_max);
  out.physicalDefense = range(row.physical_defense_min, row.physical_defense_max);
  out.magicDefense = range(row.magic_defense_min, row.magic_defense_max);
  out.taoistDefense = range(row.taoist_defense_min, row.taoist_defense_max);
  return out;
}

/** 嵌套属性 → 拍平行（仅列名不同，两个仓储各自展开） */
export function rangeOf(attributes: ConfigAttributesDto, key: keyof ConfigAttributesDto): [number, number] {
  const value = attributes[key] as ConfigAttributeRangeDto;
  return [value.min, value.max];
}

function range(min: number, max: number): ConfigAttributeRangeDto {
  const out = new ConfigAttributeRangeDto();
  out.min = min;
  out.max = max;
  return out;
}

/** attributesFromRow 能接受的行形状（TitleRow / SoulRow 的属性列同构） */
export type SoulRowShape = Pick<
  TitleRow,
  | "max_hp"
  | "hp_recover"
  | "physical_attack_min"
  | "physical_attack_max"
  | "magic_attack_min"
  | "magic_attack_max"
  | "taoist_attack_min"
  | "taoist_attack_max"
  | "physical_defense_min"
  | "physical_defense_max"
  | "magic_defense_min"
  | "magic_defense_max"
  | "taoist_defense_min"
  | "taoist_defense_max"
>;

/** 称号列表查询入参 */
export class TitleQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配名称与描述" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({ description: "获得渠道筛选", enum: [...ACQUIRE_CHANNELS] })
  @IsOptional()
  @IsString({ message: "获得渠道必须是字符串" })
  @IsIn([...ACQUIRE_CHANNELS], { message: "获得渠道取值不合法" })
  acquireChannel?: string;
}

/** 称号分页结果 */
export class TitlePageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的称号配置", type: [TitleDto] })
  list: TitleDto[];
}

/**
 * 编辑称号入参（**部分更新**）
 *
 * **没有 Create**：称号等级序列固定，后台只允许改 —— 这是有意不提供的能力，
 * 不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 */
export class UpdateTitleDto {
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

  @ApiPropertyOptional({ description: "升到该级消耗的绑定元宝（不传则不改）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "价格必须是整数" })
  @Min(0, { message: "价格不能为负" })
  bindGold?: number;

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

/** seed 用的默认渠道常量（只想表达「新行都是无法获取」，不想到处写字面量） */
export const SEED_ACQUIRE_CHANNEL: AcquireChannelValue = AcquireChannel.UNAVAILABLE;
