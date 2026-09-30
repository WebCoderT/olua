import type { DropSource, DropTable } from "../types/drop";

/**
 * 掉落配置
 * 掉落表按权重抽取 picks 次，抽中后再按 chance 概率判定、按 count 区间取数量
 * 怪物配置（configs/monster）的 drops 既可以引用此处的具名掉落表（字符串 id），
 * 也可以直接内联一个掉落表对象；未配置时使用 defaultDropTable
 */
export const dropTables = new Map<string, DropTable>();

/** 普通怪物掉落：少量药品/材料，偶出装备 */
dropTables.set("common", {
  picks: 1,
  entries: [
    { goodId: "drug_hp_1", weight: 30, count: [1, 3] },
    { goodId: "drug_mp_1", weight: 20, count: [1, 2] },
    { goodId: "material_hide", weight: 20, count: [1, 2] },
    { goodId: "material_cloth", weight: 15, count: [1, 2] },
    { goodId: "material_herb", weight: 10, count: [1, 2] },
    { goodId: "material_iron", weight: 4, count: [1, 1] },
    { goodId: "shoes_1", weight: 1, chance: 0.5 },
  ],
});

/** 精英怪物掉落：掉落次数更多，装备与宝石权重提升 */
dropTables.set("elite", {
  picks: 2,
  entries: [
    { goodId: "drug_hp_2", weight: 25, count: [1, 2] },
    { goodId: "drug_mp_2", weight: 20, count: [1, 2] },
    { goodId: "material_gem", weight: 15, chance: 0.6, count: [1, 1] },
    { goodId: "helmet_1", weight: 12, chance: 0.3 },
    { goodId: "belt_1", weight: 12, chance: 0.3 },
    { goodId: "necklace_1", weight: 8, chance: 0.3 },
    { goodId: "ring_1", weight: 8, chance: 0.3 },
  ],
});

/** BOSS 掉落：必掉高价值物品 */
dropTables.set("boss", {
  picks: 3,
  entries: [
    { goodId: "drug_sun", weight: 20, count: [2, 5] },
    { goodId: "drug_hp_3", weight: 20, count: [1, 3] },
    { goodId: "material_gem", weight: 20, count: [1, 3] },
    { goodId: "weapon_2", weight: 10, chance: 0.5 },
    { goodId: "cloth_1", weight: 10, chance: 0.5 },
    { goodId: "material_iron", weight: 20, count: [2, 5] },
  ],
});

/** 未配置掉落表的怪物使用的默认掉落（保证任何怪物都能掉东西） */
export const defaultDropTable: DropTable = {
  picks: 1,
  entries: [
    { goodId: "drug_hp_1", weight: 40, count: [1, 2] },
    { goodId: "material_hide", weight: 30, count: [1, 2] },
    { goodId: "material_cloth", weight: 30, count: [1, 2] },
  ],
};

/**
 * 解析怪物掉落配置为掉落表
 * @param source 字符串引用具名掉落表；对象即内联掉落表；缺省使用默认掉落表
 */
export function resolveDropTable(source?: DropSource): DropTable {
  if (!source) return defaultDropTable;
  if (typeof source === "string") return dropTables.get(source) ?? defaultDropTable;
  return source;
}
