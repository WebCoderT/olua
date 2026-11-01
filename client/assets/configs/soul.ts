import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import type { Soul as SoulRow } from "../ui/utils/net/ApiModels";

/**
 * 战魂运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `souls` 表（书写处 = `server/src/shared/soul-seed.ts`，
 * 逐级明文表在服务端；管理端可改），进游戏时随快照 `souls` 段整表下发。
 * 这里只剩运行时容器与取值函数，不再有任何战魂数据。
 *
 * 口径与称号（#590）一致：整表重建、快照先于预载必到、空表窗口玩家看不到。
 */

/** 战魂等级序列（level 从 1 开始连续；快照到达前为空表） */
export const soulLevels: SoulLevelConfig[] = [];

/**
 * 快照 `souls` 段 → 运行时表（**整表重建**；消费方拿到的 `soulLevels` 引用不变）
 */
export function applySoulRows(rows: SoulRow[]): void {
  soulLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    soulLevels.push({
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
      } satisfies SoulAttributes,
    });
  }
  soulLevels.sort((a, b) => a.level - b.level);
}

/** 战魂满级（快照到达前为 0） */
export function soulMaxLevel(): number {
  return soulLevels.length;
}

/**
 * 战魂属性列表的显示名与顺序（战魂弹窗右侧面板）
 * 用短名（生命/物攻…）：面板窄，且与角色信息弹窗的属性列表（configs/good.goodShowAttributesLabel 全名）互不干扰
 */
export const soulAttributeLabels: { key: keyof SoulAttributes; label: string }[] = [
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
 * 取某等级的战魂配置
 * @param level 战魂等级（0 或负数返回 null，表示尚未激活战魂；快照未到时也返回 null）
 */
export function getSoulLevel(level: number): SoulLevelConfig | null {
  if (level < 1) return null;
  return soulLevels.find((config) => config.level === level) ?? null;
}
