import { Equipment, Goods } from "../types/good";
import { belts, clothes, equipmentSlotOrder, helmets, nicklaces, rings, shoes, weapons } from "./equipments";

/**
 * 商城数据表
 *
 * 商品 = **系统内的全部装备**：七个部位的装备 Map 全量收进来（含前后缀品质变体，
 * 一件基础装备 = 15 件变体，见 configs/equipments.buildEquipmentMap），购买后直接进背包。
 * 售价默认统一 1 绑定元宝/件；想给个别装备单独定价改 customPriceData，界面不用动。
 * 陈列与购买交互在 ui/components/dialogs/MallDialog，商品与价格都以这里为准。
 */

/** 商城默认售价（绑定元宝 / 件）：全场统一价，特殊装备在 customPriceData 里覆盖 */
export const mallPrice = 1;

/** 特殊装备定价表（数组为源 + 尾部建 Map，key 只做关联）：不在此表的装备走 mallPrice 统一价 */
const customPriceData: Array<{ id: string; price: number }> = [];
const customPrices = new Map(customPriceData.map((entry) => [entry.id, entry.price]));

/** 取某件物品在商城的售价（绑定元宝 / 件；特殊定价表优先，其余走统一价） */
export function getMallPrice(good: Goods): number {
  return customPrices.get(good.id ?? "") ?? mallPrice;
}

/**
 * 商城商品全表：七个部位的装备 Map 全量合并，按 **部位序 → 等级升序 → 前缀 → 后缀** 排序
 * （部位序 = 装备槽配置的先后，见 equipmentSlotOrder；每次调用现算，不怕外部改表）
 *
 * ⚠️ 收集必须用 `map.forEach`：打包 babel loose 会把 `[...map.values()]` 编成 `[].concat(迭代器)`
 * → 恒为空数组（症状 = 商城静默无货，见 equipments.getBaseEquipments 的注释）
 */
export function getMallGoods(): Equipment[] {
  const result: Equipment[] = [];
  [clothes, weapons, rings, nicklaces, shoes, helmets, belts].forEach((map) =>
    map.forEach((equipment, key) => {
      // id 由 configs/items 统一登记（登记时回填到同一对象）；这里兜底补一次，脱离 items 也能自洽
      if (!equipment.id) equipment.id = key;
      result.push(equipment);
    }),
  );
  const slotOrder = (equipment: Equipment) => equipmentSlotOrder.get(equipment.slot) ?? Number.MAX_SAFE_INTEGER;
  result.sort((a, b) => slotOrder(a) - slotOrder(b) || a.level - b.level || a.prefix - b.prefix || a.suffix - b.suffix);
  return result;
}
