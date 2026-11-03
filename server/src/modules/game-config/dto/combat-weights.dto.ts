import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * 战斗力权重（#605）：属性名 → 倍率
 *
 * 出厂值在 `shared/combat-seed.ts`（生成物 `COMBAT_WEIGHTS` 的源头），七项写死在算法里
 * （`computeCombat` 按这七项求和）—— 运营改的是「每一项值多少」，不是「有哪几项」，
 * 所以这里是**显式字段**而不是 `Record<string, number>`：拼错的键在类型层就红，
 * 也不会出现「库里多一个键 → 静默参与求和」。
 *
 * 允许两位小数：`物理攻击 4.5` 这类「不想整数跳档」的调法是合理需求（与成长标量
 * `mpRecoverPerSecond` 同口径）。上限 1000 只是防手滑输入 100000 把战力撑爆。
 */
export class CombatWeightsDto {
  @ApiProperty({ description: "生命上限：每 1 点生命折算多少战力", example: 15 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  maxHp: number;

  @ApiProperty({ description: "物理攻击：每 1 点（区间按上下限之和）折算多少战力", example: 5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  physicalAttack: number;

  @ApiProperty({ description: "魔法攻击：每 1 点（区间按上下限之和）折算多少战力", example: 5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  magicAttack: number;

  @ApiProperty({ description: "道术攻击：每 1 点（区间按上下限之和）折算多少战力", example: 5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  taoistAttack: number;

  @ApiProperty({ description: "物理防御：每 1 点（区间按上下限之和）折算多少战力", example: 10 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  physicalDefense: number;

  @ApiProperty({ description: "魔法防御：每 1 点（区间按上下限之和）折算多少战力", example: 10 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  magicDefense: number;

  @ApiProperty({ description: "道术防御：每 1 点（区间按上下限之和）折算多少战力", example: 10 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  taoistDefense: number;
}

/** 部分更新：只提交改动过的属性（没提交的保持原值） */
export class UpdateCombatWeightsDto {
  @ApiPropertyOptional({ description: "生命上限权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  maxHp?: number;

  @ApiPropertyOptional({ description: "物理攻击权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  physicalAttack?: number;

  @ApiPropertyOptional({ description: "魔法攻击权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  magicAttack?: number;

  @ApiPropertyOptional({ description: "道术攻击权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  taoistAttack?: number;

  @ApiPropertyOptional({ description: "物理防御权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  physicalDefense?: number;

  @ApiPropertyOptional({ description: "魔法防御权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  magicDefense?: number;

  @ApiPropertyOptional({ description: "道术防御权重" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  taoistDefense?: number;

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}

/** GET / PATCH 的响应：当前权重 + 最后修改时间（权重本身是扁平对象，与快照段同形状） */
export class CombatWeightsResponseDto {
  @ApiProperty({ description: "当前生效权重（属性名 → 倍率）", type: CombatWeightsDto })
  weights: CombatWeightsDto;

  @ApiProperty({ description: "最后修改时间（毫秒，0 = 从未改过，仍是出厂值）", example: 1762000000000 })
  updatedAt: number;
}
