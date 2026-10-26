import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import {
  DAMAGE_BASE_TYPES,
  SKILL_CATEGORY_VALUES,
  SKILL_OWNER_VALUES,
  SKILL_TARGET_TYPE_VALUES,
} from "../../../common/constants/game-config";
import { SkillRow } from "../../../database/rows";

/**
 * 技能配置（#367）
 *
 * 角色与怪物**同一张表**，`owner` 区分；管理端能改的是**玩法字段** ——
 * 冷却 / 耗蓝 / 距离 / 等级 / 伤害系数 / 动作 / 特效 / 释放限制 / 挂载状态。
 * `owner` 与 `id` 不可改（行身份），所以不出现在 PATCH 入参里。
 *
 * 结构校验分工与掉落表同一模式：DTO 做 whitelist 认键 + 单字段上下限，
 * 跨字段的约束（`statusId` 必须真实存在、`damageCoefficients` 至少一条、
 * 状态型技能必须配 `statusId`）下沉到 service，抛 40000。
 */

/** 一条伤害系数（下标即技能等级；baseType 决定「乘在哪个属性上」） */
export class DamageCoefficientDto {
  @ApiProperty({ description: `收益基数属性（${DAMAGE_BASE_TYPES.join(" / ")}）` })
  @IsIn(DAMAGE_BASE_TYPES, { message: `baseType 必须是 ${DAMAGE_BASE_TYPES.join(" / ")} 之一` })
  baseType: string;

  @ApiProperty({ description: "倍率（0 = 该级不造成伤害；上限 100 防止手滑多打两个零）", minimum: 0, maximum: 100 })
  @IsNumber({}, { message: "baseTypeRate 必须是数字" })
  @Min(0, { message: "baseTypeRate 不能小于 0" })
  @Max(100, { message: "baseTypeRate 不能大于 100" })
  baseTypeRate: number;
}

/** 管理端看到的一条技能配置 */
export class SkillDto {
  @ApiProperty({ description: "技能 id（角色技能被技能栏 / 快捷键 / 角色存档引用）" })
  id: string;

  @ApiProperty({ description: `归属：${SKILL_OWNER_VALUES.join(" / ")}`, enum: SKILL_OWNER_VALUES })
  owner: string;

  @ApiProperty({ description: "技能名" })
  label: string;

  @ApiProperty({ description: "技能图标资源路径（resources 相对路径，不含扩展名）" })
  icon: string;

  @ApiProperty({ description: "分类：0 主动 / 1 被动 / 2 状态 / 3 回复（与客户端 SkillType 同值）", enum: SKILL_CATEGORY_VALUES })
  category: string;

  @ApiProperty({ description: "目标类型：0 区域 / 1 单体 / 2 群体 / 3 自身（与客户端 SkillTargetType 同值）", enum: SKILL_TARGET_TYPE_VALUES })
  targetType: string;

  @ApiProperty({ description: "施法动作（客户端动画动作键，如 attack_near；空串 = 不播动作）" })
  action: string;

  @ApiProperty({ description: "技能特效图集路径（空串 = 无特效）" })
  effect: string;

  @ApiProperty({ description: "特效是否播在自己身上" })
  effectOnSelf: boolean;

  @ApiProperty({ description: "冷却（秒）" })
  cooldown: number;

  @ApiProperty({ description: "释放一次消耗的魔法值" })
  mpCost: number;

  @ApiProperty({ description: "施法距离（0 = 不限距离）" })
  distance: number;

  @ApiProperty({ description: "学习 / 开启等级" })
  levelReq: number;

  @ApiProperty({ description: "描述文案" })
  description: string;

  @ApiProperty({ description: "伤害系数（下标 = 技能等级 - 1；状态型技能可为空数组）", type: [DamageCoefficientDto] })
  @Type(() => DamageCoefficientDto)
  damageCoefficients: DamageCoefficientDto[];

  @ApiProperty({ description: "释放成功后给自身挂的状态 id（空串 = 不挂）" })
  statusId: string;

  @ApiProperty({ description: "释放动作锁时长（毫秒；0 = 跟动画时长走）" })
  castLockMs: number;

  @ApiProperty({ description: "是否要求有合法目标（自身 / 状态型技能可关）" })
  requireTarget: boolean;

  @ApiProperty({ description: "是否可被自动战斗 / 挂机释放" })
  canAuto: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: SkillRow): SkillDto {
    const dto = new SkillDto();
    dto.id = row.id;
    dto.owner = row.owner;
    dto.label = row.label;
    dto.icon = row.icon;
    dto.category = row.category;
    dto.targetType = row.target_type;
    dto.action = row.action;
    dto.effect = row.effect;
    dto.effectOnSelf = row.effect_on_self === 1;
    dto.cooldown = row.cooldown;
    dto.mpCost = row.mp_cost;
    dto.distance = row.distance;
    dto.levelReq = row.level_req;
    dto.description = row.description;
    dto.damageCoefficients = parseDamageCoefficients(row.damage_coefficients);
    dto.statusId = row.status_id;
    dto.castLockMs = row.cast_lock_ms;
    dto.requireTarget = row.require_target === 1;
    dto.canAuto = row.can_auto === 1;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 技能列表查询入参 */
export class SkillQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: `归属筛选：${SKILL_OWNER_VALUES.join(" / ")}（不传 = 两边都要）`, enum: SKILL_OWNER_VALUES })
  @IsOptional()
  @IsIn(SKILL_OWNER_VALUES, { message: `owner 必须是 ${SKILL_OWNER_VALUES.join(" / ")} 之一` })
  declare owner?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与技能名" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 技能分页结果 */
