import { GOOD_TYPE } from "../types/good";

/**
 * 鼠标指针样式配置（唯一来源）
 * 游戏里鼠标指针由 CursorManager 统一接管，本文件只声明「长什么样」与「什么时候用哪个」：
 * - default：默认指针（空地 / 界面 / 无可交互目标）
 * - attack：指向怪物（可攻击目标）时的指针
 * - good：指向物品时的指针，形状沿用默认箭头，颜色按物品大类区分
 * 调整颜色/形状/大小/热点只改这里，不用碰任何逻辑代码
 */

/**
 * 指针形状名称
 * 形状的画法在 ui/utils/cursor/CursorPainter 中实现，新增一个形状 = 在那里补一个画法 + 在此加一个名称
 * - arrow：常规箭头（默认指针与物品指针使用）
 * - attack：箭头 + 目标环（一眼可辨的「可攻击」）
 * - crosshair：纯目标环准星（备用，比如以后要做「瞄准/施法」指针）
 */
export type CursorShape = "arrow" | "attack" | "crosshair";

/** 单个指针样式 */
export interface CursorStyle {
  /** 形状名称 */
  shape: CursorShape;
  /** 主色（十六进制字符串，如 "#FFFFFF"） */
  color: string;
  /** 描边色（深色描边保证在浅色背景上也看得清） */
  outlineColor: string;
  /** 指针尺寸（像素；浏览器会忽略过大的自定义指针，建议不超过 32） */
  size: number;
  /** 热点 X（指针的判定点，相对指针图片左上角） */
  hotspotX: number;
  /** 热点 Y */
  hotspotY: number;
}

export const cursorConfig = {
  /** 是否启用自定义指针（false = 全部使用系统默认箭头，便于排查显示问题） */
  enabled: true,

  /**
   * 悬停命中优先级（数值大的先判定）
   * 界面里的物品要高于世界里的对象：背包弹窗盖住怪物时，鼠标下应当是物品的颜色而不是攻击指针
   */
  priority: {
    /** 界面内的物品（背包格子、装备槽） */
    ui: 300,
    /** 世界中的怪物 */
    monster: 200,
    /** 地面上的掉落物 */
    drop: 100,
  },

  /** 默认指针：空地 / 界面 / 无可交互目标 */
  default: {
    shape: "arrow",
    color: "#FFFFFF",
    outlineColor: "#1A1A1A",
    size: 28,
    hotspotX: 2,
    hotspotY: 2,
  } as CursorStyle,

  /** 攻击指针：指向怪物（箭头 + 目标环，颜色偏红以强调可攻击） */
  attack: {
    shape: "attack",
    color: "#FF5A4D",
    outlineColor: "#3A0B06",
    size: 32,
    hotspotX: 2,
    hotspotY: 2,
  } as CursorStyle,

  /** 物品指针：形状与默认指针一致，只按物品大类换颜色 */
  good: {
    /** 形状（物品指针统一用箭头，与「正常箭头」保持一致） */
    shape: "arrow" as CursorShape,
    /** 描边色 */
    outlineColor: "#1A1A1A",
    /** 尺寸 */
    size: 28,
    /** 热点 */
    hotspotX: 2,
    hotspotY: 2,
    /** 各物品大类的指针颜色（新增物品大类时在这里补一条） */
    colors: new Map<GOOD_TYPE, string>([
      [GOOD_TYPE.EQUIPMENT, "#FFC53D"], // 装备：金色
      [GOOD_TYPE.DRUG, "#5CE65C"], // 药品：绿色
      [GOOD_TYPE.MATERIAL, "#5CB3FF"], // 材料：蓝色
      [GOOD_TYPE.OTHER, "#E6E6E6"], // 其他：灰白
    ]),
    /** 未在 colors 中配置颜色的大类回退到该颜色 */
    fallbackColor: "#FFFFFF",
  },
};

/** 取某物品大类对应的指针样式（形状统一为箭头，仅颜色按大类区分） */
export function getGoodCursorStyle(type: GOOD_TYPE): CursorStyle {
  const { shape, outlineColor, size, hotspotX, hotspotY, colors, fallbackColor } = cursorConfig.good;
  return {
    shape,
    color: colors.get(type) ?? fallbackColor,
    outlineColor,
    size,
    hotspotX,
    hotspotY,
  };
}
