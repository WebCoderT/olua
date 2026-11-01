import type { RankAttributes, RankLevelConfig } from "../types/rank";
import type { Rank as RankRow } from "../ui/utils/net/ApiModels";

/**
 * 军衔运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `ranks` 表（书写处 = `server/src/shared/rank-seed.ts`，
 * 10 大段 × 10 阶与等效等级插值公式都在服务端；管理端可改文案与价格），
 * 进游戏时随快照 `ranks` 段整表下发（含 `tier` 大段名）。
 * 这里只剩运行时容器与取值函数，不再有任何军衔数据或插值公式。
 *
 * 口径与称号 / 战魂（#590）一致：整表重建、快照先于预载必到、空表窗口玩家看不到。
 */

/** 军衔阶数序列（level 从 1 连续到 100；快照到达前为空表） */
export const rankLevels: RankLevelConfig[] = [];

/**
 * 快照 `ranks` 段 → 运行时表（**整表重建**；消费方拿到的 `rankLevels` 引用不变）
 */
export function applyRankRows(rows: RankRow[]): void {
  rankLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    rankLevels.push({
      level: row.level,
      label: String(row.label ?? ""),
      tier: String(row.tier ?? ""),
      description: String(row.description ?? ""),
      bindGold: Number(row.bindGold) || 0,
      attributes: {
        maxHp: Number(row.attributes?.maxHp) || 0,
        hpRecover: Number(row.attributes?.hpRecover) || 0,
        physicalAttack: range(row.attributes?.physicalAttack ?? { min: 0, max: 0 }),
        magicAttack: range(row.attributes?.magicAttack ?? { min: 0, max: 0 }),
        taoistAttack: range(row.attributes?.taoistAttack ?? { min: 0, max: 0 }),
        physicalDefense: range(row.attributes?.physicalDefense ?? { min: 0, max: 0 }),
        magicDefense: range(row.attributes?.magicDefense ?? { min: 0, max: 0 }),
        taoistDefense: range(row.attributes?.taoistDefense ?? { min: 0, max: 0 }),
      } satisfies RankAttributes,
    });
  }
  rankLevels.sort((a, b) => a.level - b.level);
}

/** 军衔满阶（快照到达前为 0） */
export function rankMaxLevel(): number {
  return rankLevels.length;
}

/**
 * 军衔属性列表的显示名与顺序（军衔弹窗右侧面板，与战魂/称号同一套短名）
 * 数组即顺序，key 为 RankAttributes 的字段名
 */
export const rankAttributeLabels: { key: keyof RankAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某阶的军衔配置
 * @param level 军衔阶数（0 或负数返回 null，表示尚未授衔；快照未到时也返回 null）
 */
export function getRankLevel(level: number): RankLevelConfig | null {
  if (level < 1) return null;
  return rankLevels.find((config) => config.level === level) ?? null;
}
