import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNumber, IsOptional, Max, Min, ValidateNested } from "class-validator";
import { EquipAlignRow } from "../../../database/rows";

/**
 * 装备对齐几何的接口契约（#513）
 *
 * 这份数据是**客户端布局**，不是玩法数值：服务端不参与任何计算，只负责"存一份、发一份"。
 * 之所以仍然放进服务端配置体系，是因为客户端配置打包在 bundle 里（改一行要重打 3G 的包），
 * 而位置要能"调完立刻生效"——于是布局覆盖也走配置下发这条路。
 */

/** 方向数（8 向站立）：客户端的 directions 是 8 个，数组长度不对说明页面与配置已经错位 */
export const EQUIP_ALIGN_DIRECTIONS = 8;

/** 外观缩放上下限（防御性；实际调参范围在 0.5 ~ 2 之间，10 是"再离谱也不该超过"的兜底） */
export const EQUIP_ALIGN_SCALE_MIN = 0.05;
export const EQUIP_ALIGN_SCALE_MAX = 10;

/** 位置分量上下限（游戏单位；角色本体高度约 80~480，四位数一定是谁把像素当游戏单位填了） */
export const EQUIP_ALIGN_POSITION_ABS_MAX = 10_000;

/**
 * id 的合法形态（`cloth:cloth_1` / `weapon:weapon_1` / `role:1`）
 *
 * 只做"形态"校验、不查是否存在：装备 id 来自客户端配置（变体规则在代码里），
 * 服务端没有那份清单，硬编一份百科会与配置漂移。**允许未知 id** 是有意的 ——
 * 新增一件衣服只要客户端配置里有，工作台就能调、能存，不需要先发服务端版本。
 */
export const EQUIP_ALIGN_ID_PATTERN = /^(cloth|weapon):[a-z0-9_]+$|^role:[12]$/;

/** 一个方向的位移（游戏单位，y 向上为正） */
export class EquipAlignPointDto {
  @ApiProperty({ description: "横向（游戏单位，向右为正）" })
  @IsNumber({}, { message: "x 必须是数字" })
  @Min(-EQUIP_ALIGN_POSITION_ABS_MAX, { message: `x 不能小于 ${-EQUIP_ALIGN_POSITION_ABS_MAX}` })
  @Max(EQUIP_ALIGN_POSITION_ABS_MAX, { message: `x 不能大于 ${EQUIP_ALIGN_POSITION_ABS_MAX}` })
  x: number;

  @ApiProperty({ description: "纵向（游戏单位，**向上为正**；与页面画布的 y 向下相反）" })
  @IsNumber({}, { message: "y 必须是数字" })
  @Min(-EQUIP_ALIGN_POSITION_ABS_MAX, { message: `y 不能小于 ${-EQUIP_ALIGN_POSITION_ABS_MAX}` })
  @Max(EQUIP_ALIGN_POSITION_ABS_MAX, { message: `y 不能大于 ${EQUIP_ALIGN_POSITION_ABS_MAX}` })
  y: number;
}

/** 一条对齐几何（管理端与玩家侧**同形状**：管理端看到什么，客户端就拿到什么） */
export class EquipAlignDto {
  @ApiProperty({ description: "目标 id：`cloth:<基础件>` / `weapon:<基础件>` / `role:<1|2>`（裸模按性别）" })
  id: string;

  @ApiProperty({ description: "外观缩放" })
  outScale: number;

  @ApiProperty({ description: "8 个方向的外观位移（顺序见客户端 configs/animation 的 directions）", type: [EquipAlignPointDto] })
  outPositions: EquipAlignPointDto[];

