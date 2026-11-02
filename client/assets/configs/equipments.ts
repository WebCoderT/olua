import { Color, Vec2 } from "cc";
import {
  Equipment,
  EQUIPMENT_PREFIX,
  EQUIPMENT_SUFFIX,
  EQUIPMENT_TYPE,
  EquipmentData,
  EquipmentSlot,
  GOOD_TYPE,
} from "../types/good";
import type { BattleAttributes } from "../types/common";
import { equipmentPrefixRates, equipmentRecyclePrice, equipmentSuffixRates } from "./growth";
import { combatCalc as combatCalcWeights } from "./battle";

/**
 * 装备配置（#603 第九域：**客户端不存任何装备数据**）
 *
 * 这个文件以前有 1381 行，其中 1080 行是 7 个 `*Data` 数组 —— 37 件基础件的名称 / 描述 /
 * 图标 / 图集 / 职业性别 / 标签 / 内观锚点 / 外观 8 向位置，全部写死在源码里，改一个图标
 * 要重新打包。现在它们全部搬到服务端（`equipment-seed.ts` → `equipments` 表，管理端可改），
 * 进游戏由 `GET /game-config` 的快照 `equipments` 段下发，`applyEquipmentData` 整表重建。
 *
 * **这个文件现在只剩三类东西**：
 * 1. **空运行时表**：`clothes` / `weapons` / … / `equipmentSlots` / `equipmentSlotOrder`
 *    —— 快照没到时它们是空的（客户端没有本地兜底，`CONFIG-DATA.md` 里有说明）；
 * 2. **纯函数**：变体 id 拼解、属性倍率缩放、战斗力、回收价、属性对比；
 * 3. **装载入口**：`applyEquipmentData` / `applyEquipmentSlots` / `applyEquipmentQualityLabels`。
 *
 * 展开规则（每件基础件 = 5 前缀 × 3 后缀 = 15 个变体）**属代码不属运营数据**，留在这里 ——
 * 服务端生成物 `EQUIPMENT_ATTRIBUTES` 用同一套规则展开，判据是「重新生成逐字节不变」。
 */

/** 七张部位表的统一访问口（整表重建时一起清） */
const PART_MAPS: Map<EQUIPMENT_TYPE, Map<string, Equipment>> = new Map();

/** 装备槽位（槽位 → 槽位配置）：快照 `equipmentSlots` 到达后由 applyEquipmentSlots 填 */
export const equipmentSlots = new Map<EQUIPMENT_TYPE, EquipmentSlot>();

/**
 * 装备部位的整理序号（背包「一键整理」排部位用，见 configs/items 的 compareBagGoods）
 *
 * **唯一来源**：不另写一份部位顺序 —— 序号就是服务端槽位表的 `order`（`equipment_slots.sort_order`），
 * 改槽位顺序时装备界面的槽位排列与背包整理顺序一起生效。
 */
export const equipmentSlotOrder = new Map<EQUIPMENT_TYPE, number>();

/** 装备前缀文案（下标 = EQUIPMENT_PREFIX 序号）；快照 `equipmentMeta.prefixLabels` 到达后填 */
export let equipmentPrefixLabels: string[] = [];

/** 装备后缀文案（下标 = EQUIPMENT_SUFFIX 序号）；快照 `equipmentMeta.suffixLabels` 到达后填 */
export let equipmentSuffixLabels: string[] = [];

/**
 * 装备前缀文字颜色（与文案同下标）：名称与前缀文字都用该色渲染
 *
 * **颜色留在客户端**（不像文案那样上移）：它是渲染主题色（`Color` 对象），
 * 没有任何服务端消费者，改色属于「调 UI 观感」而不是「调数据」。
 */
export const equipmentPrefixColors = [
  new Color("#DDDDDD"), // 普通的：灰白
  new Color("#6EE86E"), // 强化的：绿
  new Color("#4DA6FF"), // 精良的：蓝
  new Color("#C77DFF"), // 极品的：紫
  new Color("#FFA640"), // 超神的：橙
];

/** 装备后缀文字颜色（与文案同下标；只用于后缀文字，不影响名称） */
export const equipmentSuffixColors = [
  new Color("#B0B0B0"), // 人级：灰
  new Color("#4DE3FF"), // 天级：青蓝
  new Color("#FFD700"), // 神级：金
];

