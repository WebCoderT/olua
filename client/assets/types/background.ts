import type { EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX } from "./good";

/**
 * 详情背景资源（装备品质背景动画）
 * 素材在 resources/effect/background 下：每张背景是一个图集（bg-<编号>.plist + 同名 png，整包 6~20 帧循环），
 * 播放在物品详情弹窗自身的精灵上（原始尺寸随素材家族而异，显示尺寸跟随弹窗面板，见 configs/layout/backgrounds）。
 */
export interface DetailBackgroundResource {
  /** 背景 key（= 帧序列目录名，如 bg-16000；配置表之间用它互相关联） */
  key: string;
  /** 图集路径（resources 下 plist 路径、不含扩展名，如 effect/background/bg-16000） */
  dir: string;
}

/** 一条「前缀 × 后缀 → 详情背景」的映射（数组为源，configs/background 尾部建 Map） */
export interface DetailBackgroundAssignment {
  /** 装备前缀（品质） */
  prefix: EQUIPMENT_PREFIX;
  /** 装备后缀（阶级） */
  suffix: EQUIPMENT_SUFFIX;
  /** 详情背景 key（configs/background.detailBackgrounds 的键） */
  background: string;
}

/** 一条「特殊装备 → 详情背景」的自定义映射（equipment = 物品 id 或基础件 key，命中后优先于前后缀表） */
export interface CustomDetailBackgroundAssignment {
  /** 装备的物品 id（可以是带 _pXsY 的变体 id，也可以是基础件 key——基础件对其全部变体生效） */
  equipment: string;
  /** 详情背景 key（configs/background.detailBackgrounds 的键） */
  background: string;
}
