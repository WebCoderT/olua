import { BagCell, BagCellPos, BagOrigin, DrugEffect, Equipment, EQUIPMENT_TYPE, GOOD_TYPE, Goods, isEquipment, MoneyCurrency, WornItem } from "../types/good";
import { drugs, levelScrolls, moneyItems } from "./game-config";
import { equipmentCombatValue, equipmentSlotOrder, getAllEquipmentVariants, getMallGoods, getRecyclePrice } from "./equipments";
import { materials } from "./game-config";

/**
 * 物品总表：物品 id -> 物品数据
 *
 * 掉落、任务、商店、背包/装备槽存档等一律按物品 id 引用物品 —— 这是全局唯一的
 * 「id → 物品」索引。**加载期是空表**：#603 第九 / 十域起，装备来自服务端 equipments 表、
 * 药品来自 drugs 表、材料来自 items 表，三者进游戏后由 `configs/apply-snapshot` 落库,
 * 再由 `rebuildItemIndex()` 一次性登记进本表。所以进游戏前 `items` 里什么都查不到，
 * 这不是 bug（消费方都在进游戏之后才读）。
 */
export const items = new Map<string, Goods>();

/** 注册单个物品（id 为空或已存在时不覆盖） */
export function registerItem(id: string, good: Goods) {
  if (!id || items.has(id)) return;
  good.id = id;
  items.set(id, good);
}

/** 批量注册物品：未显式指定 id 时按 prefix_序号 生成（序号从 1 开始） */
export function registerItems(list: Goods[], prefix: string) {
  list.forEach((good, index) => registerItem(good.id ?? `${prefix}_${index + 1}`, good));
}

/**
 * 重建物品总表（#603 第十域；#785 起多一张货币道具表）：**装备 → 药品 → 货币 → 材料**，
 * 整表清空后按这个顺序登记
 *
 * 顺序有语义：`getItemsByType` 的注释写的就是「注册顺序 = 装备 → 药品 → 材料」,
 * 图鉴 / 商店 / 背包整理都按这个顺序呈现；顺序变了列表会悄悄换个排法。
 *
 * 三处调用：`applyConfigSnapshot`（进游戏落库后一次）、单测沙箱的 `hydrateSnapshotTables`、
 * 以及任何「只改了其中一张表」的地方 —— 用同一个函数重建，别各写一份遍历。
 */
export function rebuildItemIndex(): void {
  items.clear();
  // 装备：**全部位**（getAllEquipmentVariants 读 equipmentBySlot —— 13 个部位的变体都在里面）。
  // 别改成遍历 clothes / weapons / … 七张具名表：那只是 7 个部位的部分视图，#777 起
  // wristband / necklace / accessories 等部位也有装备了，按具名表收集会让它们整批缺席
  // 物品总表（症状：背包格空白、回收单测件数对不上，且不报错）
  getAllEquipmentVariants().forEach((good) => {
    if (good.id) items.set(good.id, good);
  });
  registerItems(drugs, "drug");
  // #785：货币道具（绑定元宝 / 元宝 / 银子）—— 与药品同属「可使用的消耗品」，
  // 但走的是账本链路（useMoneyItem），不是血蓝
  registerItems(moneyItems, "money");
  // #787：升级卷轴（硬性 +1 级，带等级区间）—— 也是「可使用的消耗品」，
  // 走的是等级链路（useLevelScroll），不是血蓝也不是账本
  registerItems(levelScrolls, "level_scroll");
  registerItems(materials, "material");
}

/**
 * 商城可售清单（#763）：装备 + 药品，按**陈列顺序**返回
 *
 * · 装备在前：部位序 → 等级 → 前缀 → 后缀（`getMallGoods` 排好的）；
 * · 药品在后：等级 → id。
 *
 * **不混排**：药品没有部位，混排会让「武器」和「金创药」交替出现，找东西全靠翻页。
 * 合并放在本文件而不是 `configs/equipments`：装备与药品在这里都已经 import
 * （`rebuildItemIndex` 同源），而 equipments 里再 import `drugs` 会多一条
 * equipments → game-config 的边（那里的注释写着成环风险）。
 *
 * 调用方（`ui/components/dialogs/MallDialog`）再按服务端上架清单过滤一次。
 */
