/**
 * 掉落系统类型
 * 掉落流程：怪物配置 drops → 解析掉落表 → 结算抽取次数 → 按权重抽取 N 次 → 概率/数量判定 → DropResult[]
 */

/** 掉落条目：从掉落表中按权重抽取，命中后按概率判定是否真正掉落 */
export interface DropEntry {
  /** 物品 id（物品总表 configs/items 的键） */
  goodId: string;
  /** 抽取权重（同一掉落表内的相对值，缺省 1；0 表示不参与权重抽取） */
  weight?: number;
  /** 掉落概率 0~1（抽中后再判定，缺省 1 表示必掉） */
  chance?: number;
  /** 数量区间 [最小, 最大]，缺省 [1, 1] */
  count?: [number, number];
}

/** 掉落表：按权重抽取 picks 次，决定本次掉落的物品与数量 */
export interface DropTable {
  /**
   * 抽取次数（= 本次掉落最多几件物品）：
   * - 数字：固定次数
   * - [最小, 最大]：每次结算在该区间内随机取整数（例 [1, 10] → 本次掉 1~10 件）
   * 缺省 1。**每次抽取都独立随机、可重复命中同一条目**（重复命中的会合并数量）。
   */
  picks?: DropPicks;
  /** 掉落条目池 */
  entries: DropEntry[];
}

/** 一次掉落结果 */
export interface DropResult {
  /** 物品 id */
  goodId: string;
  /** 掉落数量 */
  count: number;
}

/**
 * 怪物掉落配置
 * - 字符串：引用具名掉落表（configs/drop 的 dropTables），便于多怪物复用同一掉落
 * - 掉落表对象 / 掉落条目数组：内联掉落（条目数组等价于 { picks: 1, entries: 数组 }）
 */
export type DropSource = string | DropTable | DropEntry[];

/** 掉落数量配置：固定次数，或 [最小, 最大] 区间（每只怪可单独配，例 [1, 10] = 掉 1~10 件） */
export type DropPicks = number | [number, number];
