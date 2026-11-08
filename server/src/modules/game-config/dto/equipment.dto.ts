import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { EquipmentMetaRow, EquipmentRow, EquipmentSlotRow, EquipmentVariantRow } from "../../../database/rows";
import { EQUIPMENT_SLOT_KEYS, OCCUPATION_HINT, OCCUPATION_LABELS, SEX_HINT, SEX_LABELS } from "../../../common/constants/game-enums";
import { attributesFromRow, ConfigAttributesDto, SoulRowShape } from "./title.dto";

export { EQUIPMENT_SLOT_KEYS };

/**
 * 职业限制取值清单（派生自生成物 `OCCUPATION_LABELS` 的键 —— 客户端 `OECCUPATION` 枚举值）
 *
 * 不在这里写死 `["1","2","3","4"]`：枚举改一处就够了，写死第二份迟早漂。
 */
export const EQUIPMENT_OCCUPATION_KEYS = Object.keys(OCCUPATION_LABELS);

/** 性别限制取值清单（派生自生成物 `SEX_LABELS` 的键 —— 客户端 `SEX` 枚举值） */
export const EQUIPMENT_SEX_KEYS = Object.keys(SEX_LABELS);

/** 等级需求上下限（客户端曲线铺到 roleMaxLevel；防御性校验，正常配置远够不着上限） */
export const EQUIPMENT_LEVEL_MIN = 1;
export const EQUIPMENT_LEVEL_MAX = 1000;

/** 售卖价上限（绑定元宝计价的防御性上限；0 = 不可售卖） */
export const EQUIPMENT_SELL_PRICE_MAX = 100_000_000;

/** 内观 / 外观缩放上下限（0 会让节点整个消失，10 已经夸张到看不出是装备） */
export const EQUIPMENT_SCALE_MIN = 0.1;
export const EQUIPMENT_SCALE_MAX = 10;

/** 内观偏移上下限（像素；弹窗坐标系里 ±4000 已经远超画布） */
export const EQUIPMENT_OFFSET_LIMIT = 4000;

/** 8 向位置的个数（up / right_up / right / right_down / down / left_down / left / left_up） */
export const EQUIPMENT_DIRECTIONS = 8;

/** 一个平面坐标（配置里到处是 Vec2，接口上用 { x, y } 表达） */
export class EquipmentPointDto {
  @ApiProperty({ description: "x（像素，单轴 ±4000）" })
  @IsNumber({}, { message: "位置 x 必须是数字" })
  @Min(-EQUIPMENT_OFFSET_LIMIT, { message: `位置 x 不能小于 -${EQUIPMENT_OFFSET_LIMIT}` })
  @Max(EQUIPMENT_OFFSET_LIMIT, { message: `位置 x 不能大于 ${EQUIPMENT_OFFSET_LIMIT}` })
  x: number;

  @ApiProperty({ description: "y（像素，向上为正；单轴 ±4000）" })
  @IsNumber({}, { message: "位置 y 必须是数字" })
  @Min(-EQUIPMENT_OFFSET_LIMIT, { message: `位置 y 不能小于 -${EQUIPMENT_OFFSET_LIMIT}` })
  @Max(EQUIPMENT_OFFSET_LIMIT, { message: `位置 y 不能大于 ${EQUIPMENT_OFFSET_LIMIT}` })
  y: number;
}

/** JSON 文本列 → 字符串数组（脏数据一律降级成空数组，不让一条坏行把整个列表打挂） */
function parseStringArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** JSON 文本列 → 坐标数组（同上，脏数据降级成空数组） */
function parsePoints(text: string): EquipmentPointDto[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const point = new EquipmentPointDto();
      point.x = Number((item as Record<string, unknown>)?.x) || 0;
      point.y = Number((item as Record<string, unknown>)?.y) || 0;
      return point;
    });
  } catch {
    return [];
  }
}

/** 管理端看到的一条装备基础件配置 */
export class EquipmentDto {
  @ApiProperty({ description: "装备基础件 id（如 cloth_1；变体 id 带 _pXsY 不进管理端）" })
  id: string;

  @ApiProperty({ description: "部位（EQUIPMENT_TYPE 的枚举值，如 cloth）" })
  slot: string;

  @ApiProperty({ description: "穿戴需求等级（装备定强的锚点）" })
  level: number;

  @ApiProperty({ description: "售卖价（0 = 不可售卖；商城售价归商城定价管理，不在这里）" })
  sellPrice: number;

  @ApiProperty({ description: "名称（如「青铜重甲」；前后缀由客户端拼在名字前后）" })
  label: string;

  @ApiProperty({ description: "描述（装备详情弹窗正文）" })
  description: string;

  @ApiProperty({ description: `职业限制（取值域见 OCCUPATION_HINT：${OCCUPATION_HINT}）` })
  occupation: string;

