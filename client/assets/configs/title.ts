import type { TitleAttributes, TitleLevelConfig } from "../types/title";
import type { Title as TitleRow } from "../ui/utils/net/ApiModels";

/**
 * 称号运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `titles` 表（书写处 = `server/src/shared/title-seed.ts`，
 * 管理端可改），进游戏时随快照 `titles` 段整表下发 —— 这里只剩运行时容器与取值函数，
 * 不再有任何称号数据或派生公式（等效等级映射搬去了服务端种子）。
 *
 * 口径与怪物（#588）、地图（#573）一致：
 * - **整表重建**（先清空再按行填，数组引用不变）：快照里没有的阶就是服务端没有的阶，
 *   留着本地旧行会让「管理端删了一阶」在客户端变成幽灵卡片；
 * - **快照先于预载必到**（`Game.start` 里 `loadGameConfig()` 在 `PreloadManager` 之前），
 *   称号弹窗 / 头顶名牌 / 预加载全部在进游戏后才读这张表，空表窗口玩家看不到。
 */

/** 称号等级序列（level 从 1 开始连续；快照到达前为空表） */
export const titleLevels: TitleLevelConfig[] = [];

/**
 * 快照 `titles` 段 → 运行时表（**整表重建**；消费方拿到的 `titleLevels` 引用不变）
 *
 * 快照行属性是 {min,max} 区间对象，这里转回客户端一直用的元组 `[min, max]`。
 */
export function applyTitleRows(rows: TitleRow[]): void {
  titleLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    titleLevels.push({
      level: row.level,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      bindGold: Number(row.bindGold) || 0,
      animation: String(row.animation ?? ""),
      animationFrameRate: Number(row.animationFrameRate) || 10,
      attributes: {
        maxHp: Number(row.attributes?.maxHp) || 0,
        hpRecover: Number(row.attributes?.hpRecover) || 0,
        physicalAttack: range(row.attributes?.physicalAttack ?? { min: 0, max: 0 }),
        magicAttack: range(row.attributes?.magicAttack ?? { min: 0, max: 0 }),
        taoistAttack: range(row.attributes?.taoistAttack ?? { min: 0, max: 0 }),
        physicalDefense: range(row.attributes?.physicalDefense ?? { min: 0, max: 0 }),
        magicDefense: range(row.attributes?.magicDefense ?? { min: 0, max: 0 }),
        taoistDefense: range(row.attributes?.taoistDefense ?? { min: 0, max: 0 }),
      } satisfies TitleAttributes,
    });
  }
  titleLevels.sort((a, b) => a.level - b.level);
}

/** 称号满级（快照到达前为 0 —— 上游 UI 在进游戏后才会读它） */
export function titleMaxLevel(): number {
  return titleLevels.length;
}

/**
 * 称号属性列表的显示名与顺序（称号弹窗右侧面板，与战魂同一套短名）
 * 数组即顺序，key 为 TitleAttributes 的字段名
 */
export const titleAttributeLabels: { key: keyof TitleAttributes; label: string }[] = [
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
 * 取某等级的称号配置
 * @param level 称号等级（0 或负数返回 null，表示尚未激活称号；快照未到时也返回 null）
 */
export function getTitleLevel(level: number): TitleLevelConfig | null {
  if (level < 1) return null;
  return titleLevels.find((config) => config.level === level) ?? null;
}
