import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import {
  APPEARANCE_EFFECT_LIMITS,
  EQUIPMENT_APPEARANCE_LIMITS,
  EQUIPMENT_TIER_MAX,
} from "../../../common/constants/equipment-appearance";

/**
 * 装备外观（#695）
 *
 * 「哪个前后缀组合用哪个边框 / 详情背景」+「哪件特殊装备单独用哪个」。
 * 边框 / 背景的**素材本体**在客户端资源包里，服务端只存 key 字符串 ——
 * 所以这里没有任何路径类字段，格式校验就是 key 的形状（`border-30123` / `bg-16000`）。
 *
 * 取值域的**资源清单**（哪些编号真的存在）是两端资源约定，留客户端
 * （`configs/border` / `configs/background` 有与磁盘文件一一对应的守卫）；
 * 服务端不校验「素材存不存在」—— 资源包不在服务端，查了只会掩盖
 * 「本地有、线上没有」；填错了客户端会安静跳过并留日志。
 */

/** 单条显示效果（#700）：以素材第一帧为基准的微调；不传 = 缺省 {0,0,1}（与现状完全一致） */
export class AppearanceEffectDto {
  @ApiProperty({ description: "水平偏移（像素，右为正；边框相对图标中心、背景相对弹窗面板中心）", example: 0 })
  @IsNumber()
  @Min(-APPEARANCE_EFFECT_LIMITS.offsetMax)
  @Max(APPEARANCE_EFFECT_LIMITS.offsetMax)
  x: number;

  @ApiProperty({ description: "垂直偏移（像素，上为正）", example: 0 })
  @IsNumber()
  @Min(-APPEARANCE_EFFECT_LIMITS.offsetMax)
  @Max(APPEARANCE_EFFECT_LIMITS.offsetMax)
  y: number;

  @ApiProperty({ description: "尺寸倍率（1 = 客户端默认适配结果）", example: 1, minimum: APPEARANCE_EFFECT_LIMITS.scaleMin, maximum: APPEARANCE_EFFECT_LIMITS.scaleMax })
  @IsNumber()
  @Min(APPEARANCE_EFFECT_LIMITS.scaleMin)
  @Max(APPEARANCE_EFFECT_LIMITS.scaleMax)
  scale: number;
}

/** 一条「前缀 × 后缀 → 边框 / 背景 key」 */
export class AppearanceAssignmentDto {
  @ApiProperty({ description: `装备前缀序号（0 起；运行时档数由 equipment_meta 文案长度决定，硬上限 ${EQUIPMENT_TIER_MAX - 1}）`, example: 0, minimum: 0, maximum: EQUIPMENT_TIER_MAX - 1 })
  @IsInt()
  @Min(0)
  @Max(EQUIPMENT_TIER_MAX - 1)
  prefix: number;

  @ApiProperty({ description: `装备后缀序号（0 起；硬上限 ${EQUIPMENT_TIER_MAX - 1}）`, example: 0, minimum: 0, maximum: EQUIPMENT_TIER_MAX - 1 })
  @IsInt()
  @Min(0)
  @Max(EQUIPMENT_TIER_MAX - 1)
  suffix: number;

