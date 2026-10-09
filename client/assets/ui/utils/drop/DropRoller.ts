import { DropEntry, DropPicks, DropResult, DropTable } from "../../../types/drop";

/**
 * 掉落表抽取（纯函数模块）
 * 只算出「掉了什么、各多少」，物品实例化与地面节点生成由 DropManager 负责
 */

/** 在 [min, max] 区间随机取整数（自动纠正大小顺序） */
function randomInt(min: number, max: number): number {
  const minimum = Math.ceil(Math.min(min, max));
  const maximum = Math.floor(Math.max(min, max));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * 结算本次「掉落件数」（= 抽取次数）
 * - 数字：固定次数
 * - [最小, 最大]：区间内随机（例 [1, 10] → 本次掉 1~10 件）
 * @returns 非负整数（0 表示这次不掉东西）
 */
export function rollDropPicks(picks?: DropPicks): number {
  if (Array.isArray(picks)) return Math.max(0, randomInt(picks[0], picks[1]));
  return Math.max(0, Math.floor(picks ?? 1));
}

/** 按权重抽取一个条目（权重 <= 0 的条目不参与；权重全为 0 时返回 null） */
function pickByWeight(entries: DropEntry[]): DropEntry | null {
  const weighted = entries.filter((entry) => (entry.weight ?? 1) > 0);
  if (!weighted.length) return null;
  const total = weighted.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight ?? 1;
    if (roll < 0) return entry;
  }
  return weighted[weighted.length - 1];
}

/**
 * 结算一次掉落表：先按数量区间定本次掉几件，再按权重抽取该次数
 * 每次抽取独立随机、**可重复命中同一条目**；抽中后判定概率与数量，重复物品合并数量
 * @returns 掉落结果列表（同一物品多次命中会合并数量）
 */
export function rollDropTable(table: DropTable): DropResult[] {
  const picks = rollDropPicks(table.picks);
  if (!picks || !table.entries.length) return [];
  const results: DropResult[] = [];

  for (let index = 0; index < picks; index++) {
    const entry = pickByWeight(table.entries);
    if (!entry) break;
    // 概率判定
    if (Math.random() > (entry.chance ?? 1)) continue;
    const count = randomInt(entry.count?.[0] ?? 1, entry.count?.[1] ?? 1);
    if (count <= 0) continue;
    // 同一物品合并数量
    const existed = results.find((result) => result.goodId === entry.goodId);
    if (existed) existed.count += count;
    else results.push({ goodId: entry.goodId, count });
  }
  return results;
}
