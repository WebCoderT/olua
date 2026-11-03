/**
 * 运行时运营配置覆盖层（#544）
 *
 * ===========================================================================
 * 解决什么
 * ===========================================================================
 * 管理端改的是**数据库**，而服务端结算（角色属性 / 技能 / 背包叠加）此前读的是
 * `game-data.generated.ts` —— 那份是**编译期**快照（客户端 configs 的镜像）。
 * 于是「管理端把某件装备的攻击从 10 调到 20」在客户端会生效（快照下发后 `apply-snapshot`
 * 原地覆写），服务端算伤害却还是 10：两端数值分裂，而且**没有任何报错**
 * （玩家看到的面板与服务端结算不一致，只会被当成"数值算错了"）。
 *
 * 这一层把运营库接进结算链路：服务端启动时、以及管理端每次写操作之后，
 * 把库里的当前值装进这里；读取方**先查这里、缺省回落生成物**。
 * 生成物因此恢复它本来的身份 —— **出厂值**（seed 来源 + 兜底），真相在库里。
 *
 * ===========================================================================
 * 为什么是「覆盖层」而不是就地改写生成物对象
 * ===========================================================================
 * 生成物是 `const` 表、被多处读取点共享。就地改写它，「出厂值」就随运营改动一起消失：
 * e2e 在两次断言之间恢复不了原状，诊断「这个数是运营改的还是配置里本来就有的」也没依据。
 * 覆盖层可以 `resetRuntimeOverrides()`，边界清楚。
 *
 * ===========================================================================
 * 口径
 * ===========================================================================
 * - 只在内存：进程重启后由 `RuntimeConfigService.onModuleInit` 重新装（DB 是持久的）；
 * - **缺表 = 没有运营改动**（Map 为 null）→ 回落生成物，行为与「上这一层之前」逐值相同；
 * - 形状与生成物**逐字段对齐**（管理端 DTO 也是同一形状），这里不发明第二套命名；
 * - 装备变体按「基础件 × 前后缀倍率」重算，倍率取生成物里那两张表 —— 与客户端
 *   `buildEquipmentMap` / `applyEquipmentRows` 是同一组数字与同一个取整口径（`Math.round`），
 *   否则管理端改一件、服务端算出另一件。
 */

import {
  COMBAT_WEIGHTS,
  DRUGS,
  EQUIPMENT_ATTRIBUTES,
  EQUIPMENT_BASES,
  ITEM_BASES,
  SELL_PRICES,
  SKILLS,
} from "./game-data.generated";
import { ROLE_LEVEL_ATTRIBUTES } from "./growth-seed";
import { RANK_LEVEL_ATTRIBUTES } from "./rank-seed";
import { SOUL_LEVEL_ATTRIBUTES } from "./soul-seed";
import { TITLE_LEVEL_ATTRIBUTES } from "./title-seed";

/** 生成物里「一份属性包」的形状：单值 + 六项区间元组 */
export type AttributeBundle = Record<string, unknown>;

/**
 * 八项属性在**数据库行**里的扁平列形状
 *
 * 装备 / 称号 / 战魂 / 军衔四张表用的是同一组列（只多不少），所以一个接口够用 ——
 * 结构化类型，不需要 database 层的 Row 定义（shared 不反向依赖 database）。
 */
export interface AttributeColumns {
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
}

/**
 * 装备变体的一行（`equipment_variants` 表；#655）
 *
 * 以前这里是「基础件一行 + 倍率展开 15 个」，现在是 555 行逐一配置 ——
 * 属性、卖价、穿戴等级都有自己的列，运行时不再乘任何倍率。
 */
export interface EquipmentVariantOverride extends AttributeColumns {
  id: string;
  base_id: string;
  prefix: number;
  suffix: number;
  label: string;
  level: number;
  sell_price: number;
}

/**
 * 角色等级的一行（`role_levels` 表；#655）
 *
 * 以前是「曲线采样 + 派生」，现在 60 行都是配置值。`max_mp` 不在 `AttributeColumns` 里
 * （那套列只给装备 / 称号 / 战魂 / 军衔共用），所以这里单独补上。
 */
export interface RoleLevelOverride extends AttributeColumns {
  level: number;
  exp: number;
  max_mp: number;
}