/** 装备名称三段式（详情弹窗按段着色显示：前缀/名称用前缀色，后缀用后缀色） */
export interface EquipmentNameParts {
  /** 前缀段（label + 颜色 = 前缀色） */
  prefix: { label: string; color: Color };
  /** 名称段（颜色 = 前缀色） */
  label: string;
  /** 后缀段（label + 颜色 = 后缀色） */
  suffix: { label: string; color: Color };
}

/**
 * 拆装备名称三段（前缀文案、名称、后缀文案 + 各自颜色）
 *
 * 越界前后缀回退到第一档（普通的 / 人级）：快照还没到时 `equipmentPrefixLabels` 是空数组，
 * 这时 `undefined` 会直接落到名称里 —— 回退比显示 `undefined` 好。
 */
export function getEquipmentNameParts(equipment: Equipment): EquipmentNameParts {
  const prefix = equipmentPrefixRates.length > equipment.prefix ? equipment.prefix : EQUIPMENT_PREFIX.NORMAL;
  const suffix = equipmentSuffixRates.length > equipment.suffix ? equipment.suffix : EQUIPMENT_SUFFIX.MORTAL;
  return {
    prefix: { label: equipmentPrefixLabels[prefix] ?? "", color: equipmentPrefixColors[prefix] ?? equipmentPrefixColors[0] },
    label: equipment.label,
    suffix: { label: equipmentSuffixLabels[suffix] ?? "", color: equipmentSuffixColors[suffix] ?? equipmentSuffixColors[0] },
  };
}

/**
 * 按前后缀倍率缩放战斗属性（六项攻防区间、maxHp 与每秒回血逐项相乘后取整）
 *
 * 导出是给配置快照覆写用的（#363）：管理端只改**基础件**（普通的·人级）的属性，
 * 15 个变体要按同一套倍率重算 —— 复算口径必须与 `buildEquipmentMap` 完全一致，
 * 所以两边共用这一个函数，而不是各写一份。
 */
export function scaleEquipmentAttributes(attributes: BattleAttributes, rate: number): BattleAttributes {
  const scale = (range: [number, number]): [number, number] => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return {
    maxHp: Math.round(attributes.maxHp * rate),
    // 回血与血量同一口径缩放：超神·神级的防具回血也是普通·人级的 4.2 倍
    hpRecover: Math.round(attributes.hpRecover * rate),
    physicalAttack: scale(attributes.physicalAttack),
    magicAttack: scale(attributes.magicAttack),
    taoistAttack: scale(attributes.taoistAttack),
    physicalDefense: scale(attributes.physicalDefense),
    magicDefense: scale(attributes.magicDefense),
    taoistDefense: scale(attributes.taoistDefense),
  };
}

/**
 * 拼装备变体的物品 id（基础件 key + 前后缀序号；变体 key 的**唯一来源**，反解见 getEquipmentBaseKey）
 * 基础件（普通的·人级，前后缀全 0）沿用原 key，其余组合为 `${key}_p${前缀}s${后缀}`（如 cloth_1_p3s2）
 */
export function getEquipmentVariantKey(key: string, prefix: number, suffix: number): string {
  return prefix === 0 && suffix === 0 ? key : `${key}_p${prefix}s${suffix}`;
}

/**
 * 取装备 id 的基础件 key（`getEquipmentVariantKey` 的反解：去掉末尾的 `_pXsY` 变体段，非变体原样返回）
 * 用途：给「某件装备的全部变体」做统一配置时按基础件 key 命中（如 configs/border 的自定义边框表）
 */
export function getEquipmentBaseKey(id: string): string {
  const match = id.match(/_(p\d+s\d+)$/);
  // 掐掉的是整段命中（含前面的下划线），不是捕获组 —— 否则会留下一个悬挂的下划线
  return match ? id.slice(0, -match[0].length) : id;
}

/**
 * 装备的**零值属性基线**
 *
 * 变体在展开时以「服务端下发的基础件属性」为底（见 `applyEquipmentData`），
 * 这个零值只在「某件装备缺属性字段」时兜底 —— 不是「加载期占位」了，
 * 因为加载期根本没有装备（数据在服务端）。
 */
const ZERO_EQUIPMENT_ATTRIBUTES: BattleAttributes = {
  maxHp: 0,
  hpRecover: 0,
  physicalAttack: [0, 0],
  magicAttack: [0, 0],
  taoistAttack: [0, 0],
  physicalDefense: [0, 0],
  magicDefense: [0, 0],
  taoistDefense: [0, 0],
};

