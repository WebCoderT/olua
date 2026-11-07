import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { ROLE_LEVEL_CURVES } from "../../../common/constants/role-level-curve";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { GrowthScalarRow, RoleLevelCurveRow, RoleLevelRow } from "../../../database/rows";
import { ConfigAttributeRangeDto } from "./title.dto";

// —— 等级曲线（#786：等级的唯一定义处） ——

/**
 * 一条曲线段（管理端可改 / 快照下发）
 *
 * 一行 = 一段等级上的公式：`value = startValue + perLevel*k + accel*k*(k-1)/2`
 * （`k = level - fromLevel`）。4 条曲线 × 6 段就把 1..100 万级定义完了 ——
 * 逐级存表在 100 万级不可行（快照 250MB、客户端几百 MB 内存）。
 */
export class LevelCurveDto {
  @ApiProperty({ description: "曲线 key：exp（升级经验）/ hp（生命上限）/ attack_max（物攻上限）/ defense_max（物防上限）" })
  curve: string;

  @ApiProperty({ description: "段序号（同一曲线内 1 起；段的起点由上一段终点决定，不可改）" })
  seq: number;

  @ApiProperty({ description: "起始等级（含）" })
  fromLevel: number;

  @ApiProperty({ description: "结束等级（含）；最后一段是等级上限，超出按该段公式继续外推" })
  toLevel: number;

  @ApiProperty({ description: "fromLevel 处的值" })
  startValue: number;

  @ApiProperty({ description: "每级增量" })
  perLevel: number;

  @ApiProperty({ description: "每级增量的增量（二阶；只有 exp 用，其余为 0）" })
  accel: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: RoleLevelCurveRow): LevelCurveDto {
    const dto = new LevelCurveDto();
    dto.curve = row.curve;
    dto.seq = row.seq;
    dto.fromLevel = row.from_level;
    dto.toLevel = row.to_level;
    dto.startValue = row.start_value;
    dto.perLevel = row.per_level;
    dto.accel = row.accel;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 曲线段列表（4 条 × 6 段 = 24 行，不分页） */
export class LevelCurveListDto {
  @ApiProperty({ description: "全部曲线段（按曲线 → 段序）", type: [LevelCurveDto] })
  list: LevelCurveDto[];
}

/**
 * 改一段（部分更新）
 *
 * `curve` / `seq` 在路径上，`fromLevel` 不给改 —— 段起点由上一段终点决定，
 * 改它会把区间切成重叠或空隙（两种都是「某段等级没有属性」）。
 */
export class UpdateLevelCurveDto {
  @ApiPropertyOptional({ description: "结束等级（含）；不能小于本段起始等级", minimum: 1 })
  @IsOptional()
  @IsInt({ message: "结束等级必须是整数" })
  @Min(1, { message: "结束等级至少为 1" })
  toLevel?: number;

  @ApiPropertyOptional({ description: "起始等级处的值（≥ 0）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "起始值必须是整数" })
  @Min(0, { message: "起始值不能为负" })
  startValue?: number;

  @ApiPropertyOptional({ description: "每级增量（≥ 0；经验段建议 ≥ 1）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "每级增量必须是整数" })
  @Min(0, { message: "每级增量不能为负" })
  perLevel?: number;

  @ApiPropertyOptional({ description: "每级增量的增量（≥ 0；只有 exp 有意义，其余曲线请留 0）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "加速度必须是整数" })
  @Min(0, { message: "加速度不能为负" })
  accel?: number;
}

/**
 * 某一级的**基础属性**（不含装备 / 称号 / 战魂 / 军衔加成）
 *
 * 两个用途：管理端「等级属性计算器」的返回值；快照不再下发逐级表（#786），
 * 客户端自己按曲线算，这里只给运营看「这一级到底是多少」。
 */
export class LevelAttributesDto {
  @ApiProperty({ description: "等级" })
  level: number;

  @ApiProperty({ description: "升到下一级所需经验" })
  exp: number;

  @ApiProperty({ description: "生命上限（裸属性）" })
  maxHp: number;

  @ApiProperty({ description: "魔法上限（= 生命上限 × 0.5）" })
  maxMp: number;

  @ApiProperty({ description: "每秒回血（= 生命上限 ÷ 100，四舍五入）" })
  hpRecover: number;

  @ApiProperty({ description: "物攻区间（三系攻同值）", type: ConfigAttributeRangeDto })
  physicalAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔攻区间", type: ConfigAttributeRangeDto })
  magicAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道攻区间", type: ConfigAttributeRangeDto })
  taoistAttack: ConfigAttributeRangeDto;

  @ApiProperty({ description: "物防区间（三系防同值）", type: ConfigAttributeRangeDto })
  physicalDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "魔防区间", type: ConfigAttributeRangeDto })
  magicDefense: ConfigAttributeRangeDto;

  @ApiProperty({ description: "道防区间", type: ConfigAttributeRangeDto })
  taoistDefense: ConfigAttributeRangeDto;

  /** 曲线求值出来的整行 → DTO（属性列扁平的 min/max 在这里折成区间对象） */
  static fromRow(row: RoleLevelRow): LevelAttributesDto {
    const dto = new LevelAttributesDto();
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
    return dto;
  }
}

/** 曲线 key 的登记表（管理端筛选 / 文案用；未登记的原样显示） */
export const LEVEL_CURVE_KEYS = ROLE_LEVEL_CURVES;

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