/** 物品 / 材料的一行（`items` 表：叠加上限与卖价参与结算） */
export interface ItemOverride {
  id: string;
  label: string;
  description: string;
  level: number;
  sell_price: number;
  max_stack: number;
}

/** 称号 / 战魂 / 军衔的一行（level 是主键，1 起） */
export interface LevelOverride extends AttributeColumns {
  level: number;
}

/** 技能行 → 生成物 `SKILLS` 的形状（字段名走 camelCase，布尔列转 boolean） */
export interface SkillOverride {
  id: string;
  owner: string;
  label: string;
  icon: string;
  category: string;
  target_type: string;
  action: string;
  effect: string;
  effect_on_self: number;
  cooldown: number;
  mp_cost: number;
  distance: number;
  level_req: number;
  description: string;
  damage_coefficients: string;
  status_id: string;
  cast_lock_ms: number;
  require_target: number;
  can_auto: number;
}

/** 药品行（结算只用到 maxStack，但形状给全，将来用药回复也能直接接） */
export interface DrugOverride {
  id: string;
  label: string;
  description: string;
  level: number;
  sell_price: number;
  max_stack: number;
  cooldown: number;
  effect_hp: number;
  effect_mp: number;
  effect_hp_percent: number;
  effect_mp_percent: number;
}

//#region 存储（null = 没有运营改动，读取方回落生成物）

/**
 * 装备变体：id → { 属性包, 穿戴等级, 回收价 }（#655 起 555 行逐一配置）
 *
 * 三个值同进同出：它们在一行里，分开存三个 Map 只会让「装了属性忘了装价」这种
 * 半截状态成为可能。`null` = 表里没有行 → 回落生成物（出厂值兜底，见 getter）。
 */
let equipmentVariantRows: Map<string, { bundle: AttributeBundle; level: number; price: number }> | null = null;
/** 角色等级：等级 → 属性包（#655 起 60 行逐一配置） */
let roleLevelRows: Map<number, AttributeBundle> | null = null;
let titleBundles: Map<number, AttributeBundle> | null = null;
let soulBundles: Map<number, AttributeBundle> | null = null;
let rankBundles: Map<number, AttributeBundle> | null = null;
let skillRows: Map<string, AttributeBundle> | null = null;
let drugRows: Map<string, AttributeBundle> | null = null;
let itemRows: Map<string, AttributeBundle> | null = null;

/**
 * 战斗力权重（#605）：属性名 → 倍率；null = 没有运营改动，回落生成物 `COMBAT_WEIGHTS`
 *
 * 由 `CombatWeightsService` 装载（它拥有 `combat_weights` 表：启动 seed 后装一次、
 * 管理端每次 PATCH 后装一次）—— 与其余覆盖层由 `RuntimeConfigService` 装载不同，
 * 因为这张表的读写都收在那一个 service 里。
 */
let combatWeights: Record<string, number> | null = null;

//#endregion

//#region 写入（由 RuntimeConfigService 调用）

/** DB 行 → 生成物的属性包形状（列 → 单值 / 元组） */
export function attributeBundleOf(row: AttributeColumns): AttributeBundle {
  return {
    maxHp: numberOr(row.max_hp),
    hpRecover: numberOr(row.hp_recover),
    physicalAttack: [numberOr(row.physical_attack_min), numberOr(row.physical_attack_max)],
    magicAttack: [numberOr(row.magic_attack_min), numberOr(row.magic_attack_max)],
    taoistAttack: [numberOr(row.taoist_attack_min), numberOr(row.taoist_attack_max)],
    physicalDefense: [numberOr(row.physical_defense_min), numberOr(row.physical_defense_max)],
    magicDefense: [numberOr(row.magic_defense_min), numberOr(row.magic_defense_max)],
    taoistDefense: [numberOr(row.taoist_defense_min), numberOr(row.taoist_defense_max)],
  };
}

/**
 * 装进角色等级的当前值（`role_levels` 表；传空数组 = 清空回落生成物）
 *
 * #655：曲线（`growth_segments`）不再参与运行时，60 行是配置值。
 * `bundleOfRoleLevel` 顺手把 `maxMp` 塞进属性包 —— 下游 `role-attributes` 就按
 * 「等级包 + 装备包 + 三条成长线包」统一求和，不用给 maxMp 单开一条路径。
 */