  @ApiProperty({ description: `性别限制（取值域见 SEX_HINT：${SEX_HINT}）` })
  sex: string;

  @ApiProperty({ description: "图标（resources 相对路径，如 equipment/clothes/icon/005；管理端列表缩略图与客户端图标共用）" })
  icon: string;

  @ApiProperty({ description: "内观图集（角色弹窗里穿在身上的那套；resources 相对路径）" })
  inAtlas: string;

  @ApiProperty({ description: "外观图集（场景里跟着角色走的那个；resources 相对路径）" })
  outAtlas: string;

  @ApiProperty({ description: "标签（如「第一大陆」；详情弹窗展示，无逻辑含义）", type: [String] })
  tags: string[];

  @ApiProperty({ description: "外观缩放（1 = 原尺寸）" })
  outScale: number;

  @ApiProperty({ description: "内观横向缩放（1 = 原尺寸）" })
  inScaleX: number;

  @ApiProperty({ description: "内观纵向缩放（1 = 原尺寸）" })
  inScaleY: number;

  @ApiProperty({ description: "内观旋转角度（度，0 = 不转）" })
  inRotate: number;

  @ApiProperty({ description: "内观锚点 x（弹窗坐标系，原点 = 弹窗中心、y 向上）" })
  inPosX: number;

  @ApiProperty({ description: "内观锚点 y（弹窗坐标系，y 向上）" })
  inPosY: number;

  @ApiProperty({
    description:
      "外观 8 向绝对位置（相对角色脚底锚点，y 向上；顺序 up / right_up / right / right_down / down / left_down / left / left_up）。" +
      "**这是出厂值**：管理端「装备对齐」工作台调过的结果在 equip_aligns 表、每次进图另发",
    type: [EquipmentPointDto],
  })
  @Type(() => EquipmentPointDto)
  outPositions: EquipmentPointDto[];

  @ApiProperty({ description: "八项基础属性（普通的·人级那一件自己的值；#655 起变体各自成行，不再由它乘倍率现算）", type: ConfigAttributesDto })
  attributes: ConfigAttributesDto;

