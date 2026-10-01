import { Equipment, GOOD_TYPE, Goods, isEquipment } from "../types/good";
import { drugs } from "./drug";
import { belts, clothes, helmets, nicklaces, rings, shoes, weapons } from "./equipments";
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