export function applyRoleLevels(rows: RoleLevelOverride[]): void {
  if (!rows.length) {
    roleLevelRows = null;
    return;
  }
  const map = new Map<number, AttributeBundle>();
  for (const row of rows) {
    map.set(numberOr(row.level), { ...attributeBundleOf(row), maxMp: numberOr(row.max_mp) });
  }
  roleLevelRows = map;
}

/**
 * 装进装备变体的当前值（`equipment_variants` 表；555 行）
 *
 * 与旧的 `applyEquipmentOverrides` 的本质区别：**不再乘倍率**。库里每一行都是
 * 「某前缀某后缀那件装备」的最终属性与价签，这里只做形状转换。
 *
 * 传空数组 = 清空覆盖 → 读取方回落生成物（出厂值兜底，e2e 用临时库时不会因为
 * 没跑迁移就属性全 0；生产库启动时由 `RuntimeConfigService` 装上 555 行）。
 */
export function applyEquipmentVariants(rows: EquipmentVariantOverride[]): void {
  if (!rows.length) {
    equipmentVariantRows = null;
    return;
  }
  const map = new Map<string, { bundle: AttributeBundle; level: number; price: number }>();
  for (const row of rows) {
    map.set(row.id, {
      bundle: attributeBundleOf(row),
      level: numberOr(row.level),
      price: numberOr(row.sell_price),
    });
  }
  equipmentVariantRows = map;
}

/** 装进物品 / 材料的当前值（`items` 表：叠加上限、卖价；形状与生成物 `ITEM_BASES` 对齐） */
export function applyItemOverrides(rows: ItemOverride[]): void {
  if (!rows.length) {
    itemRows = null;
    return;
  }
  const map = new Map<string, AttributeBundle>();
  for (const row of rows) {
    map.set(row.id, {
      type: "",
      label: row.label,
      description: row.description,
      level: numberOr(row.level),
      sellPrice: numberOr(row.sell_price),
      maxStack: numberOr(row.max_stack),
    });
  }
  itemRows = map;
}

/** 装进称号 / 战魂 / 军衔的当前值（键 = 等级，1 起） */
export function applyTitleOverrides(rows: LevelOverride[]): void {
  titleBundles = rows.length ? bundleMapOf(rows) : null;
}

export function applySoulOverrides(rows: LevelOverride[]): void {
  soulBundles = rows.length ? bundleMapOf(rows) : null;
}

export function applyRankOverrides(rows: LevelOverride[]): void {
  rankBundles = rows.length ? bundleMapOf(rows) : null;
}

/** 装进技能的当前值（整行；服务端结算读冷却 / 伤害系数 / 耗蓝） */
export function applySkillOverrides(rows: SkillOverride[]): void {
  if (!rows.length) {
    skillRows = null;
    return;
  }
  const map = new Map<string, AttributeBundle>();
  for (const row of rows) {
    map.set(row.id, {
      owner: row.owner,
      label: row.label,
      icon: row.icon,
      category: row.category,
      targetType: row.target_type,
      action: row.action,
      effect: row.effect,
      effectOnSelf: row.effect_on_self === 1,
      cooldown: numberOr(row.cooldown),
      mpCost: numberOr(row.mp_cost),
      distance: numberOr(row.distance),
      levelReq: numberOr(row.level_req),
      description: row.description,
      damageCoefficients: parseDamageCoefficients(row.damage_coefficients),
      statusId: row.status_id,
      castLockMs: numberOr(row.cast_lock_ms),
      requireTarget: row.require_target === 1,
      canAuto: row.can_auto === 1,
    });
  }
  skillRows = map;
}

/** 装进药品的当前值（背包叠加 / 用药上限用它；形状与生成物 `DRUGS` 对齐） */
export function applyDrugOverrides(rows: DrugOverride[]): void {
  if (!rows.length) {
    drugRows = null;
    return;
  }
  const map = new Map<string, AttributeBundle>();
  for (const row of rows) {
    map.set(row.id, {
      label: row.label,
      description: row.description,
      level: numberOr(row.level),
      sellPrice: numberOr(row.sell_price),
      maxStack: numberOr(row.max_stack),
      cooldown: numberOr(row.cooldown),
      hp: numberOr(row.effect_hp),
      mp: numberOr(row.effect_mp),
      hpPercent: numberOr(row.effect_hp_percent),
      mpPercent: numberOr(row.effect_mp_percent),
    });
  }
  drugRows = map;
}