/**
 * 装备数据表 → 装备配置 Map
 *
 * **key 只做关联**：背包 / 掉落表 / 掉落拾取入包都用它引用，
 * key 可以是任意字符串（"ring_1"、"cloth_fire" 都行），**不参与任何数值计算**。
 *
 * **前后缀变体**：每件基础装备展开成全部「前缀 × 后缀」组合（5 × 3 = 15 件）：
 * - 「普通的·人级」沿用基础装备的原 key（基础件本身，倍率 1 × 1）
 * - 其余组合 key 为 `${key}_p${前缀序号}s${后缀序号}`（如 cloth_1_p3s2）
 *
 * **倍率来自快照**（`configs/growth` 的 `equipmentPrefixRates` / `equipmentSuffixRates`）：
 * 空数组 = 快照没到 = 一件都展开不出来，这是有意的（不兜本地倍率）。
 *
 * **回收价**按倍率缩放：基础价 = 条目的 recyclePrice（写了才用）或按 level 从
 * 回收价曲线取（曲线也来自快照），变体乘同一个 rate（超神·神级 = 基础价 × 4.2）。
 *
 * 注意：等级同时是「穿戴门槛」（GameHelper.getEquipmentRejectReason 会挡「需要等级 N」），
 * 变体与基础件同 level，门槛一致；所以排等级时要想清楚这件装备应该在什么等级被拿到。
 */
export function buildEquipmentMap(data: EquipmentData[]): Map<string, Equipment> {
  const map = new Map<string, Equipment>();
  for (const entry of data) {
    const { key, ...rest } = entry; // key 只做关联，不写进最终配置对象
    // 结构基线（零值兜底）+ 条目覆盖（属性就是服务端下发的基础件属性），变体在其上乘前后缀倍率
    const base = { ...ZERO_EQUIPMENT_ATTRIBUTES, ...rest } as unknown as Equipment;
    // 回收基础价（普通·人级的价）：条目里写了就用它，否则按等级从回收价曲线取（见 configs/growth）
    const baseRecyclePrice = entry.recyclePrice ?? equipmentRecyclePrice(rest.level);
    for (let p = 0; p < equipmentPrefixRates.length; p++) {
      for (let s = 0; s < equipmentSuffixRates.length; s++) {
        const rate = equipmentPrefixRates[p] * equipmentSuffixRates[s];
        const id = getEquipmentVariantKey(key, p, s);
        map.set(id, {
          ...base,
          ...scaleEquipmentAttributes(base, rate),
          // 回收价与战斗属性同一口径：前后缀越强越值钱（超神·神级 = 基础价 × 4.2）
          recyclePrice: Math.round(baseRecyclePrice * rate),
          prefix: p as EQUIPMENT_PREFIX,
          suffix: s as EQUIPMENT_SUFFIX,
        });
      }
    }
  }
  return map;
}

/**
 * 取某件装备的回收价（货币 = **绑定元宝**；背包「一键回收」按它结算，见 StorageManager.recycleBagEquipments）
 * 取值已在 buildEquipmentMap 里算好（等级曲线 × 前后缀倍率），这里只做兜底规整
 */
export function getRecyclePrice(equipment: Equipment | null | undefined): number {
  if (!equipment) return 0;
  return Math.max(0, Math.round(equipment.recyclePrice ?? 0));
}

/**
 * 装备的战斗力贡献（**纯函数**，角色信息弹窗「更好装备」提示的判定口径，见 configs/items.findBagEquipmentUpgrade）
 *
 * 权重表 configs/battle.combatCalc（与服务端生成物 COMBAT_WEIGHTS 同源）：
 * 区间型属性取上下限之和、maxHp 取单值、hpRecover 不计（回血不算战斗力，口径两边必须一致，
 * 否则「提示说更好」与「穿上后战斗力变高」会对不上）。权重表改这里跟着变，没有第二份倍率。
 */
export function equipmentCombatValue(equipment: Equipment): number {
  let total = 0;
  combatCalcWeights.forEach((weight, key) => {
    if (key === "maxHp") {
      total += equipment.maxHp * weight;
      return;
    }
    // 除 maxHp 外都是区间型属性（BattleAttributes 里 maxHp/hpRecover 是单值，其余六项是 [下限, 上限]）
    const range = equipment[key] as [number, number];
    total += (range[0] + range[1]) * weight;
  });
  return total;
}

