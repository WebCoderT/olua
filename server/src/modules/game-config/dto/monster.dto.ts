import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { MonsterRow } from "../../../database/rows";

/** 怪物定位取值清单（configs/monster 的 tier：normal / elite / boss；**手写结构常量**，与客户端枚举逐值一致） */
/** 怪物定位取值清单（configs/monster 的 tier：normal / elite / boss；**手写结构常量**，与客户端枚举逐值一致） */
export const MONSTER_TIER_KEYS = ["normal", "elite", "boss"];

/** 等级上下限（防御性校验，与装备同一量级；正常配置远够不着上限） */
export const MONSTER_LEVEL_MIN = 1;
export const MONSTER_LEVEL_MAX = 1000;

/** 生命上限的防御性校验上限 */
export const MONSTER_MAX_HP_MAX = 2_000_000_000;

/** 闭区间属性段（区间值非负整数在这里挡；「min ≤ max」是跨字段约束，由 service 校验）。
 * **必须声明在使用它的 MonsterAttributesDto 之前** —— emitDecoratorMetadata 会在装饰器里
 * 引用这个类，声明顺序倒了运行时就是 TDZ（Cannot access before initialization）。 */
export class AttributeRange {
  @ApiProperty({ description: "下限（含）" })
  @IsInt({ message: "属性下限必须是整数" })
  @Min(0, { message: "属性下限不能为负" })
  min: number;
  @ApiProperty({ description: "上限（含）" })
  @IsInt({ message: "属性上限必须是整数" })
  @Min(0, { message: "属性上限不能为负" })
  max: number;
}

/** 怪物的六项攻防区间（与 ConfigAttributesDto 同构但**没有 maxHp / hpRecover** —— maxHp 是独立列，怪物没有回复属性）。
 * 每项都要 @ValidateNested + @Type：whitelist 只认**校验装饰器**，只挂 @ApiProperty 的键会被 ValidationPipe 整个剥掉。 */
export class MonsterAttributesDto {
  @ApiProperty({ description: "物理攻击区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  physicalAttack: AttributeRange;
  @ApiProperty({ description: "魔法攻击区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  magicAttack: AttributeRange;
  @ApiProperty({ description: "道术攻击区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  taoistAttack: AttributeRange;
  @ApiProperty({ description: "物理防御区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  physicalDefense: AttributeRange;
  @ApiProperty({ description: "魔法防御区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  magicDefense: AttributeRange;
  @ApiProperty({ description: "道术防御区间", type: AttributeRange })
  @ValidateNested()
  @Type(() => AttributeRange)
  taoistDefense: AttributeRange;
}

/** 怪物行 → 六项区间（行里是拍平的 *_min/*_max 列） */
export function monsterAttributesFromRow(row: MonsterRow): MonsterAttributesDto {
  const dto = new MonsterAttributesDto();
  const range = (min: number, max: number): AttributeRange => ({ min, max });
  dto.physicalAttack = range(row.physical_attack_min, row.physical_attack_max);
  dto.magicAttack = range(row.magic_attack_min, row.magic_attack_max);
  dto.taoistAttack = range(row.taoist_attack_min, row.taoist_attack_max);
  dto.physicalDefense = range(row.physical_defense_min, row.physical_defense_max);
  dto.magicDefense = range(row.magic_defense_min, row.magic_defense_max);
  dto.taoistDefense = range(row.taoist_defense_min, row.taoist_defense_max);
  return dto;
}

/** 管理端看到的一条怪物基础数据 */
export class MonsterDto {
  @ApiProperty({ description: "怪物 key（configs/monster 的关联键，如 \"1\"）" })
  id: string;

  @ApiProperty({ description: "名称（头顶名牌，后台可改）" })
  label: string;

  @ApiProperty({ description: "定位（normal / elite / boss；仅作标注，不开放编辑）" })
  tier: string;

  @ApiProperty({ description: "等级（显示用元数据；战斗数值以 maxHp / 六项区间为准）" })
  level: number;

  @ApiProperty({ description: "最大生命" })
  maxHp: number;

  @ApiProperty({ description: "六项攻防区间（0 ≤ min ≤ max）", type: MonsterAttributesDto })
  attributes: MonsterAttributesDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: MonsterRow): MonsterDto {
    const dto = new MonsterDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.tier = row.tier;
    dto.level = row.level;
    dto.maxHp = row.max_hp;
    dto.attributes = monsterAttributesFromRow(row);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 怪物列表查询入参 */
export class MonsterQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({
    description: "按定位筛（取值：" + MONSTER_TIER_KEYS.join(" / ") + "；不落 schema 以免枚举键进两端生成物）",
  })
  @IsOptional()
  @IsString({ message: "定位必须是字符串" })
  @IsIn(MONSTER_TIER_KEYS, { message: "定位取值不合法" })
  tier?: string;
}

/** 怪物分页结果 */
export class MonsterPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的怪物基础数据", type: [MonsterDto] })
  list: MonsterDto[];
}

/**
 * 编辑怪物基础数据入参（**部分更新**）
 *
 * **没有 Create / Delete**：怪物 key 被地图刷怪点 / 掉落表 / 技能引用，清单固定 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 * `tier` 不开放编辑（已展开数值才是结算依据，改标注没有语义）。
 * 改完**即时生效**：世界播种与伤害结算直读 monsters 表，不经缓存。
 */
export class UpdateMonsterDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  label?: string;

  @ApiPropertyOptional({ description: "等级（显示用元数据，不传则不改）", minimum: MONSTER_LEVEL_MIN, maximum: MONSTER_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(MONSTER_LEVEL_MIN, { message: `等级不能小于 ${MONSTER_LEVEL_MIN}` })
  @Max(MONSTER_LEVEL_MAX, { message: `等级不能大于 ${MONSTER_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({ description: "最大生命（不传则不改）", minimum: 1, maximum: MONSTER_MAX_HP_MAX })
  @IsOptional()
  @IsInt({ message: "最大生命必须是整数" })
  @Min(1, { message: "最大生命必须为正" })
  @Max(MONSTER_MAX_HP_MAX, { message: "最大生命超出防御性上限" })
  maxHp?: number;

  @ApiPropertyOptional({
    description: "六项攻防区间（**整份提交、整份替换**，不传则不改；要求 0 ≤ min ≤ max）",
    type: MonsterAttributesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MonsterAttributesDto)
  attributes?: MonsterAttributesDto;
}
