import { Equipment, Goods } from "../types/good";
import { belts, clothes, equipmentSlotOrder, helmets, nicklaces, rings, shoes, weapons } from "./equipments";

/**
 * 商城数据表
 *
 * 商品 = **系统内的全部装备**：七个部位的装备 Map 全量收进来（含前后缀品质变体，
 * 一件基础装备 = 15 件变体，见 configs/equipments.buildEquipmentMap），购买后直接进背包。
 * 陈列与购买交互在 ui/components/dialogs/MallDialog。
 *
 * **#603 第八域起客户端不存任何价格**：统一价与特殊价都在服务端（`mall_settings` /
 * `mall_prices` 两张表，管理端「商城定价」可改），进游戏由 `GET /game-config` 快照下发，
 * 这里只做落表与取价。以前在客户端写死的 `mallPrice = 1` 已删 —— 那份常量与服务端
 * `MALL.defaultPrice` 是同一件事，两边各改一次迟早漂移。
 */

/** 特殊价（商品 id → 绑定元宝）：快照 `mallPrices` 段整表重建 */
let specialPrices = new Map<string, number>();

/** 统一价（快照 `mallSettings.defaultPrice`）；null = 快照还没到 */
let defaultPrice: number | null = null;

/** 只 warn 一次：快照没到就问价，说明调用时序错了（正常路径 `Game.start` 已 await 过配置） */
let warnedMissing = false;

/**
 * 接入服务端定价（`configs/apply-snapshot` 调用）：defaultPrice = mall_settings 统一价，
 * prices = mall_prices 全量目录（price 为 null 的行是未定价，不入 Map）
 */
export function applyMallPricing(nextDefaultPrice: number, prices: Array<{ id: string; price: number | null }>): void {
  const map = new Map<string, number>();
  prices.forEach((entry) => {
    if (entry.price != null) map.set(entry.id, entry.price);
  });
  specialPrices = map;
  defaultPrice = nextDefaultPrice;
}

/**
 * 取某件物品在商城的售价（绑定元宝 / 件）：**特殊价优先，未定价走统一价**
 *
 * 与结算口径一致（服务端扣款用的就是这套规则）。快照没到就返回 0 并 warn 一次 ——
 * 不在这里兜一个「出厂价」，那等于又在客户端存一份价格。
 */
export function getMallPrice(good: Goods): number {
  if (defaultPrice == null) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[mall] 商城定价快照还没到就取价了（返回 0）：检查调用时序，正常应在 Loading 场景的 loadGameConfig（#604）之后");
    }
    return 0;
  }
  return specialPrices.get(good.id ?? "") ?? defaultPrice;
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
