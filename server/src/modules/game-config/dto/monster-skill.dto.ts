import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { MonsterSkillRow } from "../../../database/rows";

/**
 * 怪物技能挂载（#372）
 *
 * 一张很小的关系表：`monster_key + skill_id`，再加优先级与可选冷却覆写。
 * 与「技能本身」（`skills` 表 owner=monster）分家的原因：一个技能可以被多只怪共用，
 * 挂载是关系不是属性 —— 挂在技能行上就等于「同一个技能给第二只怪」时复制一份技能。
 *
 * 纪律与每怪掉落表一致：**整份替换**（PUT），没有单条增删 ——
 * 「删掉中间一条」拆成单条接口反而更容易写出半份清单。
 */

/** 管理端看到的一条挂载 */
export class MonsterSkillDto {
  @ApiProperty({ description: "怪物 key（与 monsters 表主键一致）" })
  monsterKey: string;

  @ApiProperty({ description: "技能 id（skills 表里 owner=monster 的行）" })
  skillId: string;

  @ApiProperty({ description: "技能名（冗余展示用，来源 skills.label）" })
  skillLabel: string;

  @ApiProperty({ description: "优先级（越小越先；状态型整体先于伤害型尝试）" })
  priority: number;

  @ApiProperty({ description: "冷却覆写（秒；null = 用技能自身的 cooldown）", nullable: true })
  cooldown: number | null;

  @ApiProperty({ description: "最后修改时间（毫秒时间戳）" })
  updatedAt: number;

  static from(row: MonsterSkillRow, skillLabel: string): MonsterSkillDto {
    const dto = new MonsterSkillDto();
    dto.monsterKey = row.monster_key;
    dto.skillId = row.skill_id;
    dto.skillLabel = skillLabel;
    dto.priority = row.priority;
    dto.cooldown = row.cooldown;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 一只怪的挂载清单（量小不分页） */
export class MonsterSkillListDto {
  @ApiProperty({ description: "挂载清单（按优先级升序）", type: [MonsterSkillDto] })
  list: MonsterSkillDto[];

  @ApiProperty({ description: "条数" })
  total: number;
}

/** 整份替换时的一条（不带 monsterKey：路径参数已经指明是哪只怪） */
export class MonsterSkillItemDto {
  @ApiProperty({ description: "技能 id（必须在 skills 表里存在且 owner=monster；不存在 → 400 40000）" })
  @IsString({ message: "skillId 必须是字符串" })
  skillId: string;

  @ApiPropertyOptional({ description: "优先级（越小越先，缺省 0；同优先级按技能 id 排序）", minimum: -9999, maximum: 9999 })
  @IsOptional()
  @IsInt({ message: "priority 必须是整数" })
  @Min(-9999, { message: "priority 不能小于 -9999" })
  @Max(9999, { message: "priority 不能大于 9999" })
  priority?: number;

  @ApiPropertyOptional({ description: "冷却覆写（秒；不传 = 用技能自身的 cooldown）", minimum: 0, maximum: 3600 })
  @IsOptional()
  @IsNumber({}, { message: "cooldown 必须是数字" })
  @Min(0, { message: "cooldown 不能小于 0" })
  @Max(3600, { message: "cooldown 不能大于 3600 秒" })
  cooldown?: number;
}

/** 整份替换某只怪的挂载清单（空数组 = 这只怪不再放技能） */
export class ReplaceMonsterSkillsDto {
  @ApiProperty({ description: "完整清单（整份替换；空数组 = 清空，AI 回退到普攻）", type: [MonsterSkillItemDto] })
  @IsArray({ message: "skills 必须是数组" })
  @ArrayMaxSize(20, { message: "一只怪最多挂 20 个技能" })
  @ValidateNested({ each: true })
  @Type(() => MonsterSkillItemDto)
  skills: MonsterSkillItemDto[];
}

/**
 * 挂载入参的归属校验（技能必须存在且是怪物技能）
 *
 * 放在 DTO 之外的说明：这是**跨表**约束（要去查 skills 表），DTO 只做形状与取值域。
 */
export const MONSTER_SKILL_OWNER_HINT = "只能挂 owner=monster 的技能（角色技能由技能栏 / 存档引用，不属于任何怪物）";

/** 状态 combat 的取值域提示（接口文档用） */
export const COMBAT_KEYS_HINT = "blockChance / blockFactor / defenseMultiplier / attackMultiplier";
