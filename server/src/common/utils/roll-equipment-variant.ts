/**
 * 变体随机掉落（#1286）：把掉到的装备基础件按前后缀权重抽成一个变体 id
 *
 * ## 为什么是纯函数
 *
 * 抽档本身只依赖「两组权重 + 一次随机数」，不该摸库、不该读全局缓存 ——
 * 否则管理端改权重与服务端抽档之间多一层状态，测试也没法确定性复现。
 * 权重从 `equipment_meta` 读出来后由调用方传进来，`random` 可注入供单测。
 *
 * ## 口径
 *
 * - `p0s0` 的 id **就是基础件本身**（`cloth_1`，不带 `_p0s0`），其余 14 档才拼后缀；
 * - 组合权重 = 前缀权重 × 后缀权重。这里按两组权重**分别独立抽**，联合概率
 *   `w(p)/Σw(p) × w(s)/Σw(s)` 与组合权重归一化后完全等价，但少一张 15 项的表；
 * - 权重 0 = 该档不参与；全为 0 → 回落 p0s0（光板），不生成幽灵 id；
 * - 已经是变体 id 的原样返回 —— 运营在掉落表里手写的变体不该被二次抽档。
 *
 * 与 `combat-settlement.service.ts` 的 `rollDropTable` 不同：那一段抽「掉什么物品」，
 * 这里抽「这件装备是哪一档」，两段独立，互不干扰。
 */

import {
  DEFAULT_PREFIX_DROP_WEIGHTS,
  DEFAULT_SUFFIX_DROP_WEIGHTS,
} from "../constants/equipment-appearance";

/** 自带变体后缀的 id（p0s0 不是这个形状 —— 它的 id 等于基础件 id） */
const VARIANT_SUFFIX = /_p\d+s\d+$/;

export function isEquipmentVariantId(id: string): boolean {
  return VARIANT_SUFFIX.test(id);
}

/** 前后缀掉落权重（下标 = 档位序号） */
export interface EquipmentDropWeights {
  prefix: number[];
  suffix: number[];
}

/** 在权重数组里掷一次，返回命中的档位序号；没有有效档位 → 0（光板） */
function pickTier(weights: number[], random: () => number, fallback: number[]): number {
  const source = weights.length > 0 ? weights : fallback;
  const positive = source
    .map((weight, index) => ({ index, weight: Number(weight) }))
    .filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);
  if (positive.length === 0) return 0;
  const total = positive.reduce((sum, entry) => sum + entry.weight, 0);
  // random 注入值可能越界（单测里常用 0 / 1 卡边界），夹到 [0, 1) 保证一定落在某档
  const roll = Math.min(Math.max(Number(random()) || 0, 0), 0.999999999) * total;
  let cursor = roll;
  for (const entry of positive) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.index;
  }
  return positive[positive.length - 1].index;
}

/**
 * 掷出一个变体 id。
 *
 * @param baseId 掉落表里的装备基础件 id（已经是变体则原样返回）
 * @param weights 前后缀权重（长度可与档数不符：调用前应已由 service 对齐；这里只做容错）
 * @param random 可注入的随机源，缺省 `Math.random`
 */
export function rollVariantOfBase(
  baseId: string,
  weights: EquipmentDropWeights,
  random: () => number = Math.random,
): string {
  if (!baseId || isEquipmentVariantId(baseId)) return baseId;
  const prefix = pickTier(weights.prefix, random, DEFAULT_PREFIX_DROP_WEIGHTS);
  const suffix = pickTier(weights.suffix, random, DEFAULT_SUFFIX_DROP_WEIGHTS);
  if (prefix === 0 && suffix === 0) return baseId;
  return `${baseId}_p${prefix}s${suffix}`;
}
