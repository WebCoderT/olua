/**
 * 物品 / 材料 / 药品出厂数据（#603 第十域）—— **唯一书写处**
 *
 * ===========================================================================
 * 这张表管什么、不管什么
 * ===========================================================================
 * 三张表各管一段，互不重叠：
 *
 * | 内容 | 归谁 |
 * |---|---|
 * | 药品的显示与规则（名称 / 描述 / 图标 / 使用等级 / 售价 / 叠加 / 冷却 / 四段回复量） | **本文件** → `drugs` 表（管理端「药品配置」可改） |
 * | 材料的显示与规则（名称 / 描述 / 图标 / 等级 / 售价 / 叠加） | **本文件** → `items` 表（管理端「物品配置」可改） |
 * | 装备 | 不在本文件：`equipment-seed.ts` → `equipments` 表 |
 * | 八项战斗属性 / 回复量的**实际生效** | 不在表里：药品回复量由客户端 `resolveDrugRecovery` 按效果算、装备属性由 `growth-seed.equipmentStats` 算 |
 *
 * 图标（icon）在表里：它是「显示数据」，运营换一张图不该重打客户端包。
 * 资源路径的纪律是「**客户端拼得出来的一律不入库**」（地图 `map/<id>/<id>`、特效
 * `effect/<key>/<key>.plist`）；而药品 / 材料的图标与 id **没有可推导的约定**
 * （blood 药是 `item/fs_2`、材料是 `item/2010210`），拼不出来，只能存。
 *
 * ===========================================================================
 * 为什么 id 清单固定
 * ===========================================================================
 * 物品 id 被背包存档、掉落表、任务收集目标、成就 target 引用 —— 增删一行会让
 * 「玩家背包里那件东西」变成查不到的脏 id。所以管理端**只提供修改，不提供新建 / 删除**
 * （e2e 钉死 POST / DELETE 路由不存在），id 也只能在这里改 + 重新生成。
 *
 * 用法：本文件 → `GameConfigService.seedDrugs/seedItems`（INSERT OR IGNORE，改过的行不被覆盖）
 * → `drugs` / `items` 表 → `GET /game-config` 快照 → 客户端整表重建。
 */

/** 药品出厂行（`drugs` 表一行；effects 数组在种子里就按「同类求和」拍平，与客户端累加口径等价） */
export interface DrugSeedRow {
  /** 药品 id（如 `drug_hp_1`；主键，不可增删行） */
  id: string;
  /** 名称（如「金创药（小）」） */
  label: string;
  /** 描述文案 */
  description: string;
  /** 图标资源路径（resources 相对路径，如 `item/fs_2`） */
  icon: string;
  /** 使用等级需求 */
  level: number;
  /** 售卖价（0 = 不可售卖） */
  sellPrice: number;
  /** 最大叠加数量 */
  maxStack: number;
  /** 使用冷却（秒，0 = 无冷却） */
  cooldown: number;
  /** 固定回复生命 */
  effectHp: number;
  /** 固定回复魔法 */
  effectMp: number;
  /** 按角色 maxHp 的百分比回复（50 = 50%） */
  effectHpPercent: number;
  /** 按角色 maxMp 的百分比回复（50 = 50%） */
  effectMpPercent: number;
}

/**
 * 药品（8 种）
 *
 * 回复量按 `growth-seed` 的等级曲线定标：「小药 ≈ 1 级血量的 60%、中药 ≈ 5 级、大药 ≈ 10~20 级」——
 * 每档药大约回满它对应等级段的一条命，越级使用就会明显不够用。改了成长曲线记得回来同步这三档。
 *
 * 百分比药（强效血药 / 强效蓝药）不参与等级分档：回复量按 maxHp / maxMp 的百分比算，
 * 任何等级段都等价好用，因此所有怪物均可掉落（见 monster-drop-seed）。
 */
