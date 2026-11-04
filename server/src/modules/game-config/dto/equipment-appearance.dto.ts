import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import {
  EQUIPMENT_APPEARANCE_LIMITS,
  EQUIPMENT_COMBO_COUNT,
  EQUIPMENT_PREFIX_MAX,
  EQUIPMENT_SUFFIX_MAX,
} from "../../../common/constants/equipment-appearance";

/**
 * 装备外观（#695）
 *
 * 「哪个前后缀组合用哪个边框 / 详情背景」+「哪件特殊装备单独用哪个」。
 * 边框 / 背景的**素材本体**在客户端资源包里，服务端只存 key 字符串 ——
 * 所以这里没有任何路径类字段，格式校验就是 key 的形状（`sfx_30123_0` / `sfx_16000`）。
 *
 * 取值域的**资源清单**（哪些 sfx 编号真的存在）是两端资源约定，留客户端
 * （`configs/border` / `configs/background` 有与磁盘文件一一对应的守卫）；
 * 服务端不校验「素材存不存在」—— 资源包不在服务端，查了只会掩盖
 * 「本地有、线上没有」；填错了客户端会安静跳过并留日志。
 */

/** 一条「前缀 × 后缀 → 边框 / 背景 key」 */
export class AppearanceAssignmentDto {
  @ApiProperty({ description: "装备前缀（0 普通的 → 4 超神的，数值即客户端 EQUIPMENT_PREFIX 枚举值）", example: 0, minimum: 0, maximum: EQUIPMENT_PREFIX_MAX })
  @IsInt()
  @Min(0)
  @Max(EQUIPMENT_PREFIX_MAX)
  prefix: number;

  @ApiProperty({ description: "装备后缀（0 人级 / 1 天级 / 2 神级，数值即客户端 EQUIPMENT_SUFFIX 枚举值）", example: 0, minimum: 0, maximum: EQUIPMENT_SUFFIX_MAX })
  @IsInt()
  @Min(0)
  @Max(EQUIPMENT_SUFFIX_MAX)
  suffix: number;

  @ApiProperty({ description: "边框 / 背景 key（客户端资源清单里的 sfx 编号）", example: "sfx_30123_0" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.keyMaxLength)
  key: string;
}

/** 一条「特殊装备 → 边框 / 背景 key」（equipment 可以是变体 id，也可以是基础件 key） */
export class CustomAppearanceDto {
  @ApiProperty({ description: "物品 id（如 weapon_20_p4s2，只影响这一个变体）或基础件 key（如 weapon_20，影响其全部变体）", example: "weapon_20" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.equipmentIdMaxLength)
  @Matches(new RegExp(EQUIPMENT_APPEARANCE_LIMITS.equipmentIdSource), { message: "装备标识只能是字母、数字、下划线与短横线" })
  equipment: string;

  @ApiProperty({ description: "边框 / 背景 key", example: "sfx_30206_0" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.keyMaxLength)
  key: string;
}

/** 整份装备外观（GET / PATCH 的响应） */
export class EquipmentAppearanceDto {
  @ApiProperty({ description: `前后缀组合 → 边框（恰好 ${EQUIPMENT_COMBO_COUNT} 条，每条组合一次）`, type: [AppearanceAssignmentDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  borders: AppearanceAssignmentDto[];

  @ApiProperty({ description: `前后缀组合 → 详情背景（恰好 ${EQUIPMENT_COMBO_COUNT} 条，每条组合一次）`, type: [AppearanceAssignmentDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  backgrounds: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 边框（优先于前后缀表）", type: [CustomAppearanceDto] })
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customBorders: CustomAppearanceDto[];

  @ApiProperty({ description: "特殊装备 → 详情背景（优先于前后缀表）", type: [CustomAppearanceDto] })
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customBackgrounds: CustomAppearanceDto[];

  @ApiProperty({ description: "最后修改时间（毫秒，0 = 从未改过、仍是出厂值）", example: 1762000000000 })
  updatedAt: number;
}

/** 整份提交（先校验后写：任何一条不合法都不落库） */
export class UpdateEquipmentAppearanceDto {
  @ApiProperty({ description: `前后缀组合 → 边框（整份替换，恰好 ${EQUIPMENT_COMBO_COUNT} 条且组合不重复）`, type: [AppearanceAssignmentDto] })
  @IsArray()
  @ArrayMinSize(EQUIPMENT_COMBO_COUNT)
  @ArrayMaxSize(EQUIPMENT_COMBO_COUNT)
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  borders: AppearanceAssignmentDto[];

  @ApiProperty({ description: `前后缀组合 → 详情背景（整份替换，恰好 ${EQUIPMENT_COMBO_COUNT} 条且组合不重复）`, type: [AppearanceAssignmentDto] })
  @IsArray()
  @ArrayMinSize(EQUIPMENT_COMBO_COUNT)
  @ArrayMaxSize(EQUIPMENT_COMBO_COUNT)
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  backgrounds: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 边框（整份替换；装备标识不可重复）", type: [CustomAppearanceDto] })
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.customMax)
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customBorders: CustomAppearanceDto[];

  @ApiProperty({ description: "特殊装备 → 详情背景（整份替换；装备标识不可重复）", type: [CustomAppearanceDto] })
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.customMax)
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customBackgrounds: CustomAppearanceDto[];

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}
