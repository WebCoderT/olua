import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsNumber, Max, Min } from "class-validator";
import { UI_EFFECT_LIMITS } from "../../../common/constants/ui-effect";

/**
 * 特效管理的 DTO（#594 升级特效 / #634 掉落光效）
 *
 * 管的是特效的**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关），不是特效本体：
 * 图集在客户端资源包里（`upgrade` = `effect/<key>/<key>.plist`、掉落光效 =
 * `effect/light/<key>.plist`，都是两端约定），服务端连一列都没有 ——
 * 要换特效美术，路只有一条：换图集资源 → 重新分发资源包。所以这里没有「新建 / 删除」入参，
 * 行由启动 seed 按 `UI_EFFECT_DEFAULTS` 补出来（key 存在的前提是客户端有消费代码）。
 */

/** 管理端列表 / 保存返回的一行（含追账字段） */
export class UiEffectDto {
  @ApiProperty({ description: "特效 key（升级特效 = upgrade、掉落光效 = light-1~light-6；取值域见 UI_EFFECT_KEYS）", example: "upgrade" })
  key: string;

  @ApiProperty({ description: `摆位偏移 X（像素，相对挂点：升级特效 = UI 层锚点、掉落光效 = 掉落物图标中心，${UI_EFFECT_LIMITS.offsetMin}~${UI_EFFECT_LIMITS.offsetMax}）` })
  offsetX: number;

  @ApiProperty({ description: `摆位偏移 Y（像素，y 向上为正；相对挂点同 X，${UI_EFFECT_LIMITS.offsetMin}~${UI_EFFECT_LIMITS.offsetMax}）` })
  offsetY: number;

  @ApiProperty({ description: `横向缩放（${UI_EFFECT_LIMITS.scaleMin}~${UI_EFFECT_LIMITS.scaleMax}，1 = 原始尺寸）` })
  scaleX: number;

  @ApiProperty({ description: `纵向缩放（${UI_EFFECT_LIMITS.scaleMin}~${UI_EFFECT_LIMITS.scaleMax}，1 = 原始尺寸）` })
  scaleY: number;

  @ApiProperty({ description: `旋转（度，顺时针，${UI_EFFECT_LIMITS.rotateMin}~${UI_EFFECT_LIMITS.rotateMax}）` })
  rotate: number;

  @ApiProperty({ description: `一轮播放总时长（毫秒，${UI_EFFECT_LIMITS.durationMinMs}~${UI_EFFECT_LIMITS.durationMaxMs}；帧率 = 帧数 / 时长）` })
  durationMs: number;

  @ApiProperty({ description: "开关（false = 关：客户端不再创建特效节点）" })
  enabled: boolean;

  @ApiProperty({ description: "最后一个改它的管理员账号名（追账用，与审计日志能对上）" })
  updatedBy: string;

  @ApiProperty({ description: "最后修改时间（毫秒时间戳；0 = 从没改过，仍是出厂值）" })
  updatedAt: number;
}

/** 配置快照下发的精简行（客户端只需要表现参数，追账字段不发） */
export class UiEffectConfigDto {
  @ApiProperty({ description: "特效 key", example: "upgrade" })
  key: string;

  @ApiProperty({ description: "摆位偏移 X（像素，相对挂点：升级特效 = UI 层锚点、掉落光效 = 图标中心）" })
  offsetX: number;

  @ApiProperty({ description: "摆位偏移 Y（像素，y 向上为正）" })
  offsetY: number;

  @ApiProperty({ description: "横向缩放（1 = 原始尺寸）" })
  scaleX: number;

  @ApiProperty({ description: "纵向缩放（1 = 原始尺寸）" })
  scaleY: number;

  @ApiProperty({ description: "旋转（度，顺时针）" })
  rotate: number;

  @ApiProperty({ description: "一轮播放总时长（毫秒）" })
  durationMs: number;

  @ApiProperty({ description: "开关（false = 关：客户端不播这个特效）" })
  enabled: boolean;
}

/** 保存一个特效的表现参数（整份覆盖） */
export class SaveUiEffectDto {
  @IsInt()
  @Min(UI_EFFECT_LIMITS.offsetMin)
  @Max(UI_EFFECT_LIMITS.offsetMax)
  offsetX!: number;

  @IsInt()
  @Min(UI_EFFECT_LIMITS.offsetMin)
  @Max(UI_EFFECT_LIMITS.offsetMax)
  offsetY!: number;

  @IsNumber()
  @Min(UI_EFFECT_LIMITS.scaleMin)
  @Max(UI_EFFECT_LIMITS.scaleMax)
  scaleX!: number;

  @IsNumber()
  @Min(UI_EFFECT_LIMITS.scaleMin)
  @Max(UI_EFFECT_LIMITS.scaleMax)
  scaleY!: number;

  @IsInt()
  @Min(UI_EFFECT_LIMITS.rotateMin)
  @Max(UI_EFFECT_LIMITS.rotateMax)
  rotate!: number;

  @IsInt()
  @Min(UI_EFFECT_LIMITS.durationMinMs)
  @Max(UI_EFFECT_LIMITS.durationMaxMs)
  durationMs!: number;

  @IsBoolean()
  enabled!: boolean;
}

/** 管理端列表（行由 seed 决定，个位数行，不分页） */
export class UiEffectListDto {
  @ApiProperty({ description: "行数（= 特效 key 数）" })
  total!: number;

  @ApiProperty({ description: "全部特效行，按 seed 顺序（= UI_EFFECT_KEYS 登记顺序：升级特效在最前，掉落光效按档排）", type: [UiEffectDto] })
  list!: UiEffectDto[];
}