export const DRUG_SEED_ROWS: DrugSeedRow[] = [
  {
    id: "drug_hp_1",
    label: "金创药（小）",
    description: "外伤药，使用后恢复 60 点生命值。",
    icon: "item/fs_2",
    level: 1,
    sellPrice: 5,
    maxStack: 99,
    cooldown: 1,
    effectHp: 60,
    effectMp: 0,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_hp_2",
    label: "金创药（中）",
    description: "外伤药，使用后恢复 250 点生命值。",
    icon: "item/fs_3",
    level: 5,
    sellPrice: 15,
    maxStack: 99,
    cooldown: 1,
    effectHp: 250,
    effectMp: 0,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_hp_3",
    label: "金创药（大）",
    description: "外伤药，使用后恢复 900 点生命值。",
    icon: "item/fs_4",
    level: 10,
    sellPrice: 40,
    maxStack: 99,
    cooldown: 1,
    effectHp: 900,
    effectMp: 0,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_mp_1",
    label: "魔法药（小）",
    description: "使用后恢复 40 点魔法值。",
    icon: "item/sz_2",
    level: 1,
    sellPrice: 5,
    maxStack: 99,
    cooldown: 1,
    effectHp: 0,
    effectMp: 40,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_mp_2",
    label: "魔法药（中）",
    description: "使用后恢复 180 点魔法值。",
    icon: "item/sz_3",
    level: 5,
    sellPrice: 15,
    maxStack: 99,
    cooldown: 1,
    effectHp: 0,
    effectMp: 180,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_sun",
    label: "太阳水",
    description: "使用后同时恢复 150 点生命值与 80 点魔法值。",
    icon: "item/tz_2",
    level: 1,
    sellPrice: 45,
    maxStack: 99,
    cooldown: 1,
    effectHp: 150,
    effectMp: 80,
    effectHpPercent: 0,
    effectMpPercent: 0,
  },
  {
    id: "drug_hp_pct",
    label: "强效血药",
    description: "使用后恢复 50% 生命值，任何等级服用都等价好用。",
    icon: "item/fs_7",
    level: 20,
    sellPrice: 100,
    maxStack: 99,
    cooldown: 1,
    effectHp: 0,
    effectMp: 0,
    effectHpPercent: 50,
    effectMpPercent: 0,
  },
  {
    id: "drug_mp_pct",
    label: "强效蓝药",
    description: "使用后恢复 50% 魔法值，任何等级服用都等价好用。",
    icon: "item/sz_7",
    level: 20,
    sellPrice: 100,
    maxStack: 99,
    cooldown: 1,
    effectHp: 0,
    effectMp: 0,
    effectHpPercent: 0,
    effectMpPercent: 50,
  },
];

/**
 * 材料 / 其它物品出厂行（`items` 表一行）
 *
 * 只收 **MATERIAL / OTHER** 大类：装备在 `equipments` 表、药品在 `drugs` 表，
 * 三张表字段形态不同，混进一张表就得塞一堆可空列。
 */
export interface ItemBaseSeedRow {
  /** 物品 id（如 `material_hide`；主键，不可增删行） */
  id: string;
  /** 物品大类（GOOD_TYPE 的枚举值，如 `material`） */
  type: string;
  /** 名称 */
  label: string;
  /** 描述文案 */
  description: string;
  /** 图标资源路径（resources 相对路径，如 `item/2010210`） */
  icon: string;
  /** 等级需求 */
  level: number;
  /** 售卖价（0 = 不可售卖） */
  sellPrice: number;
  /** 最大叠加数量 */
  maxStack: number;
}

/** 材料（5 种）：用于合成 / 任务等用途，全部可叠加 */
export const ITEM_BASE_SEED_ROWS: ItemBaseSeedRow[] = [
  {
    id: "material_hide",
    type: "material",
    label: "兽皮",
    description: "从野兽身上剥下的皮，可用于制作防具。",
    icon: "item/2010210",
    level: 1,
    sellPrice: 2,
    maxStack: 99,
  },
  {
    id: "material_iron",
    type: "material",
    label: "铁矿",
    description: "常见的矿石，可用于打造武器。",
    icon: "item/2010310",
    level: 1,
    sellPrice: 3,
    maxStack: 99,
  },
  {
    id: "material_cloth",
    type: "material",
    label: "粗布",
    description: "粗糙的布料，可用于制作衣物。",
    icon: "item/2030410",
    level: 1,
    sellPrice: 2,
    maxStack: 99,
  },
  {
    id: "material_gem",
    type: "material",
    label: "宝石",
    description: "蕴含灵气的宝石，可用于强化装备。",
    icon: "item/2030702",
    level: 10,
    sellPrice: 50,
    maxStack: 99,
  },
  {
    id: "material_herb",
    type: "material",
    label: "药草",
    description: "常见的草药，可用于炼制药品。",
    icon: "item/2030810",
    level: 1,
    sellPrice: 2,
    maxStack: 99,
  },
];
