import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { GrowthScalarRow, RoleLevelRow } from "../../../database/rows";
import { ConfigAttributeRangeDto } from "./title.dto";

// —— 快照等级段 ——

/**
 * 快照 `levels` 段的一行（#590）：某级的**最终**属性与升级经验
 *
 * #655：数据源是 `role_levels`（60 行逐条配置），不再由曲线采样 —— 管理端改第 N 级，
 * 快照这一段下次就是新值。客户端 `levelMap` 整表由这段填充，不自己派生。
 */
export class LevelDto {
  @ApiProperty({ description: "等级（1 起，连续到 roleMaxLevel）" })
  level: number;

  @ApiProperty({ description: "生命上限（裸属性）" })
  maxHp: number;

  @ApiProperty({ description: "魔法上限（= maxHp × mpRate）" })
  maxMp: number;

  @ApiProperty({ description: "每秒回血（裸属性）" })
  hpRecover: number;

  @ApiProperty({ description: "物攻区间", type: ConfigAttributeRangeDto })
  physicalAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔攻区间", type: ConfigAttributeRangeDto })
  magicAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道攻区间", type: ConfigAttributeRangeDto })
  taoistAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "物防区间", type: ConfigAttributeRangeDto })
  physicalDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔防区间", type: ConfigAttributeRangeDto })
  magicDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道防区间", type: ConfigAttributeRangeDto })
  taoistDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "升到下一级所需经验（level_exps 表的最终值）" })
  exp: number;

  /** 从 `role_levels` 表行拼一行（#655：属性已是最终值，不再按曲线展开） */
  static fromRow(row: RoleLevelRow): LevelDto {
    const dto = new LevelDto();
    const range = (min: number, max: number): ConfigAttributeRangeDto => {
      const out = new ConfigAttributeRangeDto();
      out.min = min;
      out.max = max;
      return out;
    };
    dto.level = row.level;
    dto.maxHp = row.max_hp;
    dto.maxMp = row.max_mp;
    dto.hpRecover = row.hp_recover;
    dto.physicalAttack = range(row.physical_attack_min, row.physical_attack_max);
    dto.magicAttack = range(row.magic_attack_min, row.magic_attack_max);
    dto.taoistAttack = range(row.taoist_attack_min, row.taoist_attack_max);
    dto.physicalDefense = range(row.physical_defense_min, row.physical_defense_max);
    dto.magicDefense = range(row.magic_defense_min, row.magic_defense_max);
    dto.taoistDefense = range(row.taoist_defense_min, row.taoist_defense_max);
    dto.exp = row.exp;
    return dto;
  }

  /**
   * 从「曲线展开行 + 最终经验」拼一行（旧口径，迁移完成前的兜底）
   *
   * 保留是因为空库 / 迁移未跑时快照仍要有内容（客户端进游戏读到空等级表会直接黑屏）。
   */
  static from(level: number, attributes: Record<string, unknown>, exp: number): LevelDto {
    const dto = new LevelDto();
    const range = (value: unknown): ConfigAttributeRangeDto => {
      const tuple = value as [number, number];
      const out = new ConfigAttributeRangeDto();
      out.min = tuple[0];
      out.max = tuple[1];
      return out;
    };
    dto.level = level;
    dto.maxHp = Number(attributes.maxHp);
    dto.maxMp = Number(attributes.maxMp);
    dto.hpRecover = Number(attributes.hpRecover);
    dto.physicalAttack = range(attributes.physicalAttack);
    dto.magicAttack = range(attributes.magicAttack);
    dto.taoistAttack = range(attributes.taoistAttack);
    dto.physicalDefense = range(attributes.physicalDefense);
    dto.magicDefense = range(attributes.magicDefense);
    dto.taoistDefense = range(attributes.taoistDefense);
    dto.exp = exp;
    return dto;
  }
}

/**
 * 管理端看到的一行角色等级（#655）
 *
 * 与快照的 `LevelDto` 是同一份数据的两个视角：管理端多一个 `updatedAt`（判断
 * 「这一行是不是我改的 / 谁最后改的」），快照不带时间戳（客户端不用）。
 */
export class RoleLevelDto {
  @ApiProperty({ description: "等级（1 起；序列固定，不可增删行）" })
  level: number;

  @ApiProperty({ description: "升到下一级所需经验（≥ 1）" })
  exp: number;

  @ApiProperty({ description: "生命上限（裸属性）" })
  maxHp: number;

  @ApiProperty({ description: "魔法上限（裸属性）" })
  maxMp: number;

  @ApiProperty({ description: "每秒回血（裸属性）" })
  hpRecover: number;

  @ApiProperty({ description: "物攻区间", type: ConfigAttributeRangeDto })
  physicalAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔攻区间", type: ConfigAttributeRangeDto })
  magicAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道攻区间", type: ConfigAttributeRangeDto })
  taoistAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "物防区间", type: ConfigAttributeRangeDto })
  physicalDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔防区间", type: ConfigAttributeRangeDto })
  magicDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道防区间", type: ConfigAttributeRangeDto })
  taoistDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: RoleLevelRow): RoleLevelDto {
    const dto = new RoleLevelDto();
    const range = (min: number, max: number): ConfigAttributeRangeDto => {
      const out = new ConfigAttributeRangeDto();
      out.min = min;
      out.max = max;
      return out;
    };
    dto.level = row.level;
    dto.exp = row.exp;
    dto.maxHp = row.max_hp;
    dto.maxMp = row.max_mp;
    dto.hpRecover = row.hp_recover;
    dto.physicalAttack = range(row.physical_attack_min, row.physical_attack_max);
    dto.magicAttack = range(row.magic_attack_min, row.magic_attack_max);
    dto.taoistAttack = range(row.taoist_attack_min, row.taoist_attack_max);
    dto.physicalDefense = range(row.physical_defense_min, row.physical_defense_max);
    dto.magicDefense = range(row.magic_defense_min, row.magic_defense_max);
    dto.taoistDefense = range(row.taoist_defense_min, row.taoist_defense_max);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 角色等级列表查询入参（等级序列就是主键升序，筛选只有一个「跳到某级」） */
export class RoleLevelQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：按等级号模糊匹配" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 角色等级分页结果 */
export class RoleLevelPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的角色等级", type: [RoleLevelDto] })
  list: RoleLevelDto[];
}

