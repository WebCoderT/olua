import { EQUIPMENT_TYPE } from "../types/good";
import type { DropEntry, DropPicks, DropSource, DropTable } from "../types/drop";
import type { MonsterTier } from "../types/monster";
import { getNearestEquipmentId } from "./equipments";

/**
 * 掉落配置（兜底与具名表）
 *
 * **实际掉落以 configs/monsterDrops 的「每只怪独立掉落表」为准**，本文件负责：
 * 1. dropData：具名掉落表（字符串 id 引用，适合多怪物复用同一套掉落）
 * 2. monsterDrops(level, tier)：按等级/定位**兜底生成**条目数组——只在某只怪既没有
 *    独立掉落表、条目里也没写 drops 时才会用到（例如新增怪物后还没来得及铺掉落）
 * 3. 怪物条目里的 drops：直接写数组（每件物品单独配 weight/chance/count）
 *    或具名表 id，写了就完全覆盖上述两级；抽取次数独立配 dropPicks（默认 1/2/3）
 */
const dropData: Array<DropTable & { id: string }> = [
  /** 普通怪物掉落：少量药品/材料，偶出装备 */
  {
    id: "common",
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
  },
  /** 精英怪物掉落：掉落次数更多，装备与宝石权重提升 */
  {
    id: "elite",
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
  },
  /** BOSS 掉落：必掉高价值物品 */
  {
    id: "boss",
    picks: 3,
    entries: [
      { goodId: "drug_sun", weight: 20, count: [2, 5] },
      { goodId: "drug_hp_3", weight: 20, count: [1, 3] },
      { goodId: "material_gem", weight: 20, count: [1, 3] },
      { goodId: "weapon_2", weight: 10, chance: 0.5 },
      { goodId: "cloth_1", weight: 10, chance: 0.5 },
      { goodId: "material_iron", weight: 20, count: [2, 5] },
    ],
  },
];

/** 具名掉落表（id → 掉落表）：由 dropData 统一构建 */
export const dropTables = new Map<string, DropTable>();
for (const table of dropData) {
  dropTables.set(table.id, table);
}

/** 未配置掉落的怪物使用的默认掉落（保证任何怪物都能掉东西） */
export const defaultDropTable: DropTable = {
  picks: [1, 2],
  entries: [
    { goodId: "drug_hp_1", weight: 40, count: [1, 2] },
    { goodId: "material_hide", weight: 30, count: [1, 2] },
    { goodId: "material_cloth", weight: 30, count: [1, 2] },
  ],
};

/**
 * 解析怪物掉落配置为掉落表
 * @param source 具名表 id / 掉落表对象 / 掉落条目数组；缺省使用默认掉落表
 * @param picks 掉落件数：数字 = 固定件数，[最小, 最大] = 件数区间；
 *              仅 source 为条目数组时生效（数组本身不带件数，
 *              按怪物定位的默认件数由 configs/monster 的 dropPicks 传入）
 */
export function resolveDropTable(source?: DropSource, picks?: DropPicks): DropTable {
  if (!source) return defaultDropTable;
  if (typeof source === "string") return dropTables.get(source) ?? defaultDropTable;
  if (Array.isArray(source)) return { picks: picks ?? 1, entries: source };
  return source;
}

/**
 * **兜底**：按怪物等级与定位生成掉落条目数组
 *
 * 正常流程不会走到这里——每只怪的掉落已逐条配置在 configs/monsterDrops。
 * 只有「新增了怪物但还没铺独立掉落表」时才用它，保证任何怪都能掉东西。
 *
 * 分档规则：
 * - 药品：≤20 级小药、21~40 中药、41+ 大药（蓝药只有两档，21+ 用中药）
 * - 材料：兽皮/粗布/药草常掉，铁矿 10 级起、宝石 21 级起（概率掉）
 * - 装备：按怪物等级就近取件（getNearestEquipmentId），定位越高概率与权重越高
 *   · normal：鞋子 3% · elite：武器/头盔 12% · boss：武器/衣服 60%、戒指 40%
 */
export function monsterDrops(level: number, tier: MonsterTier = "normal"): DropEntry[] {
  const hpDrug = level <= 20 ? "drug_hp_1" : level <= 40 ? "drug_hp_2" : "drug_hp_3";
  const mpDrug = level <= 20 ? "drug_mp_1" : "drug_mp_2";
  const entries: DropEntry[] = [
    { goodId: hpDrug, weight: 30, count: [1, 2] },
    { goodId: mpDrug, weight: 18, count: [1, 2] },
    { goodId: "material_hide", weight: 10, count: [1, 2] },
    { goodId: "material_cloth", weight: 8, count: [1, 2] },
    { goodId: "material_herb", weight: 8, count: [1, 2] },
  ];
  if (level >= 10) entries.push({ goodId: "material_iron", weight: 6, count: [1, 2] });
  if (level >= 21) {
    entries.push({ goodId: "drug_sun", weight: 4, chance: 0.3 });
    entries.push({ goodId: "material_gem", weight: 4, chance: 0.4, count: [1, 2] });
  }
  // 装备：按怪物等级就近取一件（等级 ≤ 怪物等级里最高的那件），是否掉落再看 chance
  const pushEquipment = (slot: EQUIPMENT_TYPE, weight: number, chance: number) => {
    const goodId = getNearestEquipmentId(slot, level);
    if (goodId) entries.push({ goodId, weight, chance });
  };
  if (tier === "boss") {
    pushEquipment(EQUIPMENT_TYPE.WEAPON, 6, 0.6);
    pushEquipment(EQUIPMENT_TYPE.CLOTH, 6, 0.6);
    pushEquipment(EQUIPMENT_TYPE.RING, 4, 0.4);
  } else if (tier === "elite") {
    pushEquipment(EQUIPMENT_TYPE.WEAPON, 2, 0.12);
    pushEquipment(EQUIPMENT_TYPE.HELMET, 2, 0.12);
  } else {
    pushEquipment(EQUIPMENT_TYPE.SHOES, 1, 0.03);
  }
  return entries;
}

/** 怪物定位 → 兜底掉落件数区间（普通 1~3 / 精英 2~6 / BOSS 3~10） */
export function monsterDropPicks(tier: MonsterTier = "normal"): DropPicks {
  return tier === "boss" ? [3, 10] : tier === "elite" ? [2, 6] : [1, 3];
}