  @ApiProperty({ description: "边框 / 背景 key（客户端资源清单里的编号）", example: "border-30123" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.keyMaxLength)
  key: string;

  @ApiPropertyOptional({ description: "显示效果（#700；不传 = {0,0,1} 即默认适配结果）", type: AppearanceEffectDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppearanceEffectDto)
  effect?: AppearanceEffectDto;
}

/** 一条「特殊装备 → 边框 / 背景 key」（equipment 可以是变体 id，也可以是基础件 key） */
export class CustomAppearanceDto {
  @ApiProperty({ description: "物品 id（如 weapon_20_p4s2，只影响这一个变体）或基础件 key（如 weapon_20，影响其全部变体）", example: "weapon_20" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.equipmentIdMaxLength)
  @Matches(new RegExp(EQUIPMENT_APPEARANCE_LIMITS.equipmentIdSource), { message: "装备标识只能是字母、数字、下划线与短横线" })
  equipment: string;

  @ApiProperty({ description: "边框 / 背景 key", example: "border-30206" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.keyMaxLength)
  key: string;

  @ApiPropertyOptional({ description: "显示效果（#700；不传 = {0,0,1} 即默认适配结果）", type: AppearanceEffectDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppearanceEffectDto)
  effect?: AppearanceEffectDto;
}

/**
 * 一条边框 / 背景清单条目（#714 实体注册表）
 *
 * 清单是「游戏里有哪些边框 / 背景」的本体：棋盘（前后缀组合）与特殊装备自定义表
 * 只**引用**清单里的 key；显示效果等属性改在清单里，服务端保存时传播进引用处。
 */
export class AppearanceItemDto {
  @ApiProperty({ description: "边框 / 背景 key（客户端资源清单里的编号）", example: "border-30123" })
  @IsString()
  @Length(1, EQUIPMENT_APPEARANCE_LIMITS.keyMaxLength)
  key: string;

  @ApiPropertyOptional({ description: "显示效果（#700；不传 = {0,0,1} 即默认适配结果）", type: AppearanceEffectDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppearanceEffectDto)
  effect?: AppearanceEffectDto;

  @ApiPropertyOptional({
    description: "别名（#718，可选；给人看的名字，客户端不消费，快照里没有；空串视同没填）",
    example: "铁剑·蓝色品质框",
    maxLength: EQUIPMENT_APPEARANCE_LIMITS.nameMaxLength,
  })
  @IsOptional()
  @IsString()
  @Length(0, EQUIPMENT_APPEARANCE_LIMITS.nameMaxLength)
  name?: string;

  @ApiPropertyOptional({
    description: "分组（#718，可选；管理端按组过滤用，客户端不消费，快照里没有；空串视同没填）",
    example: "品质系列",
    maxLength: EQUIPMENT_APPEARANCE_LIMITS.groupMaxLength,
  })
  @IsOptional()
  @IsString()
  @Length(0, EQUIPMENT_APPEARANCE_LIMITS.groupMaxLength)
  group?: string;
}

/** 整份装备外观（GET / PATCH 的响应） */
export class EquipmentAppearanceDto {
  @ApiProperty({ description: "前后缀组合 → 边框（恰好覆盖当前档数的每种组合、各一条）", type: [AppearanceAssignmentDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  borders: AppearanceAssignmentDto[];

  @ApiProperty({ description: "前后缀组合 → 详情背景（恰好覆盖当前档数的每种组合、各一条）", type: [AppearanceAssignmentDto] })
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

/**
 * 单边配置（#699 起边框 / 背景在管理端是两个独立页面，各自整份读写自己的半边）。
 * `assignments` / `customs` 的覆盖规则同上；PATCH 时**另一边不受影响**（部分更新）。
 */
export class EquipmentBorderDto {
  @ApiProperty({ description: "边框清单本体（#714；棋盘与自定义表只引用这里的 key）", type: [AppearanceItemDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceItemDto)
  items: AppearanceItemDto[];

  @ApiProperty({ description: "前后缀组合 → 边框（恰好覆盖当前档数的每种组合、各一条）", type: [AppearanceAssignmentDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  assignments: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 边框（优先于前后缀表；装备标识不可重复）", type: [CustomAppearanceDto] })
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customs: CustomAppearanceDto[];

  @ApiProperty({ description: "最后修改时间（毫秒，0 = 从未改过、仍是出厂值）", example: 1762000000000 })
  updatedAt: number;
}

/** 单边配置 · 详情背景（形状与边框一致，key 格式不同：前缀 border- 与 bg- 不能混用） */
export class EquipmentBackgroundDto {
  @ApiProperty({ description: "背景清单本体（#714；棋盘与自定义表只引用这里的 key）", type: [AppearanceItemDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceItemDto)
  items: AppearanceItemDto[];

  @ApiProperty({ description: "前后缀组合 → 详情背景（恰好覆盖当前档数的每种组合、各一条）", type: [AppearanceAssignmentDto] })
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  assignments: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 详情背景（优先于前后缀表；装备标识不可重复）", type: [CustomAppearanceDto] })
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customs: CustomAppearanceDto[];

  @ApiProperty({ description: "最后修改时间（毫秒，0 = 从未改过、仍是出厂值）", example: 1762000000000 })
  updatedAt: number;
}

/**
 * 资源文件夹扫描结果（#716「从文件夹同步」的预览）
 *
 * 服务端去扫 `EQUIPMENT_APPEARANCE_RES_DIR`（默认 `../client/assets/resources`）
 * 下的 `effect/border`（border-N.plist + 同名 png）或 `effect/background`（bg-N.plist），
 * 与当前清单求差集 —— 管理端拿它弹「将新增 / 将移除」的确认框。
 */
export class AppearanceResourceScanDto {
  @ApiProperty({ description: "实际扫描的资源目录（排查「为什么扫不到」用）", example: "/app/game-resources" })
  @IsString()
  dir: string;

  @ApiProperty({ description: "文件夹里的全部 key（按编号升序）", example: ["border-30123"], type: [String] })
  @IsArray()
  keys: string[];

  @ApiProperty({ description: "文件夹有、清单没有的 key（同步会新增）", example: [], type: [String] })
  @IsArray()
  added: string[];

  @ApiProperty({ description: "清单有、文件夹没有的 key（同步会移除）", example: [], type: [String] })
  @IsArray()
  removed: string[];

  @ApiProperty({
    description: "removed 里仍被棋盘 / 特殊装备绑定引用的 key（#716 允许移除；引用处会显示异常，客户端安静跳过）",
    example: [],
    type: [String],
  })
  @IsArray()
  removedReferenced: string[];
}

/** 同步执行结果（POST .../sync 的响应） */
export class AppearanceResourceSyncDto {
  @ApiProperty({ description: "本次新增的 key", example: ["border-30183"], type: [String] })
  @IsArray()
  added: string[];

  @ApiProperty({ description: "本次移除的 key", example: [], type: [String] })
  @IsArray()
  removed: string[];

  @ApiProperty({ description: "移除的 key 里仍被引用的（引用处待运营修复）", example: [], type: [String] })
  @IsArray()
  removedReferenced: string[];

  @ApiProperty({ description: "保留的条目数（存活条目连同已配置的 effect 一起保留）", example: 84 })
  @IsInt()
  kept: number;

  @ApiProperty({ description: "同步后的最后修改时间（毫秒）", example: 1762000000000 })
  @IsInt()
  updatedAt: number;
}

/** 单边提交（先校验后写：任何一条不合法整边不落库；另一边不受影响） */
export class UpdateEquipmentBorderDto {
  /**
   * 数组长度只做防御性兜底（1 ~ 100）；「恰好覆盖当前档数的每个组合」是跨表约束，
   * 只有 service 拿着 equipment_meta 的档数才能判（#697 起档数可配，写死在这里必然漂）。
   */
  @ApiProperty({ description: "前后缀组合 → 边框（整边替换，恰好覆盖当前档数的每种组合且不重复）", type: [AppearanceAssignmentDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  assignments: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 边框（整边替换；装备标识不可重复）", type: [CustomAppearanceDto] })
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.customMax)
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customs: CustomAppearanceDto[];

  /**
   * 边框清单本体（#714）。不传 = 沿用库里的清单并自动并入被引用的 key（老调用方兼容）；
   * 传了 = 整份替换：key 唯一且格式合法，**引用处的 effect 以清单为准传播**，
   * 且每个被引用的 key 必须在清单里（删掉被引用的条目会被 400 拦下）。
   */
  @ApiPropertyOptional({ description: "边框清单（整份替换；被引用的 key 必须在清单里）", type: [AppearanceItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => AppearanceItemDto)
  items?: AppearanceItemDto[];

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}

/** 单边提交 · 详情背景 */
export class UpdateEquipmentBackgroundDto {
  @ApiProperty({ description: "前后缀组合 → 详情背景（整边替换，恰好覆盖当前档数的每种组合且不重复）", type: [AppearanceAssignmentDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppearanceAssignmentDto)
  assignments: AppearanceAssignmentDto[];

  @ApiProperty({ description: "特殊装备 → 详情背景（整边替换；装备标识不可重复）", type: [CustomAppearanceDto] })
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.customMax)
  @ValidateNested({ each: true })
  @Type(() => CustomAppearanceDto)
  customs: CustomAppearanceDto[];

  /** 同 UpdateEquipmentBorderDto.items：不传 = 沿用并自动并入被引用的 key；传了 = 整份替换 + effect 传播 */
  @ApiPropertyOptional({ description: "背景清单（整份替换；被引用的 key 必须在清单里）", type: [AppearanceItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EQUIPMENT_APPEARANCE_LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => AppearanceItemDto)
  items?: AppearanceItemDto[];

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}