/**
 * 装进战斗力权重的当前值（`combat_weights` 表；传 null 清空回落生成物）
 *
 * **只认生成物里已有的键**：键集由 `shared/combat-seed.ts` 决定（那是战斗力的算法本身），
 * 运营改的是「每一项值多少」，不是「有哪几项」—— 库里冒出未知键说明有人在手改数据，
 * 直接忽略比让它参与求和更安全（否则一个拼错的键会静默抬高所有人的战力）。
 * 非有限数字 / 负数同样忽略。
 */
export function applyCombatWeightsOverrides(weights: Record<string, number> | null): void {
  if (!weights) {
    combatWeights = null;
    return;
  }
  const next: Record<string, number> = {};
  for (const key of Object.keys(COMBAT_WEIGHTS)) {
    const value = Number(weights[key]);
    next[key] = Number.isFinite(value) && value >= 0 ? value : numberOr((COMBAT_WEIGHTS as Record<string, number>)[key]);
  }
  combatWeights = next;
}

/** 清空全部覆盖（e2e 之间隔离用；生产只在进程启动时天然为空） */
export function resetRuntimeOverrides(): void {
  equipmentVariantRows = null;
  roleLevelRows = null;
  titleBundles = null;
  soulBundles = null;
  rankBundles = null;
  skillRows = null;
  drugRows = null;
  itemRows = null;
  combatWeights = null;
}

//#endregion

//#region 读取（结算链路的唯一入口：先覆盖层、再生成物）

/**
 * 当前战斗力权重（**服务端算战力 / 地图准入门槛的唯一入口**）
 *
 * 运营在管理端「战斗力权重」页改完，下一次算属性就用新倍率 —— 客户端也从快照拿到
 * 同一组数字（`applyCombatWeights`），两端不会「面板显示 1200、服务端按 1000 判准入」。
 *
 * 返回值是内部对象，**调用方只读**（不要改它：它被所有结算共享）。
 */
export function combatWeightsOf(): Record<string, number> {
  return combatWeights ?? (COMBAT_WEIGHTS as Record<string, number>);
}

/**
 * 某等级的角色裸属性；表里没有该级时回落生成物（出厂值兜底）
 *
 * #655：`role_levels` 是权威，60 行都由管理端逐行维护。生成物只兜两种情况：
 * 迁移还没跑（空库启动），以及等级超出表范围（运营调低了 roleMaxLevel 但存档里有老角色）。
 */
export function roleLevelAttributesOf(level: number | undefined): AttributeBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  const levelValue = Math.trunc(value);
  const fromTable = roleLevelRows?.get(levelValue);
  if (fromTable) return fromTable;
  const bundle = (ROLE_LEVEL_ATTRIBUTES as Record<string, AttributeBundle>)[String(levelValue)];
  return bundle && typeof bundle === "object" ? bundle : null;
}

/** 某件装备（含变体）的当前属性；查不到返回 null（调用方按"没穿"处理并记账） */
export function equipmentAttributesOf(id: string): AttributeBundle | null {
  return (
    equipmentVariantRows?.get(id)?.bundle ??
    (EQUIPMENT_ATTRIBUTES as Record<string, AttributeBundle>)[id] ??
    null
  );
}

/**
 * 某件装备（含变体）的**穿戴等级门槛**；不是装备返回 null
 *
 * #655：变体行自带 `level`，运营改某一件的等级就只影响那一件（旧口径是
 * 「变体跟基础件走」，改基础件连带 15 个变体一起变）。表里没有才回落到基础件。
 */
export function equipmentLevelOf(id: string): number | null {
  const overridden = equipmentVariantRows?.get(id)?.level;
  if (overridden !== undefined) return overridden;
  const parsed = parseEquipmentVariantId(id);
  if (!parsed) return null;
  const base = (EQUIPMENT_BASES as Record<string, { level?: number }>)[parsed.baseKey];
  return base ? numberOr(base.level) : null;
}

/** 某级称号的当前属性（1 起；未激活传 0 / 负数 → null） */
export function titleAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(titleBundles, TITLE_LEVEL_ATTRIBUTES, level);
}

/** 某阶战魂的当前属性（1 起） */
export function soulAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(soulBundles, SOUL_LEVEL_ATTRIBUTES, level);
}

