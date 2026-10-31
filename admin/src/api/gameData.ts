/**
 * 游戏数据：**直接引用三端共用的那一份生成物**
 *
 * ===========================================================================
 * 这份文件是干什么的
 * ===========================================================================
 * 装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 地图的名字与元数据，权威定义只有一处 ——
 * 客户端 `client/assets/configs`。它由 `tools/gen-shared-data.cjs` 快照成
 * `server/src/shared/game-data.generated.ts`，本文件**按相对路径 import 同一个文件**
 * （Vite 打包，跨目录没问题），**不是**同步过来的第二份副本。
 *
 * 所以这里只有两种东西：**转发**（`export { … } from`）与**查表用的纯函数**。
 * 想改数值或文案 → 改客户端配置 → `node tools/gen-shared-data.cjs`。
 * **不许在这边或页面里再写一份字典** —— 那正是这条线要消灭的（此前 `api/types.ts`
 * 里手抄过职业名与性别名，客户端改了这边不会知道）。
 *
 * 守卫：`node tools/audit-shared-data.cjs`（生成物与客户端 configs 逐字节一致、每张表
 * 齐全非空）；它还会扫 `admin/src`，抓「与生成物同名的字典型定义」。
 */

import {
  DRUGS,
  EQUIPMENT_BASES,
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_OF,
  FASHIONS,
  ITEM_BASES,
  ITEM_LABELS,
  MAP_LABELS,
  MONSTERS,
  NPCS,
  OCCUPATION_LABELS,
  RANK_LABELS,
  SEX_LABELS,
  SKILLS,
  SKILL_LABELS,
  SOUL_LABELS,
  SOUL_LEVEL_META,
  STATUSES,
  TITLE_LABELS,
  TITLE_LEVEL_META,
} from "../../../server/src/shared/game-data.generated";

export {
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_OF,
  ITEM_LABELS,
  MAP_LABELS,
  OCCUPATION_LABELS,
  RANK_LABELS,
  SEX_LABELS,
  SKILL_LABELS,
  SOUL_LABELS,
  TITLE_LABELS,
};

/** 职业码 → 名（查不到原样显示码，不静默留空） */
export function occupationLabel(code: string): string {
  return OCCUPATION_LABELS[code] ?? code;
}

/** 性别码 → 名 */
export function sexLabel(code: string): string {
  return SEX_LABELS[code] ?? code;
}

/** 装备槽位 key（`cloth` / `weapon`…）→ 部位名 */
export function slotLabel(slot: string): string {
  return EQUIPMENT_SLOTS[slot] ?? slot;
}

/**
 * 装备 id → 「部位 · 装备显示名」
 *
 * 显示名（含前后缀，如「精良的·天级 屠龙」）由客户端自己的 `getEquipmentNameParts` 在
 * 生成器里拼好，这里不做任何拼接 —— 拼口径正是要避免的事。
 */
export function equipmentText(id: string): string {
  if (!id) return "";
  const name = EQUIPMENT_DISPLAY_NAMES[id] ?? ITEM_LABELS[id];
  if (!name) return `未知装备 ${id}`;
  const slot = EQUIPMENT_SLOT_OF[id];
  return slot ? `${slotLabel(slot)} · ${name}` : name;
}

/** 物品 id → 名（装备 / 药品 / 材料都在内） */
export function itemText(id: string): string {
  if (!id) return "";
  return ITEM_LABELS[id] ?? `未知物品 ${id}`;
}

/** 技能 id → 技能名 */
export function skillText(id: string): string {
  if (!id) return "";
  return SKILL_LABELS[id] ?? `未知技能 ${id}`;
}

/** 地图 id → 地图名 */
export function mapText(id: string): string {
  if (!id) return "";
  return MAP_LABELS[id] ?? id;
}

/**
 * 三张等级表都是「下标 = 等级 - 1」（客户端等级从 1 起，来源数组从 0 起）——
 * 那一位差只在这里处理，页面不碰。
 */
function levelText(table: Record<string, { label?: string } | string>, level: string | number): string {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return "";
  const row = table[String(value - 1)];
  if (row === undefined) return "";
  return typeof row === "string" ? row : (row.label ?? "");
}

/** 战魂阶数 → 名 */
export function soulText(level: string | number): string {
  return levelText(SOUL_LABELS, level);
}

/** 称号等级 → 名 */
export function titleText(level: string | number): string {
  return levelText(TITLE_LABELS, level);
}

/** 军衔阶数 → 名（大段 + 衔名） */
export function rankText(level: string | number): string {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return "";
  // 生成物里的 `RANK_LABELS` 是「字面量键」类型（每个键都写死了），拿字符串索引要先摊成 Record
  const rows: Record<string, { tier: string; label: string }> = RANK_LABELS;
  const row = rows[String(value - 1)];
  return row ? `${row.tier} · ${row.label}` : "";
}

/* ===========================================================================
 * 图片字段查表（列表页缩略图用）
 *
 * 图片是**客户端静态资源**，不是运营数据：与页面上的名字同一份生成物查出来，
 * 不进库、不走接口。查不到（生成物里没有这个 id / 字段为空）返回空串，
 * 缩略图组件会显示「无图」占位。
 * =========================================================================== */

/** 生成物表里直读一个字符串字段（表行都是 Record<string, unknown>，只开这一个口） */
function rowField(table: Record<string, unknown>, key: string, field: string): string {
  const row = table[key];
  if (!row || typeof row !== "object") return "";
  const value = (row as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/** 装备基础件 id → 图标（商城商品 = 装备，同一份） */
export function equipmentIcon(id: string): string {
  return rowField(EQUIPMENT_BASES, id, "icon");
}

/** 药品 id → 图标 */
export function drugIcon(id: string): string {
  return rowField(DRUGS, id, "icon");
}

/** 物品（材料 / 其他）id → 图标 */
export function itemIcon(id: string): string {
  return rowField(ITEM_BASES, id, "icon");
}

/** 怪物 key → 图标 */
export function monsterIcon(id: string): string {
  return rowField(MONSTERS, id, "icon");
}

/** 技能 id → 图标 */
export function skillIcon(id: string): string {
  return rowField(SKILLS, id, "icon");
}

/** 状态 id → 图标 */
export function statusIcon(id: string): string {
  return rowField(STATUSES, id, "icon");
}

/** 时装 id → 图标 */
export function fashionIcon(id: string): string {
  return rowField(FASHIONS, id, "icon");
}

/** NPC id → 素材目录（图集动画，缩略图取首帧） */
export function npcSrc(id: string): string {
  return rowField(NPCS, id, "src");
}

/** 称号等级 → 动画图集目录（下标 = 等级 - 1，与 levelText 同一口径；缩略图取首帧） */
export function titleAnimation(level: string | number): string {
  const value = Number(level);
  return Number.isFinite(value) && value >= 1 ? rowField(TITLE_LEVEL_META, String(value - 1), "animation") : "";
}

/** 战魂阶数 → 动画图集目录（下标 = 等级 - 1；缩略图取首帧） */
export function soulAnimation(level: string | number): string {
  const value = Number(level);
  return Number.isFinite(value) && value >= 1 ? rowField(SOUL_LEVEL_META, String(value - 1), "animation") : "";
}
