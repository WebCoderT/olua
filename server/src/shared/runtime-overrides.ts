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
  DRUGS,
  EQUIPMENT_ATTRIBUTES,
  EQUIPMENT_BASES,
  EQUIPMENT_PREFIX_RATES,
  EQUIPMENT_RECYCLE_PRICES,
  EQUIPMENT_SUFFIX_RATES,
  ITEM_BASES,
  RANK_LEVEL_ATTRIBUTES,
  SELL_PRICES,
  SKILLS,
  SOUL_LEVEL_ATTRIBUTES,
  TITLE_LEVEL_ATTRIBUTES,
} from "./game-data.generated";

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

/** 装备基础件的一行（id + 等级 + 八项属性；部位 / 名称不参与结算，等级决定回收价） */
export interface EquipmentBaseOverride extends AttributeColumns {
  id: string;
  level: number;
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

let equipmentVariants: Map<string, AttributeBundle> | null = null;
let equipmentPrices: Map<string, number> | null = null;
/** 变体 id → 穿戴等级门槛（跟着基础件走；#556 起穿戴校验要读它） */
let equipmentLevels: Map<string, number> | null = null;
let titleBundles: Map<number, AttributeBundle> | null = null;
let soulBundles: Map<number, AttributeBundle> | null = null;
let rankBundles: Map<number, AttributeBundle> | null = null;
let skillRows: Map<string, AttributeBundle> | null = null;
let drugRows: Map<string, AttributeBundle> | null = null;
let itemRows: Map<string, AttributeBundle> | null = null;

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
 * 装进装备基础件的当前值，并按前后缀倍率**重算全部变体**
 *
 * 为什么按基础件重算而不是逐变体下发：库里只有基础件（37 行，运营改的就是它），
 * 555 个变体是「基础件 × 5 前缀 × 3 后缀」展开的结果，展开规则属代码不属运营数据。
 * 重算口径与客户端 `buildEquipmentMap` 完全一致（`Math.round(基础值 × 倍率)`），
 * 倍率取生成物的 `EQUIPMENT_PREFIX_RATES` / `EQUIPMENT_SUFFIX_RATES` —— 同一组数字。
 *
 * 变体 id 从**出厂表的键**解析（`cloth_1_p3s2` → 基础件 `cloth_1`、前缀 3、后缀 2），
 * 不给运维新造 id 的机会：基础件之外的 id 一律不认。
 *
 * 顺带把**回收价**一起算好（#545）：价 = 等级对应的基础价 × 同一组倍率，取整口径与客户端
 * `applyEquipmentRows` 里的 `Math.round(equipmentRecyclePrice(level) * rate)` 逐值相同。
 * 之所以价签也在这里算：运营改**等级**就改了价（等级既是穿戴门槛也是定价依据），
 * 而客户端的价格读的是自己即时算的曲线值，服务端若还按出厂价签付钱，就是「显示一个价、
 * 到账另一个价」。
 */
export function applyEquipmentOverrides(rows: EquipmentBaseOverride[]): void {
  if (!rows.length) {
    equipmentVariants = null;
    equipmentPrices = null;
    equipmentLevels = null;
    return;
  }
  const bases = new Map<string, { bundle: AttributeBundle; level: number }>();
  for (const row of rows) bases.set(row.id, { bundle: attributeBundleOf(row), level: numberOr(row.level) });

  const variants = new Map<string, AttributeBundle>();
  const prices = new Map<string, number>();
  const levels = new Map<string, number>();
  for (const id of Object.keys(EQUIPMENT_ATTRIBUTES)) {
    const parsed = parseEquipmentVariantId(id);
    const base = parsed ? bases.get(parsed.baseKey) : undefined;
    if (!parsed || !base) continue;
    const rate = rateOf(parsed.prefix, parsed.suffix);
    variants.set(id, scaleBundle(base.bundle, rate));
    prices.set(id, Math.round(recycleBasePriceOf(base.level) * rate));
    levels.set(id, base.level);
  }
  equipmentVariants = variants;
  equipmentPrices = prices;
  equipmentLevels = levels;
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

/** 清空全部覆盖（e2e 之间隔离用；生产只在进程启动时天然为空） */
export function resetRuntimeOverrides(): void {
  equipmentVariants = null;
  equipmentPrices = null;
  equipmentLevels = null;
  titleBundles = null;
  soulBundles = null;
  rankBundles = null;
  skillRows = null;
  drugRows = null;
  itemRows = null;
}

//#endregion

//#region 读取（结算链路的唯一入口：先覆盖层、再生成物）

/** 某件装备（含变体）的当前属性；查不到返回 null（调用方按"没穿"处理并记账） */
export function equipmentAttributesOf(id: string): AttributeBundle | null {
  return equipmentVariants?.get(id) ?? (EQUIPMENT_ATTRIBUTES as Record<string, AttributeBundle>)[id] ?? null;
}

/**
 * 某件装备（含变体）的**穿戴等级门槛**；不是装备返回 null
 *
 * 等级既是门槛，也是回收价的依据。运营在管理端把一件衣服从 16 级改到 22 级，
 * 客户端快照会跟着变（`apply-snapshot` 原地覆写），服务端的门槛若还读出厂的 16，
 * 就是「客户端不让穿、接口放过去」—— 所以这里与属性 / 价签走同一层覆盖。
 *
 * 变体（`cloth_1_p3s2`）没有自己的等级，跟着基础件走（与客户端 `buildEquipmentMap` 一致）。
 */
export function equipmentLevelOf(id: string): number | null {
  const overridden = equipmentLevels?.get(id);
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
 * 1. 装备（含变体）→ 回收价 = 等级基础价 × 前后缀倍率（覆盖层里已算好，见
 *    `applyEquipmentOverrides`）。**不看 `sell_price` 列** —— 客户端 `applyEquipmentRows`
 *    也是按等级曲线重算的，两边必须同一口径，否则「背包显示 400、到账 100」；
 * 2. 药品 / 材料 → 各自表里的 `sell_price`（运营在管理端改的就是它）；
 * 3. 都没有 → 回落生成物 `SELL_PRICES`（出厂价签）；仍然没有 = `null` = 不可卖
 *    （任务物 / 关键道具就靠这条拦住，`SELL_NOT_SELLABLE`）。
 */
export function sellPriceOf(id: string): number | null {
  const equipment = equipmentPrices?.get(id);
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

/** 前后缀倍率（越界按 1 处理 —— 与客户端 `equipmentPrefixRates.length > p ? ... : NORMAL` 同口径） */
function rateOf(prefix: number, suffix: number): number {
  const prefixRate = prefix < EQUIPMENT_PREFIX_RATES.length ? EQUIPMENT_PREFIX_RATES[prefix] : 1;
  const suffixRate = suffix < EQUIPMENT_SUFFIX_RATES.length ? EQUIPMENT_SUFFIX_RATES[suffix] : 1;
  return prefixRate * suffixRate;
}

/**
 * 某等级装备的回收基础价（普通·人级，含前后缀倍率之前）
 *
 * 生成物里存的是**采样值**（下标 = 等级 - 1），不是曲线公式 —— 两端读同一组数字，
 * 不存在「插值写法差一点」的可能。等级越界按端点夹紧（运营把等级改成 0 / 999 时不至于
 * 让价格变成 NaN 或 0：宁可给端点价，也不要「卖掉却没给钱」）。
 */
function recycleBasePriceOf(level: number): number {
  if (!EQUIPMENT_RECYCLE_PRICES.length) return 0;
  const index = Math.trunc(level) - 1;
  if (!Number.isFinite(index) || index < 0) return numberOr(EQUIPMENT_RECYCLE_PRICES[0]);
  if (index >= EQUIPMENT_RECYCLE_PRICES.length) return numberOr(EQUIPMENT_RECYCLE_PRICES[EQUIPMENT_RECYCLE_PRICES.length - 1]);
  return numberOr(EQUIPMENT_RECYCLE_PRICES[index]);
}

/** 按倍率缩放一份属性包（单值逐项乘、区间两端各乘，统一 Math.round） */
function scaleBundle(bundle: AttributeBundle, rate: number): AttributeBundle {
  const scaled: AttributeBundle = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (Array.isArray(value)) {
      scaled[key] = value.map((item) => Math.round(Number(item) * rate));
      continue;
    }
    scaled[key] = typeof value === "number" ? Math.round(value * rate) : value;
  }
  return scaled;
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
  const bundle = table[String(levelValue - 1)];
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
