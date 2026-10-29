import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsDefined, IsNumber, IsOptional, Max, Min, ValidateNested } from "class-validator";
import { EquipInAlignRow } from "../../../database/rows";

/**
 * 装备**内观**几何的接口契约（#523）
 *
 * 内观 = 角色信息弹窗里站在圆盘上的那套（衣服 + 武器），与场景里的 8 向外观看的是两组数据：
 * 外观是「每个方向一个位置」，内观只有**一个**朝向（弹窗里角色正面站着），所以这里是
 * 「一个位置 + 两轴缩放」，而不是 8 项数组。
 *
 * 与外观一样，服务端只负责存与发 —— 但内观的 `inManual` 决定客户端要不要**跳过**那个
 * 「按当前衣服内容 bbox 现算武器位置」的自动算法，所以这个字段是语义开关，不是备忘。
 */

/** 内观缩放上下限（调参实际范围 0.4 ~ 3；10 是「再离谱也不该超过」的兜底） */
export const EQUIP_IN_ALIGN_SCALE_MIN = 0.05;
export const EQUIP_IN_ALIGN_SCALE_MAX = 10;

/** 位置分量上下限（弹窗坐标系里的游戏单位，量级几十到几百） */
export const EQUIP_IN_ALIGN_POSITION_ABS_MAX = 10_000;

/**
 * 内观 id 的合法形态（`cloth:cloth_1` / `weapon:weapon_1`）
 *
 * 比外观少了 `role:*`：未穿衣服时内观**什么都不画**（没有裸模内观素材），
 * 所以没有「裸模内观」这个目标。与外观同样只校验形态、不查存在性 ——
 * 装备清单在客户端配置里，服务端硬编一份会漂移。
 */
export const EQUIP_IN_ALIGN_ID_PATTERN = /^(cloth|weapon):[a-z0-9_]+$/;

/** 内观位置（弹窗坐标系，原点 = 弹窗中心，y 向上） */
export class EquipInAlignPointDto {
  @ApiProperty({ description: "横向（弹窗坐标，向右为正）" })
  @IsNumber({}, { message: "x 必须是数字" })
  @Min(-EQUIP_IN_ALIGN_POSITION_ABS_MAX, { message: `x 不能小于 ${-EQUIP_IN_ALIGN_POSITION_ABS_MAX}` })
  @Max(EQUIP_IN_ALIGN_POSITION_ABS_MAX, { message: `x 不能大于 ${EQUIP_IN_ALIGN_POSITION_ABS_MAX}` })
  x: number;

  @ApiProperty({ description: "纵向（弹窗坐标，**向上为正**；与页面画布的 y 向下相反）" })
  @IsNumber({}, { message: "y 必须是数字" })
  @Min(-EQUIP_IN_ALIGN_POSITION_ABS_MAX, { message: `y 不能小于 ${-EQUIP_IN_ALIGN_POSITION_ABS_MAX}` })
  @Max(EQUIP_IN_ALIGN_POSITION_ABS_MAX, { message: `y 不能大于 ${EQUIP_IN_ALIGN_POSITION_ABS_MAX}` })
  y: number;
}

/** 一条内观几何（管理端与玩家侧**同形状**：管理端看到什么，客户端就拿到什么） */
export class EquipInAlignDto {
  @ApiProperty({ description: "目标 id：`cloth:<基础件>` / `weapon:<基础件>`" })
  id: string;

  @ApiProperty({ description: "内观横向缩放（客户端 `inScaleX`）" })
  inScaleX: number;

  @ApiProperty({ description: "内观纵向缩放（客户端 `inScaleY`）" })
  inScaleY: number;

  @ApiProperty({ description: "内观位置（弹窗坐标系，y 向上）", type: EquipInAlignPointDto })
  inPosition: EquipInAlignPointDto;

  @ApiProperty({
    description:
      "true = 用手调的绝对位置（工作台调过）；false = 客户端按当前衣服的内容 bbox 自动算，`inPosition` 不参与（只对武器有意义，衣服恒为 true）",
  })
  inManual: boolean;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: EquipInAlignRow): EquipInAlignDto {
    const dto = new EquipInAlignDto();
    dto.id = row.id;
    dto.inScaleX = row.in_scale_x;
    dto.inScaleY = row.in_scale_y;
    const point = new EquipInAlignPointDto();
    point.x = row.in_x;
    point.y = row.in_y;
    dto.inPosition = point;
    dto.inManual = row.in_manual === 1;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 整份内观表（31 行上下，不分页） */
export class EquipInAlignListDto {
  @ApiProperty({ description: "全部已保存的内观几何（**没有行 = 用客户端配置里的值**）", type: [EquipInAlignDto] })
  list: EquipInAlignDto[];
}

/**
 * 保存一条内观几何（**整份覆盖**，不是部分更新）
 *
 * 位置 / 缩放 / 是否用绝对值是一组联动状态：分字段更新会让「只想调缩放」的请求留下上一次的
 * 位置，页面上表现为「改完缩放人跑了」。工作台本来就把这三项全拿在手上，整份提交没有成本。
 */
export class SaveEquipInAlignDto {
  @ApiProperty({ description: "内观横向缩放", minimum: EQUIP_IN_ALIGN_SCALE_MIN, maximum: EQUIP_IN_ALIGN_SCALE_MAX })
  @IsNumber({}, { message: "内观横向缩放必须是数字" })
  @Min(EQUIP_IN_ALIGN_SCALE_MIN, { message: `内观横向缩放不能小于 ${EQUIP_IN_ALIGN_SCALE_MIN}` })
  @Max(EQUIP_IN_ALIGN_SCALE_MAX, { message: `内观横向缩放不能大于 ${EQUIP_IN_ALIGN_SCALE_MAX}` })
  inScaleX: number;

  @ApiProperty({ description: "内观纵向缩放", minimum: EQUIP_IN_ALIGN_SCALE_MIN, maximum: EQUIP_IN_ALIGN_SCALE_MAX })
  @IsNumber({}, { message: "内观纵向缩放必须是数字" })
  @Min(EQUIP_IN_ALIGN_SCALE_MIN, { message: `内观纵向缩放不能小于 ${EQUIP_IN_ALIGN_SCALE_MIN}` })
  @Max(EQUIP_IN_ALIGN_SCALE_MAX, { message: `内观纵向缩放不能大于 ${EQUIP_IN_ALIGN_SCALE_MAX}` })
  inScaleY: number;

  @ApiProperty({ description: "内观位置（弹窗坐标系，y 向上）", type: EquipInAlignPointDto })
  @IsDefined({ message: "缺少内观位置" })
  @ValidateNested()
  @Type(() => EquipInAlignPointDto)
  inPosition: EquipInAlignPointDto;

  @ApiPropertyOptional({ description: "true = 用绝对位置；false / 缺省 = 客户端自动算（只对武器有意义）" })
  @IsOptional()
  @IsBoolean({ message: "inManual 必须是布尔值" })
  inManual?: boolean;
}
