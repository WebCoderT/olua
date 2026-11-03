/**
 * 运行时配置快照（#544 起叫「覆盖层」，#655 起它就是**唯一**的读取入口）
 *
 * ===========================================================================
 * 解决什么
 * ===========================================================================
 * 服务端结算（角色属性 / 技能 / 背包叠加 / 售卖）读的是「当前生效的配置」。
 * 配置的权威在数据库：管理端改一行，下一次结算就必须用新值 —— 否则玩家会看到
 * 「面板 20、实际按 10 算」，而且**没有任何报错**（只会被当成"数值算错了"）。
 *
 * 但结算链路是**纯函数**（`combat/role-attributes` 拿不到 Nest 的注入），所以这里放一份
 * 进程内的只读投影：启动时 + 管理端每次写操作之后由 `RuntimeConfigService.refreshAll()`
 * 重装；纯函数从 Map 里查。
 *
 * ===========================================================================
 * #655：不再有「回落生成物」这回事
 * ===========================================================================
 * 以前这里每个 getter 都是「先查覆盖层、没有就回落 `shared/*.generated` 的出厂值」。
 * 那套兜底的后果是：**运营删了一行，运行时照样有值**，于是「有没有配」在运行时看不出来，
 * 而且生成物是 `[min,max]` 元组、读方按 `{min,max}` 取 —— 兜底一触发就拿到 undefined
 * （属性变 NaN）。现在库里是唯一来源：表里没有就是 `null`，调用方按「没配」处理。
 *
 * 唯一还能算「兜底」的是 `combatWeightsOf()` 的**空表**情形：返回空对象 = 战力为 0，
 * 这比返回一份代码里的数字更诚实（空表就是没配，`refreshAll` 会 warn）。
 */

//#region 类型（DB 行的形状；只依赖结构化类型，不引 database 层）

/** 结算用的一份属性包：单值 + 六项区间元组（键是 camelCase，与客户端配置同形） */
export type AttributeBundle = Record<string, unknown>;

/**
 * 八项属性在**数据库行**里的扁平列形状
 *
 * 装备 / 称号 / 战魂 / 军衔四张表用的是同一组列（只多不少），所以一个接口够用。
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

/** 装备变体的一行（`equipment_variants` 表；555 行逐一配置） */
export interface EquipmentVariantSource extends AttributeColumns {
  id: string;
  base_id: string;
  prefix: number;
  suffix: number;
  label: string;
  level: number;
  sell_price: number;
}

/** 装备基础件的一行（`equipments` 表；只在变体行缺失时提供部位 / 等级兜底） */
export interface EquipmentBaseSource {
  id: string;
  slot: string;
  level: number;
  label: string;
}

/** 角色等级的一行（`role_levels` 表；60 行逐条配置） */
export interface RoleLevelSource extends AttributeColumns {
  level: number;
  exp: number;
  max_mp: number;
}

/** 物品 / 材料的一行（`items` 表：叠加上限与卖价参与结算） */
export interface ItemSource {
  id: string;
  type: string;
  label: string;
  description: string;
  level: number;
  sell_price: number;
  max_stack: number;
}

/** 称号 / 战魂 / 军衔的一行（level 是主键，1 起） */
export interface LevelSource extends AttributeColumns {
  level: number;
}