/** 装备单条属性的对比结果（候选件 vs 身上穿戴件） */
export interface EquipmentAttributeDiff {
  /** 属性 key（configs/good.goodShowAttributesLabel 给显示名） */
  key: keyof BattleAttributes;
  /** 穿戴件的属性值（区间或单值） */
  worn: number[] | number;
  /** 候选件的属性值（区间或单值） */
  value: number[] | number;
  /** 差值（候选 − 穿戴；区间逐端相减，着色与「±」格式化都用它） */
  delta: number[] | number;
}

/**
 * 两件装备的属性逐项对比（**纯函数**，背包悬停详情「按住 Ctrl 对比」的数据源）
 *
 * 对比哪些属性由调用方按槽位传入（configs/good.goodShowAttributes 的顺序即显示顺序），
 * 这里只负责逐项算「候选 − 穿戴」的差值：区间属性逐端相减，单值属性直接相减。
 *
 * @param keys 要对比的属性 key（按显示顺序）
 * @param candidate 候选装备（背包里悬停的那件）
 * @param worn 身上穿戴的装备（同槽位；不存在时调用方不该发起对比）
 */
export function equipmentAttributeDiffs(keys: (keyof BattleAttributes)[], candidate: Equipment, worn: Equipment): EquipmentAttributeDiff[] {
  return keys.map((key) => {
    const cand = candidate[key];
    const old = worn[key];
    const delta = typeof cand === "number" || typeof old === "number" ? (cand as number) - (old as number) : [cand[0] - old[0], cand[1] - old[1]];
    return { key, worn: old as number[] | number, value: cand as number[] | number, delta };
  });
}

/**
 * 差值的带符号格式化（**纯函数**）：正数带「+」，0 与负数原样（负号自带）；
 * 区间逐端加号，两端相同只显示一个数（与 formatAttributeValue 的省略口径一致）
 */
export function formatSignedAttributeValue(value: number[] | number): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  if (typeof value === "number") return signed(value);
  return value[0] === value[1] ? signed(value[0]) : `${signed(value[0])} / ${signed(value[1])}`;
}

/**
 * 取某装备 Map 的基础件（普通的·人级，prefix/suffix 全 0）
 * 新手装备、全量列表展示等只应给基础件——Map 里其余 14 个是前后缀变体（key 带 _pXsY），不该默认发放
 *
 * ⚠️ 这里必须用 `map.forEach`（或 Array.from）而**不能**写 `[...map.values()]`：
 * 打包时 babel 以 loose 模式编译，会把 `[...迭代器]` 降级成 `[].concat(迭代器)`，
 * 而 `concat` 只展开数组、不认 Map/Set 迭代器 → 结果是 `[MapIterator]` 这一个元素，
 * 过滤后恒为空数组（编辑器里不降级，所以只在打包产物上才复现，症状 = 背包/列表静默为空）
 */
export function getBaseEquipments(map: Map<string, Equipment>): Equipment[] {
  const result: Equipment[] = [];
  map.forEach((eq) => {
    if (eq.prefix === EQUIPMENT_PREFIX.NORMAL && eq.suffix === EQUIPMENT_SUFFIX.MORTAL) result.push(eq);
  });
  return result;
}

/**
 * 取某装备 Map 中**指定等级**的全部条目（含前后缀变体：一件基础装备 = 15 件同等级变体）
 *
 * 用途：把某等级的整组品质变体都取出来（#597 前的建号赠品用过它；
 * 现在作为「按等级筛全部变体」的通用查询保留）。
 * 「等级」是装备的佩戴门槛，也是唯一的定强入口，因此这里按等级筛而不是按 key 筛。
 *
 * ⚠️ 同样必须用 `map.forEach`，理由见 getBaseEquipments（loose 编译会毁掉 `[...map.values()]`）
 */
export function getEquipmentsByLevel(map: Map<string, Equipment>, level: number): Equipment[] {
  const result: Equipment[] = [];
  map.forEach((eq) => {
    if (eq.level === level) result.push(eq);
  });
  return result;
}

//#region 部位表（空壳：快照到达后由 applyEquipmentData 整表重建）

/** 衣服 */
export const clothes = new Map<string, Equipment>();
/** 武器 */
export const weapons = new Map<string, Equipment>();
/** 戒指 */
export const rings = new Map<string, Equipment>();
/** 项链 */
export const nicklaces = new Map<string, Equipment>();
/** 鞋子 */
export const shoes = new Map<string, Equipment>();
/** 头盔 */
export const helmets = new Map<string, Equipment>();
/** 腰带 */
export const belts = new Map<string, Equipment>();

