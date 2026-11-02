/**
 * 掉落出厂数据（**唯一书写处**，服务端）
 *
 * #254 起掉落抽签只在服务端做（`combat-settlement.service` 读 `drop_tables` /
 * `monster_drops`）；#581 起客户端连本地抽奖都删了，只演服务端给的 `reward.drops`。
 * 于是这张表在客户端已无运行时消费者 —— #603 把书写处搬到服务端，客户端 `configs/drop`
 * 只剩 `dropRuntime`（拾取半径 / 提示节流 / 散落间距这些手感参数）。
 *
 * 三张具名表 + 一张兜底表，服务端启动时 seed 进库（`INSERT OR IGNORE`，运营改过的行
 * 不会被重启盖回）。**改这里是改出厂值**（要重跑 `node tools/gen-shared-data.cjs` 并重新
 * seed）；改线上掉落请走管理端「掉落配置」。
 *
 * 条目缺省值（weight=1 / chance=1 / count=[1,1]）由生成器规整为全显式，
 * 消费方（服务端 / 管理端编辑器）不复制缺省规则。
 *
 * 每只怪的独立掉落表在 `monster-drop-seed.ts`（#602 起也在服务端），不在这里。
 */

/** 单条掉落：物品 id + 权重 + 概率 + 件数区间（缺省由生成器补全） */
export interface DropEntrySeed {
  goodId: string;
  weight?: number;
  chance?: number;
  count?: [number, number];
}

/** 一张掉落表：抽取次数（固定件数或区间）+ 条目池 */
export interface DropTableSeed {
  picks: number | [number, number];
  entries: DropEntrySeed[];
}

/** 具名掉落表（id → 表）：多只怪复用同一套掉落时按 id 引用 */
export const DROP_TABLE_SEED_ROWS: Array<DropTableSeed & { id: string }> = [
  /** 普通怪物掉落：少量药品/材料，偶出装备 */
  {
    id: "common",
    picks: 1,
    entries: [
      { goodId: "drug_hp_1", weight: 30, count: [1, 3] },
      { goodId: "drug_mp_1", weight: 20, count: [1, 2] },
      { goodId: "drug_hp_pct", weight: 8, count: [1, 1] },
      { goodId: "drug_mp_pct", weight: 8, count: [1, 1] },
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
      { goodId: "drug_hp_pct", weight: 8, count: [1, 1] },
      { goodId: "drug_mp_pct", weight: 8, count: [1, 1] },
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
      { goodId: "drug_hp_pct", weight: 8, count: [1, 1] },
      { goodId: "drug_mp_pct", weight: 8, count: [1, 1] },
      { goodId: "material_gem", weight: 20, count: [1, 3] },
      { goodId: "weapon_2", weight: 10, chance: 0.5 },
      { goodId: "cloth_1", weight: 10, chance: 0.5 },
      { goodId: "material_iron", weight: 20, count: [2, 5] },
    ],
  },
];

/**
 * 兜底掉落表：怪物既没有独立表、条目里也没引用具名表时使用
 *
 * 保证任何怪物都能掉东西（例如新增怪物后还没来得及铺掉落）。库里以 id `default` 落行。
 */
export const DROP_DEFAULT_SEED: DropTableSeed = {
  picks: [1, 2],
  entries: [
    { goodId: "drug_hp_1", weight: 40, count: [1, 2] },
    { goodId: "drug_hp_pct", weight: 8, count: [1, 1] },
    { goodId: "drug_mp_pct", weight: 8, count: [1, 1] },
    { goodId: "material_hide", weight: 30, count: [1, 2] },
    { goodId: "material_cloth", weight: 30, count: [1, 2] },
  ],
};
