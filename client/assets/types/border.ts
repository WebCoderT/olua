import type { EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX } from "./good";

/**
 * 边框资源（装备品质光效框）
 * 素材在 resources/borders 下：每个边框是一张 TexturePacker 图集（plist 与同名 png 成对），
 * 整包帧循环播放（原始尺寸随素材家族而异，显示尺寸的适配见 configs/layout/borders）。
 */
export interface BorderResource {
  /** 边框 key（= 图集文件名，如 sfx_30123_0；配置表之间用它互相关联） */
  key: string;
  /** 图集资源路径（resources 下、不含扩展名，如 borders/sfx_30123_0） */
  atlas: string;
}

/** 一条「前缀 × 后缀 → 边框」的映射（数组为源，configs/border 尾部建 Map） */
export interface BorderAssignment {
  /** 装备前缀（品质） */
  prefix: EQUIPMENT_PREFIX;
  /** 装备后缀（阶级） */
  suffix: EQUIPMENT_SUFFIX;
  /** 边框 key（configs/border.borders 的键） */
  border: string;
}

/** 一条「特殊装备 → 边框」的自定义映射（equipment = 物品 id 或基础件 key，命中后优先于前后缀表） */
export interface CustomBorderAssignment {
  /** 装备的物品 id（可以是带 _pXsY 的变体 id，也可以是基础件 key——基础件对其全部变体生效） */
  equipment: string;
  /** 边框 key（configs/border.borders 的键） */
  border: string;
}