PART_MAPS.set(EQUIPMENT_TYPE.CLOTH, clothes);
PART_MAPS.set(EQUIPMENT_TYPE.WEAPON, weapons);
PART_MAPS.set(EQUIPMENT_TYPE.RING, rings);
PART_MAPS.set(EQUIPMENT_TYPE.NECKLACE, nicklaces);
PART_MAPS.set(EQUIPMENT_TYPE.SHOES, shoes);
PART_MAPS.set(EQUIPMENT_TYPE.HELMET, helmets);
PART_MAPS.set(EQUIPMENT_TYPE.BELT, belts);

/**
 * 各部位装备表（掉落按部位就近取件用）
 *
 * 与七张具名表不同的是，它**按服务端下发的 slot 动态分组**：将来某个部位（如饰品 / 护腿）
 * 开始有装备时，不需要在客户端补一张具名表，`getNearestEquipmentId` 也能直接用。
 * 快照到达时整份重建（`rebuildEquipmentBySlot`）。
 */
export let equipmentBySlot = new Map<EQUIPMENT_TYPE, Map<string, Equipment>>();

/**
 * 按等级就近取一件装备的物品 id（怪物掉落分档用）
 * 规则：该部位里 level ≤ 指定等级中等级最高的那件；全都超纲时取等级最低的
 * @param slot 装备部位
 * @param level 目标等级（一般传怪物等级）
 * @returns 物品 id；该部位没有任何装备返回 null
 */
export function getNearestEquipmentId(slot: EQUIPMENT_TYPE, level: number): string | null {
  const map = equipmentBySlot.get(slot);
  if (!map) return null;
  let best: string | null = null;
  let bestLevel = -1;
  let fallback: string | null = null;
  let fallbackLevel = Infinity;
  map.forEach((item, id) => {
    if (item.level <= level && item.level > bestLevel) {
      best = id;
      bestLevel = item.level;
    }
    if (item.level < fallbackLevel) {
      fallback = id;
      fallbackLevel = item.level;
    }
  });
  return best ?? fallback;
}

//#endregion

//#region 装载入口（#603 第九域：客户端不再存装备数据，全部来自配置快照）

/**
 * 装载槽位表（快照 `equipmentSlots` 段；**整表重建**）
 *
 * 客户端不再有槽位清单：13 个 key、名称、底图、位置分组、排序全部来自服务端。
 * `equipmentSlotOrder` 直接用服务端给的 `order`（背包整理序与角色弹窗排列序同一份）。
 */
export function applyEquipmentSlots(
  rows: Array<{ key: string; label: string; imageSrc: string; position: string; order: number }>,
): void {
  if (!rows.length) return;
  equipmentSlots.clear();
  equipmentSlotOrder.clear();
  const ordered = rows.slice().sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  ordered.forEach((row) => {
    const key = row.key as EQUIPMENT_TYPE;
    equipmentSlots.set(key, {
      label: row.label,
      imageSrc: row.imageSrc,
      position: (row.position as EquipmentSlot["position"]) ?? "bottom",
    });
    equipmentSlotOrder.set(key, row.order ?? equipmentSlotOrder.size);
  });
}

/** 装载品质文案（快照 `equipmentMeta.prefixLabels` / `suffixLabels`；颜色仍按同下标取本地常量） */
export function applyEquipmentQualityLabels(prefixLabels: string[], suffixLabels: string[]): void {
  if (prefixLabels?.length) equipmentPrefixLabels = prefixLabels.map(String);
  if (suffixLabels?.length) equipmentSuffixLabels = suffixLabels.map(String);
}

/**
 * 装载装备（快照 `equipments` 段；**整表重建**）
 *
 * 入参是**基础件条目**（服务端下发的 37 件，属性是「普通的·人级」），客户端按
 * 「前缀 × 后缀」展开成 555 条变体。流程与以前的加载期建表**完全一致**
 * （`buildEquipmentMap` 同一个函数），只是数据来源从源码常量换成了快照。
 *
 * 行 → 条目的转换在 `configs/apply-snapshot` 里做（那里已经有 DTO 类型与区间对象转换），
 * 本文件不 import `ApiModels` —— 生成器要能在没有 UI 层的 Node 环境里编译 `configs/items`
 * 这条链，把网络模型引进来会把整条 UI 依赖拖进生成器。
 *
 * 必须整表重建而不是逐条覆写：客户端已经没有本地装备了，快照里少一件就得真少一件
 * （逐条覆写会让「管理端删掉/改名的装备」在客户端残留）。
 *
 * ⚠️ 调用顺序有讲究：**倍率（`configs/growth`）必须先装**，否则 `buildEquipmentMap`
 * 展开档数为 0，装备表整个是空的。`applyConfigSnapshot` 里已经排好了。
 *
 * @returns 展开后的全部变体（调用方拿去灌物品总表 —— 那里是「id → 物品」的全局索引）
 */