export function getSellableGoods(): Goods[] {
  const result: Goods[] = getMallGoods();
  drugs
    .slice()
    .sort((a, b) => {
      const byLevel = a.level - b.level;
      if (byLevel !== 0) return byLevel;
      const left = a.id ?? "";
      const right = b.id ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .forEach((drug) => result.push(drug));
  return result;
}

/**
 * 按药品效果与角色资源上限计算一次使用的回复量（**纯函数**，给 useDrug 与单测共用）
 *
 * 固定值（hp/mp）与百分比（hpPercent/mpPercent，50 = 50%）各自累加后合成：
 * · 血量分量 = Σhp + ΣhpPercent ÷ 100 × maxHp
 * · 魔法分量 = Σmp + ΣmpPercent ÷ 100 × maxMp
 * 返回的是「未封顶」的期望回复量，够不满的资源回满即可，调用方负责 Math.min 封顶；
 * 负值与缺省一律按 0 处理（配置写错不会倒扣血蓝）
 */
export function resolveDrugRecovery(
  effects: DrugEffect[],
  maxHp: number,
  maxMp: number,
): { hp: number; mp: number } {
  let hp = 0;
  let mp = 0;
  effects.forEach((effect) => {
    hp += Math.max(0, effect.hp ?? 0) + (Math.max(0, effect.hpPercent ?? 0) / 100) * Math.max(0, maxHp);
    mp += Math.max(0, effect.mp ?? 0) + (Math.max(0, effect.mpPercent ?? 0) / 100) * Math.max(0, maxMp);
  });
  return { hp: Math.round(hp), mp: Math.round(mp) };
}

/**
 * 货币的中文名（提示文案 / 图鉴用）
 *
 * 与角色存档的账本字段同名（收敛后只有 bindGold），服务端 `MONEY_KIND_LABELS`
 * 是同一份文案 —— 客户端只用来显示，金额与币种的实际结算在服务端。
 */
export const MONEY_CURRENCY_LABELS: Record<MoneyCurrency, string> = {
  bindGold: "绑定元宝",
};

/** 按 id 获取物品（返回副本，避免运行时数量等数据污染配置表；无此物品返回 null） */
export function getItem(id: string): Goods | null {
  const item = items.get(id);
  return item ? { ...item } : null;
}

/** 按 id 获取装备（角色装备槽只存 id，显示/属性一律经此实时解析；非装备或无此物品返回 null） */
export function getEquipment(id: string | null | undefined): Equipment | null {
  if (!id) return null;
  const item = getItem(id);
  return item && isEquipment(item) ? item : null;
}

/**
 * 按物品大类取出全部物品（返回副本，顺序 = 注册顺序：装备 → 药品 → 材料）
 *
 * 只按大类筛，不带任何界面口径 —— 需要「某部位/某等级」之类的细分由调用方再筛。
 */
export function getItemsByType(type: GOOD_TYPE): Goods[] {
  const list: Goods[] = [];
  items.forEach((item) => {
    if (item.type === type) list.push({ ...item });
  });
  return list;
}

//#region 背包整理（一键整理的排序规则，见 StorageManager.tidyBag）

/**
 * 一键整理的大类先后（数组为源 + 尾部建 Map）：装备在最前（换装最关心），其后药品、材料、其他
 * 新增物品大类时在此补一项；没登记的大类统一排到最后（不是丢物品，只是排在末尾）
 */
const bagTidyTypeOrderData: GOOD_TYPE[] = [
  GOOD_TYPE.EQUIPMENT,
  GOOD_TYPE.DRUG,
  GOOD_TYPE.MONEY,
  GOOD_TYPE.SCROLL,
  GOOD_TYPE.MATERIAL,
  GOOD_TYPE.OTHER,
];

/** 物品大类 → 整理序号（小的排前面；未登记的大类排到最后） */
export const bagTidyTypeOrder = new Map<GOOD_TYPE, number>();
bagTidyTypeOrderData.forEach((type, index) => bagTidyTypeOrder.set(type, index));

/** 取整理序号（未登记的键排到最后；缺省值保证任何物品都有确定位置，排序结果可复现） */
function getTidyOrder<K>(order: Map<K, number>, key: K): number {
  const index = order.get(key);
  return index === undefined ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * 背包整理的排序比较器（纯函数，给 Array.sort 用；不读配置表之外的状态）
 *
 * 排序键（从主到次）：
 * 1. 大类：装备 → 药品 → 货币 → 材料 → 其他（见 bagTidyTypeOrder）
 * 2. 装备：等级**降序**（高级在前）→ 部位顺序（见 configs/equipments.equipmentSlotOrder）
 *    → 前缀降序（超神→普通）→ 后缀降序（神级→人级）
 * 3. 非装备（药品/材料）：等级降序
 * 4. id 兜底：同种物品必然相邻，且结果与输入顺序无关（可复现）
 *
 * 想换排序口味（比如等级升序）改这里的比较方向即可，整理的具体搬运逻辑在数据层
 */
export function compareBagGoods(a: Goods, b: Goods): number {
  const typeDiff = getTidyOrder(bagTidyTypeOrder, a.type) - getTidyOrder(bagTidyTypeOrder, b.type);
  if (typeDiff) return typeDiff;
  if (isEquipment(a) && isEquipment(b)) {
    if (a.level !== b.level) return b.level - a.level;
    const slotDiff = getTidyOrder<EQUIPMENT_TYPE>(equipmentSlotOrder, a.slot) - getTidyOrder<EQUIPMENT_TYPE>(equipmentSlotOrder, b.slot);
    if (slotDiff) return slotDiff;
    if (a.prefix !== b.prefix) return b.prefix - a.prefix;
    if (a.suffix !== b.suffix) return b.suffix - a.suffix;
  } else if (a.level !== b.level) {
    return b.level - a.level;
  }
  const aId = a.id ?? "";
  const bId = b.id ?? "";
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

//#region 背包格子的元数据（绑定 + 掉落溯源，#789）

/** 背包格子上的元数据（服务端写、客户端只读；搬运/整理/回收时原样带回） */
export interface BagCellMeta {
  /** 绑定角色 = 不可交易 */
  bound?: boolean;
  /** 掉落溯源（只有装备会有） */
  from?: BagOrigin;
}

/**
 * 取一格的元数据**副本**
 *
 * 复制 `from` 而不是把引用带走：整理/搬运会造新格子，若新格子与旧格子共用同一个
 * `from` 对象，改一处两处都变（以后做交易时「转移后清空来源」会互相干扰）。
 * `bound` 只认 `true`（存档里出现过 `false` / `1` 这类脏值，一律当未绑定）。
 *
 * 参数只要求「有 bound / from 两个可选字段」：背包格子（`BagCell`）与装备槽位
 * （`WornItem`，#816）都满足 —— 穿脱就是这两种形状之间搬运，元数据口径只该有一份。
 */
export function bagMetaOf(cell: { bound?: boolean; from?: BagOrigin } | null): BagCellMeta {
  const meta: BagCellMeta = {};
  if (!cell) return meta;
  if (cell.bound === true) meta.bound = true;
  const from = cell.from;
  if (from) {
    const copy: BagOrigin = {};
    if (from.role) copy.role = from.role;
    if (from.monster) copy.monster = from.monster;
    if (typeof from.at === "number") copy.at = from.at;
    if (copy.role || copy.monster || typeof copy.at === "number") meta.from = copy;
  }
  return meta;
}

/** 造一个带元数据的格子（元数据为空时不写字段：存档里不多出 `bound: undefined` 这种键） */
export function withBagMeta(id: string, count: number, meta: BagCellMeta): BagCell {
  const cell: BagCell = { id, count };
  if (meta.bound === true) cell.bound = true;
  if (meta.from) cell.from = meta.from;
  return cell;
}

/**
 * 并堆的判据用的分组键：`1|id` / `0|id`
 *
 * **绑定状态不同不能并成一堆**（#789）：绑定的那堆是「不可交易」的，未绑定的可以交易，
 * 混在一起就分不开了。服务端的守恒校验按同一个键分组（`bagGroupKeyOf`），
 * 两边键不同步的话，一次整理就会被当成「绑定物凭空消失」而拒绝。
 */
export function bagGroupKeyOf(cell: BagCell): string {
  return `${cell && cell.bound === true ? 1 : 0}|${cell ? cell.id : ""}`;
}

//#endregion

//#region 装备槽位的存法（#816：槽位存 { id, bound?, from? }）

/**
 * 槽位里的装备 id（空槽 / 形状不对 → null）
 *
 * **兼容裸字符串**：老存档（#816 之前）与远端玩家的互见帧都还是「槽位 → id」这一种形状
 * （`PlayerAppearance` 里就是空串 / id），读的地方不该为此各写一个 if。
 * 空串与空白串按「没穿」处理 —— 服务端历史上用空串表示空槽。
 */
export function wornIdOf(entry: WornItem | string | null | undefined): string | null {
  if (!entry) return null;
  const raw = typeof entry === "string" ? entry : entry.id;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id ? id : null;
}

/**
 * 把存档里的一个槽位值规整成 `WornItem | null`（读档 / 迁移用）
 *
 * 认三种输入：
 * - `null` / `undefined` / 空串 → 空槽（服务端历史上用空串表示空槽）；
 * - 裸 id 字符串（#816 之前的存档）；
 * - `{ id, bound?, from? }`（当前形态）；
 * - 更早的存档（#597 之前）存的是**完整物品快照对象**，它也有 `id`，落在同一条分支上 ——
 *   快照里没有绑定/溯源（那时候还没有这两个字段），于是当未绑定处理。
 *
 * 元数据一律走 `bagMetaOf` 复制（`from` 不共用引用），理由与背包格子完全相同。
 */
export function wornItemOf(raw: unknown): WornItem | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { id?: unknown; bound?: unknown; from?: BagOrigin };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  return { id, ...bagMetaOf({ bound: record.bound === true, from: record.from }) };
}

//#endregion

/**
 * 一键整理的搬运（**纯函数**：不碰存档、不碰 UI，输入输出都是二维背包，便于单测）
 *
 * 三步：
 * 1. 合并：同 id **且绑定状态相同**的可叠加物品并成一堆，超过 maxStack 再拆成多格；
 *    不可叠加物品一格一件（绑定与溯源原样带走，见 #789）
 * 2. 排序：见 compareBagGoods（装备按等级/部位/前后缀，其余按等级，id 兜底）
 * 3. 铺回：从左上角起按行铺满，空格全部沉到末尾
 *
 * 不变量（单测要盯的）：行列数与入参一致、物品一件不丢（**按「绑定态 + id」分组**数量守恒）、
 * 解析不出配置的 id 原样保留并排在最后；返回全新数组，不改入参
 *
 * 「绑定态 + id 分组」是 #789 加的：绑定堆与未绑定堆互换位置本身是合法整理，但若允许
 * 它们**并成一堆**，就等于凭空送出一件可交易的（或把可交易的锁死）—— 服务端守恒校验
 * 按同一个分组键算，两边不同步就会把一次普通整理判成作弊。
 */
export function tidyBagGrid(bag: BagCell[][]): BagCell[][] {
  // 展平：背包只有 bagRow × bagCol 格，线性扫描即可
  // （不用 [...迭代器] 展开——打包 loose 编译会把它降级成 concat，结果会失真）
  const cells: BagCell[] = [];
  bag.forEach((row) =>
    row.forEach((cell) => {
      if (cell) cells.push(cell);
    }),
  );

  // 1) 合并：同 id 且同绑定态的可叠加物品并进同一堆（都换新格子对象，不动原数组里的引用）
  const merged: BagCell[] = [];
  const stackTargets = new Map<string, BagCell>();
  cells.forEach((cell) => {
    const good = getItem(cell.id);
    if (!good) {
      // 配置表里已不存在的 id：不认识它，就不能替它决定数量，原样保留（元数据也原样带走）
      merged.push(withBagMeta(cell.id, Math.max(1, cell.count), bagMetaOf(cell)));
      return;
    }
    if (!good.stackable) {
      // 不可叠加（装备）：一格一件，数量恒 1；绑定与溯源跟着格子走
      merged.push(withBagMeta(cell.id, 1, bagMetaOf(cell)));
      return;
    }
    const key = bagGroupKeyOf(cell);
    let target = stackTargets.get(key);
    if (!target) {
      target = withBagMeta(cell.id, 0, bagMetaOf(cell));
      stackTargets.set(key, target);
      merged.push(target);
    }
    target.count += Math.max(1, cell.count);
  });

  // 2) 拆堆：超过单格上限的可叠加物品拆成多格（不可叠加物品每格 1 件）
  const packed: BagCell[] = [];
  merged.forEach((cell) => {
    const good = getItem(cell.id);
    // 解析不出配置的物品（已下架）：不知道它能不能叠加、上限多少 —— 原样一格，不能替它拆
    if (!good) {
      packed.push(withBagMeta(cell.id, cell.count, bagMetaOf(cell)));
      return;
    }
    const maxStack = good.stackable ? Math.max(1, good.maxStack ?? 99) : 1;
    let remain = cell.count;
    while (remain > 0) {
      const take = Math.min(maxStack, remain);
      // 拆出来的每一堆都带着同一份元数据副本（绑定态与溯源属于「这件/这堆物品」）
      packed.push(withBagMeta(cell.id, take, bagMetaOf(cell)));
      remain -= take;
    }
  });


  // 3) 排序：逐个 id 解析一次配置（getItem 返回副本，缓存起来免得比较里反复拷贝）
  const goodCache = new Map<string, Goods | null>();
  const goodOf = (id: string) => {
    let good = goodCache.get(id);
    if (good === undefined) {
      good = getItem(id);
      goodCache.set(id, good);
    }
    return good;
  };
  packed.sort((a, b) => {
    const ga = goodOf(a.id);
    const gb = goodOf(b.id);
    // 解析不出配置的物品（已下架）排在最后，认识的物品按整理规则排
    if (!ga || !gb) {
      if (ga) return -1;
      if (gb) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return compareBagGoods(ga, gb);
  });

  // 4) 铺回：从左上角按行铺满，剩余格子清空（行列数保持与入参一致）
  const capacity = bag.reduce((sum, row) => sum + row.length, 0);
  if (packed.length > capacity) {
    // 合并只会省格子，理论上不会超容量；真出现就原样返回，绝不因为整理丢物品
    console.warn("背包整理：整理后格数超过容量，已放弃整理", packed.length, capacity);
    return bag.map((row) => row.slice());
  }
  const result: BagCell[][] = [];
  let index = 0;
  bag.forEach((row) => {
    const line: BagCell[] = [];
    row.forEach(() => {
      line.push(index < packed.length ? packed[index++] : null);
    });
    result.push(line);
  });
  return result;
}

//#endregion

//#region 背包格子搬运（拖动改变物品所在格子，见 StorageManager.moveBagGood）

/** 一次搬运的结果 */
export interface BagMoveResult {
  /** 搬运后的背包（新数组，不改入参；没搬动时是与入参同形的浅拷贝） */
  bag: BagCell[][];
  /** 是否真的动了物品（起点为空、起终点是同一格、越界时为 false） */
  moved: boolean;
}

/** 取背包某格（越界返回 undefined，与「空格 null」区分开） */
function getBagCell(bag: BagCell[][], pos: BagCellPos): BagCell | null | undefined {
  return bag[pos.row]?.[pos.col];
}

/** 单种可叠加物品的单格上限（maxStack 缺省 99；不可叠加物品没有「上限」概念，返回 0） */
export function getStackLimit(good: Goods): number {
  if (!good || !good.stackable) return 0;
  return Math.max(1, good.maxStack ?? 99);
}

/**
 * 两格能否合并（同 id 且配置里可叠加）→ 返回单格上限；不能合并返回 0
 * 认不出的 id（配置表里已下架）一律不能合并：不知道它的叠加规则，就不能替它算数量
 */
function getMergeMaxStack(aId: string, bId: string): number {
  if (aId !== bId) return 0;
  const good = getItem(aId);
  return good ? getStackLimit(good) : 0;
}

/** 背包格子的「叠加数量角标」内容（null = 不画） */
export interface StackBadge {
  /** 角标文字（当前数量） */
  text: string;
  /** 是否满叠（数量达到单格上限，渲染层据此换色提示「这堆到顶了」） */
  full: boolean;
}

/**
 * 背包格子右下角的「叠加数量角标」该画什么（**纯函数**，渲染在 GameUiHelper.createGood）
 *
 * · 不可叠加（装备等，`stackable` 缺省即不可叠加 —— 「可叠加」的唯一来源就是配置字段，
 *   不靠「数量大于 1」反推）或数量 ≤ 1 → null（一件就是一件，画个 1 是噪音）；
 * · 可叠加且数量 > 1 → 当前数量；数量达到单格上限时 full = true。
 *
 * @param good 物品配置（背包格子只存 id，调用方负责用 getItem 解析；解析不出传 null）
 * @param count 格子里的数量（缺省按 1 算）
 */
export function getStackBadge(good: Goods | null, count: number | undefined): StackBadge | null {
  if (!good || !good.stackable) return null;
  const safeCount = Math.max(1, count ?? 1);
  if (safeCount <= 1) return null;
  return { text: String(safeCount), full: safeCount >= getStackLimit(good) };
}

/**
 * 把一格物品搬到另一格（**纯函数**：不碰存档、不碰 UI，输入输出都是二维背包，便于单测）
 *
 * 落点规则（按这个顺序判）：
 * 1. 起点没东西 / 起终点是同一格 / 越界 → 什么都不动（moved = false）；
 * 2. 落点是空格 → **整格搬过去**（数量与绑定/溯源元数据一起搬）；
 * 3. 落点是同种**可叠加**且**绑定态相同**的物品 → **合并**：按单格上限 maxStack 吃，
 *    吃不完的留在原格（部分合并）；
 * 4. 其余情况（不同种物品 / 绑定态不同 / 装备这类不可叠加 / 配置表里认不出的 id）→ **两格交换**。
 *
 * 绑定态不同不许合并（#789）：绑定的那堆不可交易、未绑定的可以，混成一堆就再也分不开了。
 * 交换是安全的 —— 两堆各自整体换位置，绑定态跟着格子走，谁也没被洗白或锁死。
 *
 * 不变量（单测要盯的）：物品一件不丢（按「绑定态 + id」分组数量守恒）；除「起点、落点」两格外，
 * 其余格子一律不动；恒返回新数组，不改入参里的格子对象
 */
export function moveBagCellGrid(bag: BagCell[][], from: BagCellPos, to: BagCellPos): BagMoveResult {
  const result = bag.map((row) => row.slice());
  if (from.row === to.row && from.col === to.col) return { bag: result, moved: false };
  const source = getBagCell(bag, from);
  const target = getBagCell(bag, to);
  // 起点为空、或落点越界：没得搬
  if (!source || target === undefined) return { bag: result, moved: false };

  // 2) 落点是空格：整格搬过去（元数据跟着走，否则一挪就「解绑」了）
  if (!target) {
    result[to.row][to.col] = withBagMeta(source.id, Math.max(1, source.count), bagMetaOf(source));
    result[from.row][from.col] = null;
    return { bag: result, moved: true };
  }

  // 3) 落点是同种可叠加物：合并（超过单格上限的部分留在原格）
  const sameBound = (source.bound === true) === (target.bound === true);
  const maxStack = sameBound ? getMergeMaxStack(source.id, target.id) : 0;
  if (maxStack > 0) {
    const total = Math.max(1, source.count) + Math.max(1, target.count);
    const merged = Math.min(maxStack, total);
    // 并堆后留在落点的这堆沿用落点格的元数据（同绑定态；可叠加物没有溯源）
    result[to.row][to.col] = withBagMeta(target.id, merged, bagMetaOf(target));
    result[from.row][from.col] = total > merged ? withBagMeta(source.id, total - merged, bagMetaOf(source)) : null;
    return { bag: result, moved: true };
  }

  // 4) 其余情况：两格交换（元数据各自跟着自己的格子换位置）
  result[from.row][from.col] = withBagMeta(target.id, Math.max(1, target.count), bagMetaOf(target));
  result[to.row][to.col] = withBagMeta(source.id, Math.max(1, source.count), bagMetaOf(source));
  return { bag: result, moved: true };
}

/** 背包里更优装备的命中格（格子坐标 + 解析出的装备本体） */
export interface BagEquipmentUpgrade {
  /** 背包行 */
  row: number;
  /** 背包列 */
  col: number;
  /** 更优装备（已按配置表解析） */
  equipment: Equipment;
}

/**
 * 在背包里找某槽位「更好的装备」（**纯函数**，角色信息弹窗的提示角标与一键替换共用这一个判定）
 *
 * 口径：
 * - 只看同槽位的装备；解析不出配置的格子跳过；
 * - 是否可穿（等级/性别/职业）由调用方注入 canUse 判定 —— 配置层不认识角色；
 * - 「更好」= 战斗力贡献（configs/equipments.equipmentCombatValue，与战斗力同一张权重表）
 *   **严格大于**当前穿戴件（相同不提示，避免无意义换装）；
 *   槽位为空（worn 传 null）时任何可穿的同槽位装备都算提升；
 * - 多件都更好时取战斗力贡献最高的一件（并列取先扫到的，背包行优先）。
 *
 * @param bag 背包格子（{ id, count }，物品数据实时解析）
 * @param slot 装备槽位
 * @param canUse 角色可穿判定（GameHelper.checkRoleCanUseEquipment 的注入点）
 * @param worn 当前穿戴件（未穿戴传 null）
 */
export function findBagEquipmentUpgrade(
  bag: BagCell[][],
  slot: EQUIPMENT_TYPE,
  canUse: (equipment: Equipment) => boolean,
  worn: Equipment | null,
): BagEquipmentUpgrade | null {
  let best: BagEquipmentUpgrade | null = null;
  let bestValue = worn ? equipmentCombatValue(worn) : -1;
  for (let row = 0; row < bag.length; row++) {
    const cells = bag[row] ?? [];
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (!cell) continue;
      const good = getItem(cell.id);
      if (!good || !isEquipment(good) || good.slot !== slot) continue;
      if (!canUse(good)) continue;
      const value = equipmentCombatValue(good);
      if (value > bestValue) {
        bestValue = value;
        best = { row, col, equipment: good };
      }
    }
  }
  return best;
}

/**
 * 背包网格尺寸对齐（旧存档兼容）：按当前配置的 rows × cols 补齐/裁掉
 *
 * 背包在存档里是二维数组，尺寸跟着 configs/role 的 bagRow / bagCol 走。早期版本行列数不同时，
 * 整理与拖动都会按存档自己的尺寸铺回，而界面格子是按当前配置生成的 —— 两边对不上就会出现
 * 「物品铺进界面没有的格子」（看着像丢了）或某一行读不到数据的错位。
 * 所以读档后统一对齐一次：不足的补空格；多余的行/列裁掉并留一条可查日志（正常存档走不到裁剪）
 */
export function normalizeBagGrid(bag: BagCell[][], rows: number, cols: number): BagCell[][] {
  const source: BagCell[][] = Array.isArray(bag) ? bag : [];
  const result: BagCell[][] = [];
  let dropped = 0;
  for (let row = 0; row < rows; row++) {
    const sourceLine = Array.isArray(source[row]) ? source[row] : [];
    const line: BagCell[] = [];
    for (let col = 0; col < cols; col++) {
      const cell = sourceLine[col];
      // 只认有 id 的格子（初值缺失的脏数据当空格，数量至少 1）；
      // 绑定与溯源照抄（#789：读档对齐不该顺手把绑定物洗成可交易的）
      line.push(cell && cell.id ? withBagMeta(cell.id, Math.max(1, cell.count ?? 1), bagMetaOf(cell)) : null);
    }
    for (let col = cols; col < sourceLine.length; col++) if (sourceLine[col]) dropped += 1;
    result.push(line);
  }
  for (let row = rows; row < source.length; row++) {
    const line = source[row];
    if (!Array.isArray(line)) continue;
    line.forEach((cell) => {
      if (cell) dropped += 1;
    });
  }
  if (dropped > 0) console.warn(`[items] 背包尺寸与当前配置不符（应为 ${rows}×${cols}），已裁掉 ${dropped} 格超出范围的物品`);
  return result;
}

//#endregion

//#region 背包回收（结算在服务端 #397：这里只做「卖什么 + 预览价」，见 StorageManager.recycleBagEquipments）

/** 背包回收的结算（件数 + 合计价，货币 = 绑定元宝） */
export interface BagRecycleSettlement {
  /** 可回收的装备件数 */
  count: number;
  /** 回收可得绑定元宝合计 */
  totalPrice: number;
}

/**
 * 一键回收的搬运（**纯函数**：不碰存档、不碰 UI，输入输出都是二维背包，便于单测）
 *
 * 把背包里的**装备**整格取走，其余物品一概不动：
 * · 药品/材料：原样留在原格（回收只针对装备，见需求「一键回收背包内所有装备」）
 * · 解析不出配置的 id（已下架）：不认识它，就不替它决定，原样保留
 *
 * 计价：逐格按 getRecyclePrice 累加；装备本不可叠加（count 恒 1），
 * 但这里仍按 count 计价（万一存档里出现叠着的装备，宁可多给钱，也不白拿走玩家的东西）。
 *
 * 不变量（单测要盯的）：行列数与入参一致、非装备一件不动、件数与合计价只由装备贡献、
 * 返回全新数组不改入参；对同一个背包重复调用，第二次必为空结算（幂等）
 */
export function recycleBagEquipmentGrid(bag: BagCell[][]): BagRecycleSettlement & { bag: BagCell[][] } {
  let count = 0;
  let totalPrice = 0;
  const result: BagCell[][] = [];
  bag.forEach((row) => {
    const line: BagCell[] = [];
    row.forEach((cell) => {
      const good = cell ? getItem(cell.id) : null;
      if (!cell || !good || !isEquipment(good)) {
        // 非装备 / 空 / 解析不出配置的 id：原样保留（引用与位置都不变）
        line.push(cell ?? null);
        return;
      }
      const pieces = Math.max(1, cell.count);
      count += pieces;
      totalPrice += getRecyclePrice(good) * pieces;
      line.push(null);
    });
    result.push(line);
  });
  return { bag: result, count, totalPrice };
}

/**
 * 回收前先看数（件数 + 合计价）：直接走一遍搬运、把新背包丢掉
 *
 * 刻意复用同一个函数而不是另写一份扫描 —— 判定与计价只有一处实现。
 * **注意预览不是结算**（#397）：真正扣物与入账由服务端 `role.sellGoods` 做，价签读共享快照；
 * 这里只保证「按钮上看到的件数与价钱」与要报给服务端的清单同源，两边不会各算一套。
 */
export function summarizeBagRecycle(bag: BagCell[][]): BagRecycleSettlement {
  const { count, totalPrice } = recycleBagEquipmentGrid(bag);
  return { count, totalPrice };
}

//#endregion
