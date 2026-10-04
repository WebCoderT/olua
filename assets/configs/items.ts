import { BagCell, BagCellPos, Equipment, EQUIPMENT_TYPE, GOOD_TYPE, Goods, isEquipment } from "../types/good";
import { drugs } from "./drug";
import { belts, clothes, equipmentSlotOrder, getRecyclePrice, helmets, nicklaces, rings, shoes, weapons } from "./equipments";
import { materials } from "./material";

/**
 * 物品总表：物品 id -> 物品数据
 * 掉落、任务、商店、背包/装备槽存档等一律按物品 id 引用物品。
 * 装备的各配置列表是 Map，key 即物品 id（cloth_1 / weapon_2 …），顺序与增删互不影响。
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

// 装备（列表是 Map，key 即物品 id）
clothes.forEach((good, id) => registerItem(id, good));
weapons.forEach((good, id) => registerItem(id, good));
rings.forEach((good, id) => registerItem(id, good));
nicklaces.forEach((good, id) => registerItem(id, good));
shoes.forEach((good, id) => registerItem(id, good));
helmets.forEach((good, id) => registerItem(id, good));
belts.forEach((good, id) => registerItem(id, good));
// 药品
registerItems(drugs, "drug");
// 材料
registerItems(materials, "material");

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

/** 按物品大类获取全部物品 */
export function getItemsByType(type: GOOD_TYPE): Goods[] {
  const result: Goods[] = [];
  items.forEach((item) => {
    if (item.type === type) result.push(item);
  });
  return result;
}

//#region 背包整理（一键整理的排序规则，见 StorageManager.tidyBag）

/**
 * 一键整理的大类先后（数组为源 + 尾部建 Map）：装备在最前（换装最关心），其后药品、材料、其他
 * 新增物品大类时在此补一项；没登记的大类统一排到最后（不是丢物品，只是排在末尾）
 */
const bagTidyTypeOrderData: GOOD_TYPE[] = [GOOD_TYPE.EQUIPMENT, GOOD_TYPE.DRUG, GOOD_TYPE.MATERIAL, GOOD_TYPE.OTHER];

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
 * 1. 大类：装备 → 药品 → 材料 → 其他（见 bagTidyTypeOrder）
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

/**
 * 一键整理的搬运（**纯函数**：不碰存档、不碰 UI，输入输出都是二维背包，便于单测）
 *
 * 三步：
 * 1. 合并：同 id 的可叠加物品并成一堆，超过 maxStack 再拆成多格；不可叠加物品一格一件
 * 2. 排序：见 compareBagGoods（装备按等级/部位/前后缀，其余按等级，id 兜底）
 * 3. 铺回：从左上角起按行铺满，空格全部沉到末尾
 *
 * 不变量（单测要盯的）：行列数与入参一致、物品一件不丢（数量总和守恒）、
 * 解析不出配置的 id 原样保留并排在最后；返回全新数组，不改入参
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

  // 1) 合并：同 id 的可叠加物品并进同一堆（都换新格子对象，不动原数组里的引用）
  const merged: BagCell[] = [];
  const stackTargets = new Map<string, BagCell>();
  cells.forEach((cell) => {
    const good = getItem(cell.id);
    if (!good) {
      // 配置表里已不存在的 id：不认识它，就不能替它决定数量，原样保留
      merged.push({ id: cell.id, count: Math.max(1, cell.count) });
      return;
    }
    if (!good.stackable) {
      // 不可叠加（装备）：一格一件，数量恒 1
      merged.push({ id: cell.id, count: 1 });
      return;
    }
    let target = stackTargets.get(cell.id);
    if (!target) {
      target = { id: cell.id, count: 0 };
      stackTargets.set(cell.id, target);
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
      packed.push({ id: cell.id, count: cell.count });
      return;
    }
    const maxStack = good.stackable ? Math.max(1, good.maxStack ?? 99) : 1;
    let remain = cell.count;
    while (remain > 0) {
      const take = Math.min(maxStack, remain);
      packed.push({ id: cell.id, count: take });
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

/**
 * 两格能否合并（同 id 且配置里可叠加）→ 返回单格上限；不能合并返回 0
 * 认不出的 id（配置表里已下架）一律不能合并：不知道它的叠加规则，就不能替它算数量
 */
function getMergeMaxStack(aId: string, bId: string): number {
  if (aId !== bId) return 0;
  const good = getItem(aId);
  if (!good || !good.stackable) return 0;
  return Math.max(1, good.maxStack ?? 99);
}

/**
 * 把一格物品搬到另一格（**纯函数**：不碰存档、不碰 UI，输入输出都是二维背包，便于单测）
 *
 * 落点规则（按这个顺序判）：
 * 1. 起点没东西 / 起终点是同一格 / 越界 → 什么都不动（moved = false）；
 * 2. 落点是空格 → **整格搬过去**（数量不变）；
 * 3. 落点是同种**可叠加**物品 → **合并**：按单格上限 maxStack 吃，吃不完的留在原格（部分合并）；
 * 4. 其余情况（不同种物品 / 装备这类不可叠加 / 配置表里认不出的 id）→ **两格交换**。
 *
 * 不变量（单测要盯的）：物品一件不丢（按 id 汇总数量守恒）；除「起点、落点」两格外，
 * 其余格子一律不动；恒返回新数组，不改入参里的格子对象
 */
export function moveBagCellGrid(bag: BagCell[][], from: BagCellPos, to: BagCellPos): BagMoveResult {
  const result = bag.map((row) => row.slice());
  if (from.row === to.row && from.col === to.col) return { bag: result, moved: false };
  const source = getBagCell(bag, from);
  const target = getBagCell(bag, to);
  // 起点为空、或落点越界：没得搬
  if (!source || target === undefined) return { bag: result, moved: false };

  // 2) 落点是空格：整格搬过去
  if (!target) {
    result[to.row][to.col] = { id: source.id, count: Math.max(1, source.count) };
    result[from.row][from.col] = null;
    return { bag: result, moved: true };
  }

  // 3) 落点是同种可叠加物：合并（超过单格上限的部分留在原格）
  const maxStack = getMergeMaxStack(source.id, target.id);
  if (maxStack > 0) {
    const total = Math.max(1, source.count) + Math.max(1, target.count);
    const merged = Math.min(maxStack, total);
    result[to.row][to.col] = { id: target.id, count: merged };
    result[from.row][from.col] = total > merged ? { id: source.id, count: total - merged } : null;
    return { bag: result, moved: true };
  }

  // 4) 其余情况：两格交换
  result[from.row][from.col] = { id: target.id, count: Math.max(1, target.count) };
  result[to.row][to.col] = { id: source.id, count: Math.max(1, source.count) };
  return { bag: result, moved: true };
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
      // 只认有 id 的格子（初值缺失的脏数据当空格，数量至少 1）
      line.push(cell && cell.id ? { id: cell.id, count: Math.max(1, cell.count ?? 1) } : null);
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

//#region 背包回收（装备一键回收，见 StorageManager.recycleBagEquipments）

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
 * 刻意复用同一个函数而不是另写一份扫描——判定与计价只有一处实现，预览与实际回收不可能对不上
 */
export function summarizeBagRecycle(bag: BagCell[][]): BagRecycleSettlement {
  const { count, totalPrice } = recycleBagEquipmentGrid(bag);
  return { count, totalPrice };
}

//#endregion