export function applyEquipmentData(data: EquipmentData[]): Equipment[] {
  if (!data.length) return [];
  PART_MAPS.forEach((map) => map.clear());
  const variants = buildEquipmentMap(data);
  // 按 slot 重建「部位 → 变体」索引：七张具名表收自己那一份，其它部位（将来新增的）也在索引里 ——
  // 这样 `getNearestEquipmentId` 不会因为「没写具名表」而看不到新部位的装备
  const bySlot = new Map<EQUIPMENT_TYPE, Map<string, Equipment>>();
  const all: Equipment[] = [];
  variants.forEach((item, id) => {
    // 变体 id 就是物品 id（物品总表要按它索引；buildEquipmentMap 里 key 被剥掉了）
    item.id = id;
    let bucket = bySlot.get(item.slot);
    if (!bucket) {
      bucket = new Map<string, Equipment>();
      bySlot.set(item.slot, bucket);
    }
    bucket.set(id, item);
    PART_MAPS.get(item.slot)?.set(id, item);
    all.push(item);
  });
  equipmentBySlot = bySlot;
  return all;
}

/**
 * 服务端装备种子的行形状（`server/src/shared/equipment-seed.ts` 的 `EquipmentSeedRow`）
 *
 * 与那边**同形但不 import**（客户端不能依赖服务端源码，服务端也不能依赖客户端）——
 * 这是一份「客户端读种子时需要的字段」的声明，判据是两端字段名一致。
 * 只有工具链会用它：`tools/gen-shared-data.cjs`（生成物）与
 * `client/tools/lib/configs-sandbox.cjs`（配置层单测沙箱）都要在 Node 里把种子摊开成 555 条。
 */
export interface EquipmentSeedRowLike {
  id: string;
  slot: string;
  level: number;
  label: string;
  sellPrice: number;
  description: string;
  occupation: string;
  sex: string;
  icon: string;
  in: string;
  out: string;
  tags: string[];
  inPosition: { x: number; y: number };
  inScaleX: number;
  inScaleY: number;
  inRotate?: number;
  outScale: number;
  outPositions: Array<{ x: number; y: number }>;
}

/**
 * 装载**服务端种子行**（工具链用；游戏内走 `applyEquipmentData`，入参是快照 DTO）
 *
 * 只做三件事：`id` → `key`、`sellPrice` → `sellPirce`（客户端历史拼写）、平面点 → `Vec2`，
 * 然后交给 `applyEquipmentData` 展开。**所以展开规则仍然只有一份** ——
 * 生成器的 555 条与线上客户端的 555 条是同一个函数算出来的，不可能漂移。
 *
 * 种子行**不带八项属性**（属性由 `growth-seed.equipmentStats(level, slot)` 公式算，见 #590），
 * 所以展开出来的变体属性是 0：生成器用公式现算，测试沙箱随后也重算一遍，谁都不读这个 0。
 */
export function applyEquipmentSeed(rows: EquipmentSeedRowLike[]): Equipment[] {
  if (!rows.length) return [];
  return applyEquipmentData(
    rows.map((row) => ({
      key: row.id,
      type: GOOD_TYPE.EQUIPMENT,
      label: row.label,
      description: row.description,
      sellPirce: row.sellPrice,
      level: row.level,
      slot: row.slot as EQUIPMENT_TYPE,
      occupation: row.occupation as Equipment["occupation"],
      sex: row.sex as Equipment["sex"],
      icon: row.icon,
      in: row.in,
      out: row.out,
      tags: row.tags,
      inPosition: new Vec2(row.inPosition.x, row.inPosition.y),
      inScaleX: row.inScaleX,
      inScaleY: row.inScaleY,
      inRotate: row.inRotate,
      outScale: row.outScale,
      outPositions: row.outPositions.map((point) => new Vec2(point.x, point.y)),
    })),
  );
}

//#endregion
