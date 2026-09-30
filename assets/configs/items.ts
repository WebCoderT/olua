import { GOOD_TYPE, Goods } from "../types/good";
import { drugs } from "./drug";
import { belts, clothes, helmets, nicklaces, rings, shoes, weapons } from "./equipments";
import { materials } from "./material";

/**
 * 物品总表：物品 id -> 物品数据
 * 掉落、任务、商店等一律按物品 id 引用物品。
 * 装备在各装备数组里没有显式 id，注册时按「前缀_序号」（cloth_1 / weapon_2 …）生成，
 * 因此调整装备数组顺序会改变这些 id；需要固定 id 时请在配置里显式写 id 字段。
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

// 装备
registerItems(clothes, "cloth");
registerItems(weapons, "weapon");
registerItems(rings, "ring");
registerItems(nicklaces, "necklace");
registerItems(shoes, "shoes");
registerItems(helmets, "helmet");
registerItems(belts, "belt");
// 药品
registerItems(drugs, "drug");
// 材料
registerItems(materials, "material");

/** 按 id 获取物品（返回副本，避免运行时数量等数据污染配置表；无此物品返回 null） */
export function getItem(id: string): Goods | null {
  const item = items.get(id);
  return item ? { ...item } : null;
}

/** 按物品大类获取全部物品 */
export function getItemsByType(type: GOOD_TYPE): Goods[] {
  const result: Goods[] = [];
  items.forEach((item) => {
    if (item.type === type) result.push(item);
  });
  return result;
}