/** 技能行（服务端结算读冷却 / 伤害系数 / 耗蓝） */
export interface SkillSource {
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

/** 药品行（背包叠加 / 用药回复） */
export interface DrugSource {
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

//#endregion

//#region 存储（null = 还没装载）

/**
 * 装备变体：id → { 属性包, 穿戴等级, 回收价 }
 *
 * 三个值同进同出：它们在一行里，分开存三个 Map 只会让「装了属性忘了装价」这种
 * 半截状态成为可能。
 */
let equipmentVariantRows: Map<string, { bundle: AttributeBundle; level: number; price: number }> | null = null;
/** 装备基础件：id → { 部位, 等级, 名称 }（变体行缺失时兜底，也是「这件东西能穿哪儿」的来源） */
let equipmentBases: Map<string, { slot: string; level: number; label: string }> | null = null;
/** 角色等级：等级 → 属性包（含 maxMp） */
let roleLevelRows: Map<number, AttributeBundle> | null = null;
let titleBundles: Map<number, AttributeBundle> | null = null;
let soulBundles: Map<number, AttributeBundle> | null = null;
let rankBundles: Map<number, AttributeBundle> | null = null;
let skillRows: Map<string, Record<string, unknown>> | null = null;
let drugRows: Map<string, Record<string, unknown>> | null = null;
let itemRows: Map<string, Record<string, unknown>> | null = null;
/** 成长标量（`growth_scalars` 表：等级上限 / 属性区间比例 / 经验节奏 / 回蓝） */
let growthScalars: Map<string, number> | null = null;
/** 装备槽位键（`equipment_slots` 表：13 个部位，穿戴请求的 `slot` 只认这些） */
let equipmentSlotKeys: Set<string> | null = null;
/** 战斗力权重（`combat_weights` 表；null = 还没装载） */
let combatWeights: Record<string, number> | null = null;

//#endregion

//#region 写入（由 RuntimeConfigService / CombatWeightsService 调用）

/** 数据库纳秒级 timestamp 之类的空值统一转 0，避免 NaN 传染到属性里 */
function numberOr(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** DB 行 → 属性包（列 → 单值 / 元组） */
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
 * 装进角色等级（`role_levels` 表）
 *
 * 顺手把 `maxMp` 塞进属性包 —— 下游 `role-attributes` 就按「等级包 + 装备包 +
 * 三条成长线包」统一求和，不用给 maxMp 单开一条路径。
 */
export function applyRoleLevels(rows: RoleLevelSource[]): void {
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

/** 装进装备变体（`equipment_variants` 表；555 行）—— 不乘任何倍率，一行就是最终值 */
export function applyEquipmentVariants(rows: EquipmentVariantSource[]): void {
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

/** 装进装备基础件（`equipments` 表；部位校验与变体兜底用） */
export function applyEquipmentBases(rows: EquipmentBaseSource[]): void {
  if (!rows.length) {
    equipmentBases = null;
    return;
  }
  const map = new Map<string, { slot: string; level: number; label: string }>();
  for (const row of rows) {
    map.set(row.id, { slot: String(row.slot ?? ""), level: numberOr(row.level), label: String(row.label ?? "") });
  }
  equipmentBases = map;
}

/** 装进物品 / 材料（`items` 表：叠加上限、卖价、类型） */
export function applyItemOverrides(rows: ItemSource[]): void {
  if (!rows.length) {
    itemRows = null;
    return;
  }
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    map.set(row.id, {
      type: String(row.type ?? ""),
      label: row.label,
      description: row.description,
      level: numberOr(row.level),
      sellPrice: numberOr(row.sell_price),
      maxStack: numberOr(row.max_stack),
    });
  }
  itemRows = map;
}

/** 装进称号 / 战魂 / 军衔（键 = 等级，1 起） */
export function applyTitleOverrides(rows: LevelSource[]): void {
  titleBundles = rows.length ? bundleMapOf(rows) : null;
}

export function applySoulOverrides(rows: LevelSource[]): void {
  soulBundles = rows.length ? bundleMapOf(rows) : null;
}

export function applyRankOverrides(rows: LevelSource[]): void {
  rankBundles = rows.length ? bundleMapOf(rows) : null;
}

/** 装进技能（整行；结算读冷却 / 伤害系数 / 耗蓝 / 施法硬直） */
export function applySkillOverrides(rows: SkillSource[]): void {
  if (!rows.length) {
    skillRows = null;
    return;
  }
  const map = new Map<string, Record<string, unknown>>();
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

/** 装进药品（背包叠加 / 用药回复 / 出售价） */
export function applyDrugOverrides(rows: DrugSource[]): void {
  if (!rows.length) {
    drugRows = null;
    return;
  }
  const map = new Map<string, Record<string, unknown>>();
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

/** 装进成长标量（`growth_scalars` 表；空表 = 没配 → 读取方拿到 null） */
export function applyGrowthScalars(rows: Array<{ key: string; value: number }>): void {
  if (!rows.length) {
    growthScalars = null;
    return;
  }
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.key, numberOr(row.value));
  growthScalars = map;
}

/**
 * 装进战斗力权重（`combat_weights` 表）
 *
 * **只认调用方给的键集**（键集就是战斗力算法本身，来自 `combat_weights` 的行）：
 * 库里冒出未知键说明有人在手改数据，直接忽略比让它参与求和更安全（否则一个拼错的键
 * 会静默抬高所有人的战力）。非有限数字 / 负数同样忽略 → 记 0。
 */
export function applyCombatWeights(rows: Array<{ key: string; value: number }> | null): void {
  if (!rows || !rows.length) {
    combatWeights = null;
    return;
  }
  const next: Record<string, number> = {};
  for (const row of rows) {
    const value = Number(row.value);
    next[row.key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  combatWeights = next;
}

/** 装进装备槽位键（`equipment_slots` 表；穿戴请求的 `slot` 只认这些） */
export function applyEquipmentSlotKeys(rows: Array<{ key: string }>): void {
  equipmentSlotKeys = rows.length ? new Set(rows.map((row) => String(row.key))) : null;
}

/** 某个 `slot` 是不是一个真实部位（不是 → 穿戴请求直接拒） */
export function isEquipmentSlot(slot: string): boolean {
  return equipmentSlotKeys?.has(String(slot ?? "")) ?? false;
}

/** 清空全部投影（e2e 之间隔离用；生产只在进程启动时天然为空） */
export function resetRuntimeConfigCache(): void {
  equipmentVariantRows = null;
  equipmentBases = null;
  roleLevelRows = null;
  titleBundles = null;
  soulBundles = null;
  rankBundles = null;
  skillRows = null;
  drugRows = null;
  itemRows = null;
  growthScalars = null;
  equipmentSlotKeys = null;
  combatWeights = null;
}

//#endregion

//#region 读取（结算链路的唯一入口）

/**
 * 当前战斗力权重（**服务端算战力 / 地图准入门槛的唯一入口**）
 *
 * 运营在管理端「战斗力权重」页改完，下一次算属性就用新倍率 —— 客户端也从快照拿到
 * 同一组数字（`applyCombatWeights`），两端不会「面板显示 1200、服务端按 1000 判准入」。
 *
 * 返回空对象 = 表里没有行（没配）。这是**有意为之**：战力为 0 会立刻暴露问题，
 * 比悄悄用一份代码里的数字好（`refreshAll` 同时会 warn）。
 */
export function combatWeightsOf(): Record<string, number> {
  return combatWeights ?? {};
}

/** 成长标量；键不存在返回 null（调用方决定要不要报错 / 用 0） */
export function growthScalarOf(key: string): number | null {
  const value = growthScalars?.get(key);
  return value === undefined ? null : value;
}

/** 成长标量的整表（快照下发用，顺序不稳定 —— 调用方要排序时自己排） */
export function growthScalarsSnapshot(): Map<string, number> | null {
  return growthScalars;
}

/** 某等级的角色裸属性；表里没有该级返回 null（= 这一级没配） */
export function roleLevelAttributesOf(level: number | undefined): AttributeBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  return roleLevelRows?.get(Math.trunc(value)) ?? null;
}

/** 某件装备（含变体）的当前属性；不是装备 / 没配返回 null */
export function equipmentAttributesOf(id: string): AttributeBundle | null {
  return equipmentVariantRows?.get(id)?.bundle ?? null;
}

/**
 * 某件装备（含变体）的**穿戴等级门槛**；不是装备返回 null
 *
 * 变体行自带 `level`，所以改某一件只影响那一件；变体行缺失时回落到基础件
 * （基础件没配过变体 —— 只可能出现在数据被删了一半的库上）。
 */
export function equipmentLevelOf(id: string): number | null {
  const variant = equipmentVariantRows?.get(id)?.level;
  if (variant !== undefined) return variant;
  const baseId = baseKeyOf(id);
  const base = baseId === null ? undefined : equipmentBases?.get(baseId);
  return base ? base.level : null;
}

/**
 * 某件装备（含变体）的**部位**；不是装备返回 null
 *
 * 部位是结构（`equipments.slot`）：15 个变体与基础件必然同部位，所以只查基础件那一行 ——
 * 这也是「`cloth_1_p3s2` 能不能穿在衣服位」的判据。
 */
export function equipmentSlotOf(id: string): string | null {
  const baseId = baseKeyOf(id);
  if (baseId === null) return null;
  const slot = equipmentBases?.get(baseId)?.slot;
  return slot ? slot : null;
}

/** 某级称号的当前属性（1 起；未激活传 0 / 负数 → null） */
export function titleAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(titleBundles, level);
}

/** 某阶战魂的当前属性（1 起） */
export function soulAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(soulBundles, level);
}

/** 某阶军衔的当前属性（1 起） */
export function rankAttributesOf(level: number | undefined): AttributeBundle | null {
  return bundleAt(rankBundles, level);
}

/**
 * 玩家技能 id 清单（`skills.owner = 'role'`）
 *
 * 给「建号时全部解锁 1 级」用：技能等级是玩法数据不是物品，全 0 会让新角色无法战斗；
 * 怪物技能（`owner = 'monster'`）不在其中。以前这份清单是生成物的 `SKILL_LABELS` 键集，
 * 现在就是 `skills` 表按 owner 筛出来 —— 管理端加一个玩家技能，新号自动带上。
 */
export function playerSkillIds(): string[] {
  if (!skillRows) return [];
  const ids: string[] = [];
  for (const [id, row] of skillRows) {
    if (row.owner === "role") ids.push(id);
  }
  return ids.sort();
}

/** 某个技能的当前配置；没配返回 null（结算会报缺配置，而不是按 0 冷却放技能） */
export function skillOf(id: string): Record<string, unknown> | null {
  return skillRows?.get(id) ?? null;
}

/** 某个药品的当前配置；不是药品返回 null */
export function drugOf(id: string): Record<string, unknown> | null {
  return drugRows?.get(id) ?? null;
}

/** 材料 / 其它物品的当前配置；不是物品返回 null */
export function itemBaseOf(id: string): Record<string, unknown> | null {
  return itemRows?.get(id) ?? null;
}

/**
 * 物品类型：`equipment` / `drug` / `material` 等（`items.type` 的原值）；查不到返回 null
 *
 * 三张表各管一类：装备在 `equipment_variants`、药在 `drugs`、材料在 `items`。
 * 以前这是一张 571 行的 `ITEM_TYPES` 生成表 —— 那就是这三张表的投影，没必要单独存一份。
 */
export function itemTypeOf(id: string): string | null {
  if (equipmentVariantRows?.has(id) || equipmentBases?.has(id)) return "equipment";
  if (drugRows?.has(id)) return "drug";
  const item = itemRows?.get(id);
  return item ? String(item.type ?? "") || null : null;
}

/** 物品是否存在（任务目标 / 奖励里配的 id 校验用） */
export function itemExists(id: string): boolean {
  return itemTypeOf(id) !== null;
}

/** 物品显示名（装备 / 药品 / 材料）；查不到返回 null */
export function itemLabelOf(id: string): string | null {
  const equipment = equipmentVariantRows?.get(id)?.bundle?.label;
  if (typeof equipment === "string") return equipment;
  const base = equipmentBases?.get(baseKeyOf(id) ?? "")?.label;
  if (base) return base;
  const drug = drugRows?.get(id)?.label;
  if (typeof drug === "string") return drug;
  const item = itemRows?.get(id)?.label;
  return typeof item === "string" ? item : null;
}

/**
 * 某个物品的**出售单价**（货币 = 绑定元宝/个）；`null` = 不可卖
 *
 * 三条来源，按「谁有裁决权」排序：
 * 1. 装备（含变体）→ `equipment_variants.sell_price`（这一行直接就是到账价）；
 * 2. 药品 / 材料 → 各自表里的 `sell_price`；
 * 3. 都没有 = 不可卖（任务物 / 关键道具就靠这条拦住，`SELL_NOT_SELLABLE`）。
 */
export function sellPriceOf(id: string): number | null {
  const equipment = equipmentVariantRows?.get(id)?.price;
  if (equipment !== undefined) return equipment;
  const drug = drugRows?.get(id)?.sellPrice;
  if (drug !== undefined) return numberOr(drug);
  const item = itemRows?.get(id)?.sellPrice;
  if (item !== undefined) return numberOr(item);
  return null;
}

//#endregion

//#region 内部实现

/**
 * 装备 id → 基础件 id（剥掉 `_pXsY`）
 *
 * 与客户端 `getEquipmentBaseKey` 同一口径：只有末尾的 `_pXsY` 是变体段，
 * 其余 id（基础件本身）就是 p=0 / s=0 的那一档。
 */
function baseKeyOf(id: string): string | null {
  const match = String(id ?? "").match(/^(.*)_p\d+s\d+$/);
  if (!match) return id ? String(id) : null;
  return match[1] ? match[1] : null;
}

function bundleMapOf(rows: LevelSource[]): Map<number, AttributeBundle> {
  const map = new Map<number, AttributeBundle>();
  for (const row of rows) map.set(numberOr(row.level), attributeBundleOf(row));
  return map;
}

/** 按等级取属性包：等级是 1 起的整数，非数字 / 0 / 负数一律 null */
function bundleAt(table: Map<number, AttributeBundle> | null, level: number | undefined): AttributeBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  return table?.get(Math.trunc(value)) ?? null;
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