  @ApiProperty({
    description:
      "true = `outPositions` 是**绝对位置**（工作台手调的结果）；false = 运行时按身体帧自动算，`outPositions` 只当微调。武器的渐进语义，见 configs/equipAlign",
  })
  outManual: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipAlignRow): EquipAlignDto {
    const dto = new EquipAlignDto();
    dto.id = row.id;
    dto.outScale = row.out_scale;
    dto.outPositions = parsePositions(row.out_positions);
    dto.outManual = row.out_manual === 1;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 整份对齐表（33 行上下，不分页） */
export class EquipAlignListDto {
  @ApiProperty({ description: "全部已保存的对齐几何（**没有行 = 用客户端配置里的值**）", type: [EquipAlignDto] })
  list: EquipAlignDto[];
}

/**
 * 保存一条对齐几何（**整份覆盖**，不是部分更新）
 *
 * 为什么是覆盖而不是"只改传了的字段"：位置 / 缩放 / 是否用绝对值是一组**联动的状态**，
 * 分字段更新会让"我只想改 outScale"这种请求留下上一次的 outPositions —— 页面上看起来
 * 变成"改完缩放位置也变了"，非常难查。工作台本来就把当前 8 向全量拿在手上，整份提交没有成本。
 */
export class SaveEquipAlignDto {
  @ApiProperty({ description: "外观缩放", minimum: EQUIP_ALIGN_SCALE_MIN, maximum: EQUIP_ALIGN_SCALE_MAX })
  @IsNumber({}, { message: "外观缩放必须是数字" })
  @Min(EQUIP_ALIGN_SCALE_MIN, { message: `外观缩放不能小于 ${EQUIP_ALIGN_SCALE_MIN}` })
  @Max(EQUIP_ALIGN_SCALE_MAX, { message: `外观缩放不能大于 ${EQUIP_ALIGN_SCALE_MAX}` })
  outScale: number;

  @ApiProperty({
    description: "8 个方向的外观位移（**必须正好 8 个**，顺序见客户端 directions）",
    type: [EquipAlignPointDto],
    minItems: EQUIP_ALIGN_DIRECTIONS,
    maxItems: EQUIP_ALIGN_DIRECTIONS,
  })
  @IsArray({ message: "外观位移必须是数组" })
  @ArrayMinSize(EQUIP_ALIGN_DIRECTIONS, { message: `外观位移必须是 ${EQUIP_ALIGN_DIRECTIONS} 个方向` })
  @ArrayMaxSize(EQUIP_ALIGN_DIRECTIONS, { message: `外观位移必须是 ${EQUIP_ALIGN_DIRECTIONS} 个方向` })
  @ValidateNested({ each: true })
  @Type(() => EquipAlignPointDto)
  outPositions: EquipAlignPointDto[];

  @ApiPropertyOptional({
    description: "true = `outPositions` 是绝对位置；false / 缺省 = 运行时按身体帧自动算（只对武器有意义）",
  })
  @IsOptional()
  @IsBoolean({ message: "outManual 必须是布尔值" })
  outManual?: boolean;
}

/** JSON 列 → 位置数组（解析失败必须报错：静默补 0 会让整件装备跳到原点，比报错难查得多） */
function parsePositions(raw: string): EquipAlignPointDto[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`equip_aligns.out_positions 不是数组：${raw}`);
  }
  return parsed.map((entry) => parsePoint(entry, raw));
}

/**
 * 单个位置：`[x, y]` 或 `{x, y}` 都接受
 *
 * 存库时统一写成 `[[x, y], …]`（紧凑：8 个方向 × 33 件 = 264 对数字，写成对象会多三倍字节），
 * 但读的时候宽容一点没有成本 —— 手工改过库、或早期版本写的是对象，都不该让整份下发炸掉。
 */
function parsePoint(value: unknown, raw: string): EquipAlignPointDto {
  if (Array.isArray(value) && value.length === 2) {
    return toPoint(value[0], value[1], raw);
  }
  if (value && typeof value === "object") {
    const source = value as { x?: unknown; y?: unknown };
    return toPoint(source.x, source.y, raw);
  }
  throw new Error(`equip_aligns 位置形态不合法：${raw}`);
}

function toPoint(x: unknown, y: unknown, raw: string): EquipAlignPointDto {
  const point = new EquipAlignPointDto();
  point.x = Number(x);
  point.y = Number(y);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`equip_aligns 位置不是有限数：${raw}`);
  }
  return point;
}

/** 位置数组 → JSON 列（紧凑的 `[[x, y], …]`） */
export function serializePositions(points: EquipAlignPointDto[]): string {
  return JSON.stringify(points.map((point) => [point.x, point.y]));
}
