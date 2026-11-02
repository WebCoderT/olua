import { GOOD_TYPE, Material } from "../types/good";

/**
 * 材料配置（物品大类 GOOD_TYPE.MATERIAL）—— **客户端没有出厂数据**（#603 第十域）
 *
 * 名称 / 描述 / 图标 / 等级 / 售价 / 叠加上限的唯一书写处是服务端
 * `server/src/shared/item-seed.ts` → `items` 表（管理端「物品配置」可改）→
 * `GET /game-config` 快照的 `items` 段 → 这里整表重建（`applyItemBaseData`）。
 *
 * 这张表收的是 **MATERIAL / OTHER** 大类：装备在 `configs/equipments`（服务端 equipments 表）、
 * 药品在 `configs/drug`（服务端 drugs 表），三张表字段形态不同，各自一张。
 */

/** 服务端物品行（快照 `items` 段；与 `item-seed.ts` 的 `ItemBaseSeedRow` 同形） */
export interface ItemBaseSeedLike {
  id: string;
  type: string;
  label: string;
  description: string;
  icon: string;
  level: number;
  sellPrice: number;
  maxStack: number;
}

/** 材料运行时表（内容全部来自服务端；加载期为空） */
export const materials: Material[] = [];

/**
 * 整表重建材料 / 其它物品（#603 第十域）
 *
 * 与药品同款：客户端没有出厂行，快照里没有的 id 客户端就不该有。
 * `type` 取服务端下发的原值（`material` / `other`；缺省按 material），
 * 因此未来加 OTHER 大类不用改客户端。
 */
export function applyItemBaseData(rows: ItemBaseSeedLike[]): void {
  materials.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    materials.push({
      id: row.id,
      type: ((row.type as GOOD_TYPE) || GOOD_TYPE.MATERIAL) as Material["type"],
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      level: Number(row.level) || 1,
      sellPirce: Number(row.sellPrice) || 0,
      stackable: true,
      maxStack: Number(row.maxStack) || 99,
    });
  }
}
