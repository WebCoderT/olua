import { DropEntry, DropResult, DropTable } from "../../types/drop";

/** 在 [min, max] 区间随机取整数（自动纠正大小顺序） */
function randomInt(min: number, max: number): number {
  const minimum = Math.ceil(Math.min(min, max));
  const maximum = Math.floor(Math.max(min, max));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
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
 * 结算一次掉落表：按权重抽取 picks 次，每次抽中后判定概率与数量
 * @returns 掉落结果列表（同一物品多次命中会合并数量）
 */
export function rollDropTable(table: DropTable): DropResult[] {
  const picks = Math.max(0, Math.floor(table.picks ?? 1));
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