/** 某阶军衔的当前属性（1 起） */
export function rankAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(rankBundles, RANK_LEVEL_ATTRIBUTES, level);
}

/** 某个技能的当前配置（服务端结算读冷却 / 伤害系数 / 耗蓝） */
export function skillOf(id: string): AttributeBundle | null {
  return skillRows?.get(id) ?? (SKILLS as Record<string, AttributeBundle>)[id] ?? null;
}

/** 某个药品 / 材料的当前配置（背包叠加与用药上限；材料没有运营表，回落 `ITEM_BASES`） */
export function drugOf(id: string): AttributeBundle | null {
  return drugRows?.get(id) ?? (DRUGS as Record<string, AttributeBundle>)[id] ?? null;
}

/** 材料 / 其它物品的当前配置（运营改的是 `items` 表：叠加上限 + 卖价） */
export function itemBaseOf(id: string): AttributeBundle | null {
  return itemRows?.get(id) ?? (ITEM_BASES as Record<string, AttributeBundle>)[id] ?? null;
}

/**
 * 某个物品的**出售单价**（货币 = 绑定元宝/个）；`null` = 不可卖
 *
 * 卖价的三条来源，按「谁有裁决权」排序：
 * 1. 装备（含变体）→ `equipment_variants.sell_price`（#655 起逐行配置；以前是
 *    「等级基础价 × 前后缀倍率」现算，现在这一行直接就是到账价）；
 * 2. 药品 / 材料 → 各自表里的 `sell_price`（运营在管理端改的就是它）；
 * 3. 都没有 → 回落生成物 `SELL_PRICES`（出厂价签）；仍然没有 = `null` = 不可卖
 *    （任务物 / 关键道具就靠这条拦住，`SELL_NOT_SELLABLE`）。
 */
export function sellPriceOf(id: string): number | null {
  const equipment = equipmentVariantRows?.get(id)?.price;
  if (equipment !== undefined) return equipment;
  const drug = drugRows?.get(id);
  if (drug) return numberOr(drug.sellPrice);
  const item = itemRows?.get(id);
  if (item) return numberOr(item.sellPrice);
  const factory = (SELL_PRICES as Record<string, number>)[id];
  return factory === undefined ? null : numberOr(factory);
}

//#endregion

//#region 内部实现

function numberOr(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 装备变体 id → { 基础件, 前缀序号, 后缀序号 }
 *
 * 与客户端 `getEquipmentBaseKey` 同一口径：只有末尾的 `_pXsY` 是变体段，
 * 其余 id（基础件本身）就是 p=0 / s=0 的那一档。
 */
function parseEquipmentVariantId(id: string): { baseKey: string; prefix: number; suffix: number } | null {
  const match = id.match(/^(.*)_p(\d+)s(\d+)$/);
  if (!match) return { baseKey: id, prefix: 0, suffix: 0 };
  const baseKey = match[1];
  const prefix = Number(match[2]);
  const suffix = Number(match[3]);
  if (!baseKey || !Number.isFinite(prefix) || !Number.isFinite(suffix)) return null;
  return { baseKey, prefix, suffix };
}

function bundleMapOf(rows: LevelOverride[]): Map<number, AttributeBundle> {
  const map = new Map<number, AttributeBundle>();
  for (const row of rows) map.set(row.level, attributeBundleOf(row));
  return map;
}

/**
 * 按等级取属性包：覆盖层有该级就用它，否则回落生成物
 *
 * 生成物里这三张表的键是**下标**（等级 - 1），这里把「1 起」的转换收在一处 ——
 * 调用方只传等级，不重复那个容易写反的减一。
 */
function bundleAt(override: Map<number, AttributeBundle> | null, table: AttributeBundle, level: number | undefined): AttributeBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  const levelValue = Math.trunc(value);
  const fromOverride = override?.get(levelValue);
  if (fromOverride) return fromOverride;
  // #590 起三条成长线的属性表在各自的 seed 文件里，键 = 等级字符串（"1".."N"）
  const bundle = table[String(levelValue)];
  return bundle && typeof bundle === "object" ? (bundle as AttributeBundle) : null;
}

/** 伤害系数列是 JSON 字符串；解析失败当作「该技能没有系数」（结算会报 missing_coefficient） */
function parseDamageCoefficients(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

//#endregion
