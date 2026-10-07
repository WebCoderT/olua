import type { EQUIPMENT_PREFIX } from "./good";

/**
 * 光柱资源（装备落在地面上时、在装备图标上出现的品质光效）
 * 素材在 resources/effect/light 下：每个光柱是一个帧序列目录（同名编号文件夹，整包 14~15 帧循环），
 * 播放在地面掉落物节点的光柱子节点上（原始 400×400 画布，显示尺寸见 configs/layout/lights）。
 */
export interface LightResource {
  /** 光柱 key（= 目录名带上级路径，如 1 号光柱是 "light/1"；配置表之间用它互相关联） */
  key: string;
  /** 帧序列目录（resources 下路径、不含扩展名，如 effect/light/1） */
  dir: string;
}

/** 一条「装备前缀（品质）→ 光柱」的映射（数组为源，configs/light 尾部建 Map） */
export interface LightAssignment {
  /** 装备前缀（品质） */
  prefix: EQUIPMENT_PREFIX;
  /** 光柱 key（configs/light.lights 的键） */
  light: string;
}

/** 一条「特殊装备 → 光柱」的自定义映射（equipment = 物品 id 或基础件 key，命中后优先于前缀表） */
export interface CustomLightAssignment {
  /** 装备的物品 id（可以是带 _pXsY 的变体 id，也可以是基础件 key——基础件对其全部变体生效） */
  equipment: string;
  /** 光柱 key（configs/light.lights 的键） */
  light: string;
}