export class SkillPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的技能配置", type: [SkillDto] })
  list: SkillDto[];
}

/**
 * 编辑技能入参（**部分更新**）
 *
 * 不改行身份（`id` / `owner`），也不提供创建 / 删除 —— 角色技能清单固定在生成物里；
 * 怪物技能的增删随 #12 主体那一刀开，不在这个入口放行。
 */
export class UpdateSkillDto {
  @ApiPropertyOptional({ description: "技能名（≤50 字）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "技能名必须是字符串" })
  @MaxLength(50, { message: "技能名不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "图标资源路径（≤200 字；空串 = 不显示图标）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标必须是字符串" })
  @MaxLength(200, { message: "图标路径不能超过 200 字" })
  icon?: string;

  @ApiPropertyOptional({ description: "分类：0 主动 / 1 被动 / 2 状态 / 3 回复", enum: SKILL_CATEGORY_VALUES })
  @IsOptional()
  @IsIn(SKILL_CATEGORY_VALUES, { message: `category 必须是 ${SKILL_CATEGORY_VALUES.join(" / ")} 之一` })
  category?: string;

  @ApiPropertyOptional({ description: "目标类型：0 区域 / 1 单体 / 2 群体 / 3 自身", enum: SKILL_TARGET_TYPE_VALUES })
  @IsOptional()
  @IsIn(SKILL_TARGET_TYPE_VALUES, { message: `targetType 必须是 ${SKILL_TARGET_TYPE_VALUES.join(" / ")} 之一` })
  targetType?: string;

  @ApiPropertyOptional({ description: "施法动作（≤50 字；空串 = 不播动作）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "动作必须是字符串" })
  @MaxLength(50, { message: "动作键不能超过 50 字" })
  action?: string;

  @ApiPropertyOptional({ description: "技能特效图集路径（≤200 字；空串 = 无特效）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "特效必须是字符串" })
  @MaxLength(200, { message: "特效路径不能超过 200 字" })
  effect?: string;

  @ApiPropertyOptional({ description: "特效是否播在自己身上" })
  @IsOptional()
  @IsBoolean({ message: "effectOnSelf 必须是布尔值" })
  effectOnSelf?: boolean;

  @ApiPropertyOptional({ description: "冷却（秒，0 = 不限制）", minimum: 0, maximum: 3600 })
  @IsOptional()
  @IsNumber({}, { message: "cooldown 必须是数字" })
  @Min(0, { message: "cooldown 不能小于 0" })
  @Max(3600, { message: "cooldown 不能大于 3600 秒" })
  cooldown?: number;

  @ApiPropertyOptional({ description: "释放消耗魔法值（0 = 不消耗）", minimum: 0, maximum: 1000000 })
  @IsOptional()
  @IsInt({ message: "mpCost 必须是整数" })
  @Min(0, { message: "mpCost 不能小于 0" })
  @Max(1000000, { message: "mpCost 过大" })
  mpCost?: number;

  @ApiPropertyOptional({ description: "施法距离（0 = 不限距离）", minimum: 0, maximum: 100000 })
  @IsOptional()
  @IsNumber({}, { message: "distance 必须是数字" })
  @Min(0, { message: "distance 不能小于 0" })
  @Max(100000, { message: "distance 不能大于 100000" })
  distance?: number;

  @ApiPropertyOptional({ description: "学习 / 开启等级", minimum: 1, maximum: 200 })
  @IsOptional()
  @IsInt({ message: "levelReq 必须是整数" })
  @Min(1, { message: "levelReq 不能小于 1" })
  @Max(200, { message: "levelReq 不能大于 200" })
  levelReq?: number;

  @ApiPropertyOptional({ description: "描述文案（≤500 字）", maxLength: 500 })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(500, { message: "描述不能超过 500 字" })
  description?: string;

  @ApiPropertyOptional({ description: "伤害系数（下标 = 技能等级 - 1，最多 20 级）", type: [DamageCoefficientDto] })
  @IsOptional()
  @IsArray({ message: "damageCoefficients 必须是数组" })
  @ArrayMaxSize(20, { message: "伤害系数最多 20 级" })
  @ValidateNested({ each: true })
  @Type(() => DamageCoefficientDto)
  damageCoefficients?: DamageCoefficientDto[];

  @ApiPropertyOptional({ description: "释放后挂载的状态 id（空串 = 不挂；状态型技能必填）" })
  @IsOptional()
  @IsString({ message: "statusId 必须是字符串" })
  statusId?: string;

  @ApiPropertyOptional({ description: "动作锁时长（毫秒；0 = 跟动画时长走）", minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt({ message: "castLockMs 必须是整数" })
  @Min(0, { message: "castLockMs 不能小于 0" })
  @Max(10000, { message: "castLockMs 不能大于 10000 毫秒" })
  castLockMs?: number;

  @ApiPropertyOptional({ description: "是否要求有合法目标" })
  @IsOptional()
  @IsBoolean({ message: "requireTarget 必须是布尔值" })
  requireTarget?: boolean;

  @ApiPropertyOptional({ description: "是否可被自动战斗 / 挂机释放" })
  @IsOptional()
  @IsBoolean({ message: "canAuto 必须是布尔值" })
  canAuto?: boolean;
}

/** 把落库的 JSON 读成数组（脏数据不炸接口：解析失败按空数组兜底，配置本身还会被下一次写入纠正） */
export function parseDamageCoefficients(raw: string): DamageCoefficientDto[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const dto = new DamageCoefficientDto();
      dto.baseType = String(entry.baseType ?? "");
      dto.baseTypeRate = Number(entry.baseTypeRate) || 0;
      return dto;
    });
  } catch {
    return [];
  }
}