  @ApiProperty({
    description:
      "掉落时强制绑定（#789）：true = 这件装备一掉出来就绑定角色、不可交易。" +
      "三种绑定判定之一（另两个：怪物侧「掉落强制绑定」、掉落参数里的随机概率），任一为真即绑定",
  })
  bindOnDrop: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipmentRow): EquipmentDto {
    const dto = new EquipmentDto();
    dto.id = row.id;
    dto.slot = row.slot;
    dto.level = row.level;
    dto.sellPrice = row.sell_price;
    dto.label = row.label;
    dto.description = row.description;
    dto.occupation = row.occupation;
    dto.sex = row.sex;
    dto.icon = row.icon;
    dto.inAtlas = row.in_atlas;
    dto.outAtlas = row.out_atlas;
    dto.tags = parseStringArray(row.tags);
    dto.outScale = row.out_scale;
    dto.inScaleX = row.in_scale_x;
    dto.inScaleY = row.in_scale_y;
    dto.inRotate = row.in_rotate;
    dto.inPosX = row.in_pos_x;
    dto.inPosY = row.in_pos_y;
    dto.outPositions = parsePoints(row.out_positions);
    dto.attributes = attributesFromRow(row as EquipmentRow & SoulRowShape);
    dto.bindOnDrop = row.bind_on_drop === 1;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/**
 * 装备变体（快照专用；#655）
 *
 * 与 `EquipmentDto` 的唯一区别：**属性 / 等级 / 卖价是这一件变体自己的值**，
 * 不再由基础件乘前后缀倍率现算。客户端因此可以直接建表，不用再展开。
 * 显示字段（图标 / 图集 / 几何 / 职业限制）从基础件复制 —— 同一件装备的 15 个变体
 * 外观相同，只有数值不同。
 */
export class EquipmentVariantDto extends EquipmentDto {
  @ApiProperty({ description: "所属基础件 id（如 cloth_1）" })
  baseId: string;

  @ApiProperty({ description: "前缀序号（0 = 普通的；文案与颜色按下标对齐，颜色留在客户端）" })
  prefix: number;

  @ApiProperty({ description: "后缀序号（0 = 人级）" })
  suffix: number;

  /** 基础件 + 变体行 → 一条完整装备（显示字段取基础件，数值取变体） */
  static fromVariant(base: EquipmentRow, variant: EquipmentVariantRow): EquipmentVariantDto {
    const dto = Object.assign(new EquipmentVariantDto(), EquipmentDto.from(base));
    dto.id = variant.id;
    dto.baseId = variant.base_id;
    dto.label = variant.label;
    dto.level = variant.level;
    dto.sellPrice = variant.sell_price;
    dto.attributes = attributesFromRow(variant as unknown as EquipmentRow & SoulRowShape);
    dto.updatedAt = variant.updated_at;
    dto.prefix = variant.prefix;
    dto.suffix = variant.suffix;
    return dto;
  }
}

/** 装备列表查询入参 */
export class EquipmentQueryDto extends PageQueryDto {  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;

  @ApiPropertyOptional({
    description: "按部位筛（取值：" + EQUIPMENT_SLOT_KEYS.join(" / ") + "；枚举清单派生自客户端配置，不落 schema 以免英文/中文键进两端生成物）",
  })
  @IsOptional()
  @IsString({ message: "部位必须是字符串" })
  @IsIn(EQUIPMENT_SLOT_KEYS, { message: "部位取值不合法" })
  slot?: string;

  @ApiPropertyOptional({ description: "等级段下限（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级下限必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级下限不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  minLevel?: number;

  @ApiPropertyOptional({ description: "等级段上限（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "等级上限必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级上限不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  maxLevel?: number;
}

/**
 * 装备基础件列表行（`EquipmentDto` + 变体行数）
 *
 * 加这一层而不是往 `EquipmentDto` 里塞 `variantCount`：变体 DTO 继承自 `EquipmentDto`
 * （`EquipmentVariantDto`），基类带个「我有几个变体」的字段在变体行上毫无意义，
 * 契约里也会多出一个永远为 0 的字段。
 *
 * 件数由装备列表接口一次带出（`GROUP BY base_id` 的子查询），管理端列表因此能直接显示
 * 「这件装备有几个变体」—— 变体本身在弹窗里看，不再单开一页。
 */
export class EquipmentListItemDto extends EquipmentDto {
  @ApiProperty({ description: "这件基础件的变体行数（= 前缀档数 × 后缀档数；出厂 15）" })
  variantCount: number;

  static of(row: EquipmentRow, variantCount: number): EquipmentListItemDto {
    const dto = Object.assign(new EquipmentListItemDto(), EquipmentDto.from(row));
    dto.variantCount = variantCount;
    return dto;
  }
}

/** 装备分页结果 */
export class EquipmentPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的装备基础件配置", type: [EquipmentListItemDto] })
  list: EquipmentListItemDto[];
}

/**
 * 编辑装备基础件入参（**部分更新**）
 *
 * `slot` / `id` 不开放编辑：部位结构属客户端资源约定，id 是背包 / 穿戴 / 掉落表里的引用键 ——
 * 要换位置就新建一件、下架旧的（#773 起装备可增删，`CreateEquipmentDto` 是入口）。
 * 名称 / 描述 / 图标 / 图集 / 几何都可改（#603 从客户端源码搬进库）。
 */
export class UpdateEquipmentDto {
  @ApiPropertyOptional({ description: "名称（不传则不改；≤50 字）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "描述（不传则不改；≤500 字，空串 = 清空）", maxLength: 500 })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(500, { message: "描述不能超过 500 字" })
  description?: string;

  @ApiPropertyOptional({ description: "职业限制（取值：" + EQUIPMENT_OCCUPATION_KEYS.join(" / ") + "）" })
  @IsOptional()
  @IsString({ message: "职业限制必须是字符串" })
  @IsIn(EQUIPMENT_OCCUPATION_KEYS, { message: "职业限制取值不合法" })
  occupation?: string;

  @ApiPropertyOptional({ description: "性别限制（取值：" + EQUIPMENT_SEX_KEYS.join(" / ") + "）" })
  @IsOptional()
  @IsString({ message: "性别限制必须是字符串" })
  @IsIn(EQUIPMENT_SEX_KEYS, { message: "性别限制取值不合法" })
  sex?: string;

  @ApiPropertyOptional({ description: "图标（resources 相对路径；空串 = 不显示图标）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标必须是字符串" })
  @MaxLength(200, { message: "图标路径不能超过 200 字" })
  icon?: string;

  @ApiPropertyOptional({ description: "内观图集（resources 相对路径；空串 = 内观不显示这件）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "内观图集必须是字符串" })
  @MaxLength(200, { message: "内观图集路径不能超过 200 字" })
  inAtlas?: string;

  @ApiPropertyOptional({ description: "外观图集（resources 相对路径；空串 = 外观不显示这件）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "外观图集必须是字符串" })
  @MaxLength(200, { message: "外观图集路径不能超过 200 字" })
  outAtlas?: string;

  @ApiPropertyOptional({ description: "标签（整份替换；每一项 ≤20 字，最多 8 个）", type: [String] })
  @IsOptional()
  @IsArray({ message: "标签必须是数组" })
  @ArrayMaxSize(8, { message: "标签最多 8 个" })
  @IsString({ each: true, message: "每个标签都必须是字符串" })
  @MaxLength(20, { each: true, message: "每个标签不超过 20 字" })
  tags?: string[];

  @ApiPropertyOptional({ description: "外观缩放（1 = 原尺寸）", minimum: EQUIPMENT_SCALE_MIN, maximum: EQUIPMENT_SCALE_MAX })
  @IsOptional()
  @IsNumber({}, { message: "外观缩放必须是数字" })
  @Min(EQUIPMENT_SCALE_MIN, { message: `外观缩放不能小于 ${EQUIPMENT_SCALE_MIN}（0 会让节点消失）` })
  @Max(EQUIPMENT_SCALE_MAX, { message: `外观缩放不能大于 ${EQUIPMENT_SCALE_MAX}` })
  outScale?: number;

  @ApiPropertyOptional({ description: "内观横向缩放（1 = 原尺寸）", minimum: EQUIPMENT_SCALE_MIN, maximum: EQUIPMENT_SCALE_MAX })
  @IsOptional()
  @IsNumber({}, { message: "内观横向缩放必须是数字" })
  @Min(EQUIPMENT_SCALE_MIN, { message: `内观缩放不能小于 ${EQUIPMENT_SCALE_MIN}（0 会让节点消失）` })
  @Max(EQUIPMENT_SCALE_MAX, { message: `内观缩放不能大于 ${EQUIPMENT_SCALE_MAX}` })
  inScaleX?: number;

  @ApiPropertyOptional({ description: "内观纵向缩放（1 = 原尺寸）", minimum: EQUIPMENT_SCALE_MIN, maximum: EQUIPMENT_SCALE_MAX })
  @IsOptional()
  @IsNumber({}, { message: "内观纵向缩放必须是数字" })
  @Min(EQUIPMENT_SCALE_MIN, { message: `内观缩放不能小于 ${EQUIPMENT_SCALE_MIN}（0 会让节点消失）` })
  @Max(EQUIPMENT_SCALE_MAX, { message: `内观缩放不能大于 ${EQUIPMENT_SCALE_MAX}` })
  inScaleY?: number;

  @ApiPropertyOptional({ description: "内观旋转角度（度；0 = 不转）", minimum: -360, maximum: 360 })
  @IsOptional()
  @IsNumber({}, { message: "旋转角度必须是数字" })
  @Min(-360, { message: "旋转角度不能小于 -360 度" })
  @Max(360, { message: "旋转角度不能大于 360 度" })
  inRotate?: number;

  @ApiPropertyOptional({ description: "内观锚点 x（像素）", minimum: -EQUIPMENT_OFFSET_LIMIT, maximum: EQUIPMENT_OFFSET_LIMIT })
  @IsOptional()
  @IsNumber({}, { message: "内观锚点 x 必须是数字" })
  @Min(-EQUIPMENT_OFFSET_LIMIT, { message: `内观锚点不能小于 -${EQUIPMENT_OFFSET_LIMIT}` })
  @Max(EQUIPMENT_OFFSET_LIMIT, { message: `内观锚点不能大于 ${EQUIPMENT_OFFSET_LIMIT}` })
  inPosX?: number;

  @ApiPropertyOptional({ description: "内观锚点 y（像素，向上为正）", minimum: -EQUIPMENT_OFFSET_LIMIT, maximum: EQUIPMENT_OFFSET_LIMIT })
  @IsOptional()
  @IsNumber({}, { message: "内观锚点 y 必须是数字" })
  @Min(-EQUIPMENT_OFFSET_LIMIT, { message: `内观锚点不能小于 -${EQUIPMENT_OFFSET_LIMIT}` })
  @Max(EQUIPMENT_OFFSET_LIMIT, { message: `内观锚点不能大于 ${EQUIPMENT_OFFSET_LIMIT}` })
  inPosY?: number;

  @ApiPropertyOptional({
    description:
      "外观 8 向位置（**整份提交、整份替换**，必须正好 8 个，顺序 up → left_up；单轴 ±4000）。" +
      "只改出厂值，实际效果以「装备对齐」工作台（equip_aligns）为准",
    type: [EquipmentPointDto],
  })
  @IsOptional()
  @IsArray({ message: "8 向位置必须是数组" })
  @ArrayMinSize(EQUIPMENT_DIRECTIONS, { message: `8 向位置必须正好 ${EQUIPMENT_DIRECTIONS} 个` })
  @ArrayMaxSize(EQUIPMENT_DIRECTIONS, { message: `8 向位置必须正好 ${EQUIPMENT_DIRECTIONS} 个` })
  @ValidateNested({ each: true })
  @Type(() => EquipmentPointDto)
  outPositions?: EquipmentPointDto[];

  @ApiPropertyOptional({ description: "穿戴需求等级（不传则不改）", minimum: EQUIPMENT_LEVEL_MIN, maximum: EQUIPMENT_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  @Max(EQUIPMENT_LEVEL_MAX, { message: `等级不能大于 ${EQUIPMENT_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({
    description: "售卖价（不传则不改；0 = 不可售卖。**商城售价不在这里** —— 唯一写入口归商城定价管理）",
    minimum: 0,
    maximum: EQUIPMENT_SELL_PRICE_MAX,
  })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(EQUIPMENT_SELL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({
    description: "八项基础属性（**整份提交、整份替换**，不传则不改；区间型要求 0 ≤ min ≤ max）。变体属性 = 基础属性 × 前后缀倍率，在客户端展开",
    type: ConfigAttributesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigAttributesDto)
  attributes?: ConfigAttributesDto;

  @ApiPropertyOptional({ description: "掉落时强制绑定（#789；不传则不改）" })
  @IsOptional()
  @IsBoolean({ message: "掉落强制绑定必须是布尔值" })
  bindOnDrop?: boolean;
}

/**
 * 新建装备基础件入参（#773）
 *
 * 与「编辑」的分界很硬：**新建只填身份与基础数值**（部位 / 名称 / 等级 / 售价 / 职业性别 /
 * 描述 / 标签 / 三个资源路径），资源细节（缩放 / 旋转 / 锚点 / 8 向位置 / 八项属性）一律
 * 从 `templateId` 复制 —— 让运营在新建弹窗里手抄 8 个方向的位置是纯粹的折磨，而且抄错
 * 的话客户端会把这件装备画到屏幕外。建完在「编辑」弹窗里逐项改。
 *
 * `id` 可省：缺省按 `部位_序号` 生成（该部位现有最大序号 + 1，如 `cloth_33`）。
 * `slot` 必须是 `equipment_slots` 里的 key —— 这一刀放开的是「这个部位下的装备」，
 * 不是「新部位」（新增部位要动客户端槽位表与资源，属代码改动）。
 */
export class CreateEquipmentDto {
  @ApiPropertyOptional({
    description:
      "装备 id（可省 —— 缺省按 `部位_序号` 生成，如 cloth_33）。手填要求：小写字母开头，" +
      "只含小写字母 / 数字 / 下划线，≤40 字符；撞已有 id → 409（`50039`）",
    maxLength: 40,
  })
  @IsOptional()
  @IsString({ message: "id 必须是字符串" })
  @MaxLength(40, { message: "id 不能超过 40 字" })
  @Matches(/^[a-z][a-z0-9_]*$/, { message: "id 只能是小写字母开头的小写字母 / 数字 / 下划线" })
  id?: string;

  @ApiProperty({
    description: "部位（EQUIPMENT_TYPE 的枚举值，取值：" + EQUIPMENT_SLOT_KEYS.join(" / ") + "）—— 决定角色弹窗里的槽位",
  })
  @IsString({ message: "部位必须是字符串" })
  @IsIn(EQUIPMENT_SLOT_KEYS, { message: "部位取值不合法" })
  slot: string;

  @ApiProperty({ description: "名称（如「青铜重甲」；1~50 字，前后缀由客户端拼在名字前后）", maxLength: 50 })
  @IsString({ message: "名称必须是字符串" })
  @MinLength(1, { message: "名称不能为空" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label: string;

  @ApiPropertyOptional({
    description:
      "模板基础件 id（可省）：复制它的图标 / 内观图集 / 外观图集 / 标签 / 几何（缩放 / 旋转 / 锚点 / 8 向位置）/" +
      "职业性别 / 描述 / 八项属性 —— 新装备立刻可见可用。不给就是一张白纸（资源与几何全空，客户端看不到外观）",
  })
  @IsOptional()
  @IsString({ message: "模板 id 必须是字符串" })
  templateId?: string;

  @ApiPropertyOptional({ description: "穿戴需求等级（不传 = 跟模板；再不行 1）", minimum: EQUIPMENT_LEVEL_MIN, maximum: EQUIPMENT_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(EQUIPMENT_LEVEL_MIN, { message: `等级不能小于 ${EQUIPMENT_LEVEL_MIN}` })
  @Max(EQUIPMENT_LEVEL_MAX, { message: `等级不能大于 ${EQUIPMENT_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({
    description: "售卖价（不传 = 跟模板；再不行 0。0 = 不可售卖。**商城售价不在这里**）",
    minimum: 0,
    maximum: EQUIPMENT_SELL_PRICE_MAX,
  })
  @IsOptional()
  @IsInt({ message: "售卖价必须是整数" })
  @Min(0, { message: "售卖价不能为负" })
  @Max(EQUIPMENT_SELL_PRICE_MAX, { message: "售卖价超出防御性上限" })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "掉落时强制绑定（#789；不传 = 跟模板，再不行 false）" })
  @IsOptional()
  @IsBoolean({ message: "掉落强制绑定必须是布尔值" })
  bindOnDrop?: boolean;

  @ApiPropertyOptional({ description: "职业限制（不传 = 跟模板；再不行 4 = 不限）" })
  @IsOptional()
  @IsString({ message: "职业限制必须是字符串" })
  @IsIn(EQUIPMENT_OCCUPATION_KEYS, { message: "职业限制取值不合法" })
  occupation?: string;

  @ApiPropertyOptional({ description: "性别限制（不传 = 跟模板；再不行 3 = 不限）" })
  @IsOptional()
  @IsString({ message: "性别限制必须是字符串" })
  @IsIn(EQUIPMENT_SEX_KEYS, { message: "性别限制取值不合法" })
  sex?: string;

  @ApiPropertyOptional({ description: "描述（≤500 字）", maxLength: 500 })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(500, { message: "描述不能超过 500 字" })
  description?: string;

  @ApiPropertyOptional({ description: "标签（整份替换；每一项 ≤20 字，最多 8 个）", type: [String] })
  @IsOptional()
  @IsArray({ message: "标签必须是数组" })
  @ArrayMaxSize(8, { message: "标签最多 8 个" })
  @IsString({ each: true, message: "每个标签都必须是字符串" })
  @MaxLength(20, { each: true, message: "每个标签不超过 20 字" })
  tags?: string[];

  @ApiPropertyOptional({ description: "图标（resources 相对路径；不传 = 跟模板）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标必须是字符串" })
  @MaxLength(200, { message: "图标路径不能超过 200 字" })
  icon?: string;

  @ApiPropertyOptional({ description: "内观图集（resources 相对路径；不传 = 跟模板）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "内观图集必须是字符串" })
  @MaxLength(200, { message: "内观图集路径不能超过 200 字" })
  inAtlas?: string;

  @ApiPropertyOptional({ description: "外观图集（resources 相对路径；不传 = 跟模板）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "外观图集必须是字符串" })
  @MaxLength(200, { message: "外观图集路径不能超过 200 字" })
  outAtlas?: string;
}

/** 新建装备的回包：新建的那件 + 连带展开了多少个变体（档数由 `equipment_meta` 决定） */
export class CreateEquipmentResultDto {
  @ApiProperty({ description: "新建出来的装备基础件", type: EquipmentDto })
  @Type(() => EquipmentDto)
  equipment: EquipmentDto;

  @ApiProperty({ description: "连带展开的变体行数（= 前缀档数 × 后缀档数，出厂 15）", example: 15 })
  variants: number;
}

/** 一个部位的装备件数（管理端部位页签的计数徽章） */
export class EquipmentSlotCountDto {
  @ApiProperty({ description: "部位 key（EQUIPMENT_TYPE 的枚举值）" })
  slot: string;

  @ApiProperty({ description: "部位中文名（`equipment_slots.label`）" })
  label: string;

  @ApiProperty({ description: "这个部位下的基础件数" })
  count: number;
}

/**
 * 部位盘点（#773：管理端列表按部位拆页签）
 *
 * 顺序就是 `equipment_slots.sort_order` —— 与角色弹窗的槽位排列、背包「一键整理」的部位序
 * 同一份，不另排；`equipments` 里出现了但槽位表没有的部位补在末尾（历史脏数据也要点得到）。
 */
export class EquipmentSlotSummaryDto {
  @ApiProperty({ description: "装备基础件总数（= 各行 count 之和）" })
  total: number;

  @ApiProperty({ description: "按部位分组的件数", type: [EquipmentSlotCountDto] })
  @Type(() => EquipmentSlotCountDto)
  slots: EquipmentSlotCountDto[];
}

/** 删除装备的回包：连带清掉了什么（盘点给管理端提示用） */
export class RemoveEquipmentResultDto {
  @ApiProperty({ description: "被删掉的装备基础件 id" })
  id: string;

  @ApiProperty({ description: "连带删除的变体行数" })
  variants: number;

  @ApiProperty({ description: "连带删除的对齐几何行数（外观 + 内观工作台里指向这件装备的行）" })
  aligns: number;
}

//#region 装备槽位与规则（#603 第九域）

/**
 * 一个装备槽位
 *
 * 13 行、key 是 `EQUIPMENT_TYPE` 的枚举值，**不可增删**（新增部位属于代码改动）。
 * `order` 同时决定角色弹窗的槽位排列与背包「一键整理」的部位序。
 */
export class EquipmentSlotDto {
  @ApiProperty({ description: "槽位 key（EQUIPMENT_TYPE 的枚举值，如 cloth）" })
  key: string;

  @ApiProperty({ description: "槽位中文名（如「衣服」）" })
  label: string;

  @ApiProperty({ description: "槽位底图（resources 相对路径，如 ui/slot/cloth）" })
  imageSrc: string;

  @ApiProperty({ description: "在角色弹窗里的位置分组（left / right / bottom / custom）" })
  position: string;

  @ApiProperty({ description: "排序序号（从 0 起；槽位排列与背包整理序的唯一来源）" })
  order: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipmentSlotRow): EquipmentSlotDto {
    const dto = new EquipmentSlotDto();
    dto.key = row.key;
    dto.label = row.label;
    dto.imageSrc = row.image_src;
    dto.position = row.position;
    dto.order = row.sort_order;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 编辑槽位入参（**部分更新**；顺序不开放编辑 —— 它是 `EQUIPMENT_SLOT_SEEDS` 的书写序） */
export class UpdateEquipmentSlotDto {
  @ApiPropertyOptional({ description: "槽位中文名（不传则不改；≤20 字）", maxLength: 20 })
  @IsOptional()
  @IsString({ message: "槽位名必须是字符串" })
  @MaxLength(20, { message: "槽位名不能超过 20 字" })
  label?: string;

  @ApiPropertyOptional({ description: "槽位底图（resources 相对路径；空串 = 不显示底图）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "底图路径必须是字符串" })
  @MaxLength(200, { message: "底图路径不能超过 200 字" })
  imageSrc?: string;

  @ApiPropertyOptional({ description: "位置分组：left / right / bottom / custom" })
  @IsOptional()
  @IsString({ message: "位置分组必须是字符串" })
  @IsIn(["left", "right", "bottom", "custom"], { message: "位置分组取值不合法" })
  position?: string;

  @ApiPropertyOptional({ description: "排序序号（从 0 起；也决定背包「一键整理」的部位序）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "排序必须是整数" })
  @Min(0, { message: "排序不能为负" })
  @Max(999, { message: "排序超出防御性上限" })
  order?: number;
}

/**
 * 装备规则（单行）
 *
 * 前后缀倍率与文案**按下标一一对应**（长度必须相同，service 会校验）。
 * **回收价不在这里**（#655）：每件变体的 `sell_price` 是 `equipment_variants` 行里的一列，
 * 按等级取曲线价那套已经下架 —— 运营要调价就改那一行，不再有「改一段曲线带动全表」。
 */
export class EquipmentMetaDto {
  @ApiProperty({ description: "前缀属性倍率（下标 = EQUIPMENT_PREFIX 序号）", type: [Number] })
  prefixRates: number[];

  @ApiProperty({ description: "后缀属性倍率（下标 = EQUIPMENT_SUFFIX 序号）", type: [Number] })
  suffixRates: number[];

  @ApiProperty({ description: "前缀文案（与倍率同长）", type: [String] })
  prefixLabels: string[];

  @ApiProperty({ description: "后缀文案（与倍率同长）", type: [String] })
  suffixLabels: string[];

  @ApiProperty({
    description: "前缀文字颜色（#720，`#RRGGBB`，与文案同长；空数组 = 客户端按内置色渲染）",
    example: ["#DDDDDD", "#6EE86E", "#4DA6FF", "#C77DFF", "#FFA640"],
    type: [String],
  })
  prefixColors: string[];

  @ApiProperty({
    description: "后缀文字颜色（#720，`#RRGGBB`，与文案同长；空数组 = 客户端按内置色渲染）",
    example: ["#B0B0B0", "#4DE3FF", "#FFD700"],
    type: [String],
  })
  suffixColors: string[];

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipmentMetaRow): EquipmentMetaDto {
    const dto = new EquipmentMetaDto();
    dto.prefixRates = parseNumberArray(row.prefix_rates);
    dto.suffixRates = parseNumberArray(row.suffix_rates);
    dto.prefixLabels = parseStringArray(row.prefix_labels);
    dto.suffixLabels = parseStringArray(row.suffix_labels);
    dto.prefixColors = parseStringArray(row.prefix_colors);
    dto.suffixColors = parseStringArray(row.suffix_colors);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 重建全部装备变体的结果盘点（#697） */
export class EquipmentVariantRebuildResultDto {
  @ApiProperty({ description: "参与展开的基础件数", example: 37 })
  bases: number;

  @ApiProperty({ description: "前后缀组合数（前缀档数 × 后缀档数）", example: 15 })
  combos: number;

  @ApiProperty({ description: "重建后的变体总行数（= 基础件数 × 组合数）", example: 10275 })
  variants: number;
}

/** 编辑装备规则入参（**部分更新**；整份替换语义与更新 DTO 一致） */
export class UpdateEquipmentMetaDto {
  @ApiPropertyOptional({ description: "前缀倍率（整份替换；1~10 项，每项 > 0）", type: [Number] })
  @IsOptional()
  @IsArray({ message: "前缀倍率必须是数组" })
  @ArrayMinSize(1, { message: "前缀倍率至少 1 项" })
  @ArrayMaxSize(10, { message: "前缀倍率最多 10 项" })
  @IsNumber({}, { each: true, message: "倍率必须是数字" })
  @Min(0.01, { each: true, message: "倍率必须大于 0" })
  @Max(1000, { each: true, message: "倍率超出防御性上限" })
  prefixRates?: number[];

  @ApiPropertyOptional({ description: "后缀倍率（整份替换；1~10 项，每项 > 0）", type: [Number] })
  @IsOptional()
  @IsArray({ message: "后缀倍率必须是数组" })
  @ArrayMinSize(1, { message: "后缀倍率至少 1 项" })
  @ArrayMaxSize(10, { message: "后缀倍率最多 10 项" })
  @IsNumber({}, { each: true, message: "倍率必须是数字" })
  @Min(0.01, { each: true, message: "倍率必须大于 0" })
  @Max(1000, { each: true, message: "倍率超出防御性上限" })
  suffixRates?: number[];

  @ApiPropertyOptional({ description: "前缀文案（整份替换；必须与前缀倍率等长）", type: [String] })
  @IsOptional()
  @IsArray({ message: "前缀文案必须是数组" })
  @ArrayMinSize(1, { message: "前缀文案至少 1 项" })
  @ArrayMaxSize(10, { message: "前缀文案最多 10 项" })
  @IsString({ each: true, message: "文案必须是字符串" })
  @MaxLength(10, { each: true, message: "每档文案不超过 10 字" })
  prefixLabels?: string[];

  @ApiPropertyOptional({ description: "后缀文案（整份替换；必须与后缀倍率等长）", type: [String] })
  @IsOptional()
  @IsArray({ message: "后缀文案必须是数组" })
  @ArrayMinSize(1, { message: "后缀文案至少 1 项" })
  @ArrayMaxSize(10, { message: "后缀文案最多 10 项" })
  @IsString({ each: true, message: "文案必须是字符串" })
  @MaxLength(10, { each: true, message: "每档文案不超过 10 字" })
  suffixLabels?: string[];

  @ApiPropertyOptional({
    description: "前缀文字颜色（#720，整份替换；每项 #RRGGBB；必须与文案等长或空数组 = 全部用客户端内置色）",
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: "前缀颜色必须是数组" })
  @ArrayMinSize(0, { message: "前缀颜色不能是负数项" })
  @ArrayMaxSize(10, { message: "前缀颜色最多 10 项" })
  @IsString({ each: true, message: "颜色必须是字符串" })
  @Matches(/^#[0-9A-Fa-f]{6}$/, { each: true, message: "颜色要形如 #RRGGBB（6 位十六进制）" })
  prefixColors?: string[];

  @ApiPropertyOptional({
    description: "后缀文字颜色（#720，整份替换；口径同前缀颜色）",
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: "后缀颜色必须是数组" })
  @ArrayMinSize(0, { message: "后缀颜色不能是负数项" })
  @ArrayMaxSize(10, { message: "后缀颜色最多 10 项" })
  @IsString({ each: true, message: "颜色必须是字符串" })
  @Matches(/^#[0-9A-Fa-f]{6}$/, { each: true, message: "颜色要形如 #RRGGBB（6 位十六进制）" })
  suffixColors?: string[];
}

/** JSON 文本列 → 数字数组（脏数据降级成空数组） */
function parseNumberArray(text: string): number[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];
  } catch {
    return [];
  }
}

//#endregion

//#region 装备变体（#655：逐行配置）

/**
 * 装备变体列表查询入参（管理端「装备配置」页的变体弹窗）
 *
 * 变体不再单开一页（#781）：从这里进去的入口只有「某一件基础件的全部变体」，
 * 所以只要 `baseId` + 关键字 + 排序 —— 按部位 / 等级段收窄是列表页才需要的能力，
 * 跟着那一页一起下线了。
 */
export class EquipmentVariantQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "只列某个基础件的变体（如 cloth_1；弹窗就靠它）" })
  @IsOptional()
  @IsString({ message: "基础件 id 必须是字符串" })
  declare baseId?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配变体 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 装备变体分页结果 */
export class EquipmentVariantPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的装备变体", type: [EquipmentVariantDto] })
  list: EquipmentVariantDto[];
}

/**
 * 编辑一个装备变体（部分更新；id / 基础件 / 前后缀序号不可改）
 *
 * 属性拆成六组 min/max，与数据库列一一对应 —— 管理端点某一格时只送那一格。
 */
export class UpdateEquipmentVariantDto {
  @ApiPropertyOptional({ description: "名称（基础名，不含前后缀文案；前后缀由客户端按下标拼）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "穿戴需求等级（≥ 1）", minimum: 1 })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(1, { message: "等级至少为 1" })
  level?: number;

  @ApiPropertyOptional({ description: "回收价（≥ 0；货币 = 绑定元宝）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "回收价必须是整数" })
  @Min(0, { message: "回收价不能为负" })
  sellPrice?: number;

  @ApiPropertyOptional({ description: "八项属性（整份提交；不传则保留原值）", type: ConfigAttributesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigAttributesDto)
  attributes?: ConfigAttributesDto;
}

//#endregion