/**
 * 编辑角色等级入参（部分更新；等级本身不可改）
 *
 * 六个区间都拆成 `xxxMin` / `xxxMax` 两个字段 —— 与数据库列一一对应，
 * 不做「数组字段」是因为管理端点选某格改一个数时，送整个数组容易把另一半覆盖成 0。
 */
export class UpdateRoleLevelDto {
  @ApiPropertyOptional({ description: "升到下一级所需经验（≥ 1）", minimum: 1 })
  @IsOptional()
  @IsInt({ message: "经验必须是整数" })
  @Min(1, { message: "经验至少为 1" })
  exp?: number;

  @ApiPropertyOptional({ description: "生命上限（≥ 0）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "生命上限必须是整数" })
  @Min(0, { message: "生命上限不能为负" })
  maxHp?: number;

  @ApiPropertyOptional({ description: "魔法上限（≥ 0）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "魔法上限必须是整数" })
  @Min(0, { message: "魔法上限不能为负" })
  maxMp?: number;

  @ApiPropertyOptional({ description: "每秒回血（≥ 0）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "每秒回血必须是整数" })
  @Min(0, { message: "每秒回血不能为负" })
  hpRecover?: number;

  @ApiPropertyOptional({ description: "物攻下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "物攻下限必须是整数" }) @Min(0, { message: "物攻下限不能为负" })
  physicalAttackMin?: number;

  @ApiPropertyOptional({ description: "物攻上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "物攻上限必须是整数" }) @Min(0, { message: "物攻上限不能为负" })
  physicalAttackMax?: number;

  @ApiPropertyOptional({ description: "魔攻下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "魔攻下限必须是整数" }) @Min(0, { message: "魔攻下限不能为负" })
  magicAttackMin?: number;

  @ApiPropertyOptional({ description: "魔攻上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "魔攻上限必须是整数" }) @Min(0, { message: "魔攻上限不能为负" })
  magicAttackMax?: number;

  @ApiPropertyOptional({ description: "道攻下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "道攻下限必须是整数" }) @Min(0, { message: "道攻下限不能为负" })
  taoistAttackMin?: number;

  @ApiPropertyOptional({ description: "道攻上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "道攻上限必须是整数" }) @Min(0, { message: "道攻上限不能为负" })
  taoistAttackMax?: number;

  @ApiPropertyOptional({ description: "物防下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "物防下限必须是整数" }) @Min(0, { message: "物防下限不能为负" })
  physicalDefenseMin?: number;

  @ApiPropertyOptional({ description: "物防上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "物防上限必须是整数" }) @Min(0, { message: "物防上限不能为负" })
  physicalDefenseMax?: number;

  @ApiPropertyOptional({ description: "魔防下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "魔防下限必须是整数" }) @Min(0, { message: "魔防下限不能为负" })
  magicDefenseMin?: number;

  @ApiPropertyOptional({ description: "魔防上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "魔防上限必须是整数" }) @Min(0, { message: "魔防上限不能为负" })
  magicDefenseMax?: number;

  @ApiPropertyOptional({ description: "道防下限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "道防下限必须是整数" }) @Min(0, { message: "道防下限不能为负" })
  taoistDefenseMin?: number;

  @ApiPropertyOptional({ description: "道防上限（≥ 0）", minimum: 0 })
  @IsOptional() @IsInt({ message: "道防上限必须是整数" }) @Min(0, { message: "道防上限不能为负" })
  taoistDefenseMax?: number;
}

/** 管理端看到的一个标量参数 */
export class GrowthScalarDto {
  @ApiProperty({ description: "参数键（如 roleMaxLevel / attributeRange.minRate）" })
  key: string;

  @ApiProperty({ description: "参数值" })
  value: number;

  @ApiProperty({ description: "参数说明（改之前先读一遍 —— 每个键的语义都在这里）" })
  description: string;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: GrowthScalarRow): GrowthScalarDto {
    const dto = new GrowthScalarDto();
    dto.key = row.key;
    dto.value = row.value;
    dto.description = row.description;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 标量参数列表查询入参 */
export class GrowthScalarQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配参数键与说明" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 标量参数分页结果 */
export class GrowthScalarPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的标量参数", type: [GrowthScalarDto] })
  list: GrowthScalarDto[];
}

/** 编辑标量参数入参（各键的取值域见服务端 GROWTH_SCALAR_SPECS；roleMaxLevel 还有跨表校验） */
export class UpdateGrowthScalarDto {
  @ApiProperty({
    description: "参数值；整数键（roleMaxLevel / expGain.*）必须是整数，比率键在 [0, 1] 等取值域内",
    minimum: 0,
  })
  @IsNumber({}, { message: "参数值必须是数字" })
  @Min(0, { message: "参数值不能为负" })
  value!: number;
}
