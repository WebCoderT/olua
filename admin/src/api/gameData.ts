/**
 * 游戏数据：**直接引用三端共用的那一份生成物 + 服务端种子（#590）**
 *
 * ===========================================================================
 * 这份文件是干什么的
 * ===========================================================================
 * 装备 / 技能 / 物品 / 地图的名字与元数据，权威定义只有一处 ——
 * 客户端 `client/assets/configs`。它由 `tools/gen-shared-data.cjs` 快照成
 * `server/src/shared/game-data.generated.ts`，本文件**按相对路径 import 同一个文件**
 * （Vite 打包，跨目录没问题），**不是**同步过来的第二份副本。
 *
 * 三条成长线（#590 起）：称号 / 战魂 / 军衔的名字与元数据**不在生成物里**，
 * 唯一书写处是 `server/src/shared/{title,soul,rank}-seed.ts`，本文件直接 import 同一份。
 *
 * 所以这里只有两种东西：**转发**（`export { … } from`）与**查表用的纯函数**。
 * 想改数值或文案 → 改客户端配置 / 服务端种子 → 重新生成或重跑。
 * **不许在这边或页面里再写一份字典** —— 那正是这条线要消灭的（此前 `api/types.ts`
 * 里手抄过职业名与性别名，客户端改了这边不会知道）。
 *
 * 守卫：`node tools/audit-shared-data.cjs`（生成物与客户端 configs 逐字节一致、每张表
 * 齐全非空）；它还会扫 `admin/src`，抓「与生成物同名的字典型定义」。
 */

import { RANK_SEEDS } from "../../../server/src/shared/rank-seed";
import { SOUL_SEEDS } from "../../../server/src/shared/soul-seed";
import { TITLE_SEEDS } from "../../../server/src/shared/title-seed";

import {
  DRUGS,
  EQUIPMENT_BASES,
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_OF,
  EQUIPMENT_SLOT_ORDER,
  FASHIONS,
  ITEM_BASES,
  ITEM_LABELS,
  OCCUPATION_LABELS,
  SEX_LABELS,
  SKILLS,
  SKILL_LABELS,
  STATUSES,
} from "../../../server/src/shared/game-data.generated";
// 怪物资源与表现（#588：客户端 configs/monster 不再有怪物数据，图标字典随生成物走）
import { MONSTER_PRESENTATION_ROWS } from "../../../server/src/shared/monster-presentation.generated";

export {
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_OF,
  ITEM_LABELS,
  OCCUPATION_LABELS,
  SEX_LABELS,
  SKILL_LABELS,
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

/** 战魂阶数 → 名（#590：唯一来源 = 服务端 soul-seed，数组下标 = 阶数 - 1） */
export function soulText(level: string | number): string {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return "";
  return SOUL_SEEDS[value - 1]?.label ?? "";
}

/** 称号等级 → 名（#590：唯一来源 = 服务端 title-seed） */
export function titleText(level: string | number): string {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return "";
  return TITLE_SEEDS[value - 1]?.label ?? "";
}

/** 军衔阶数 → 名（大段 + 衔名；#590：唯一来源 = 服务端 rank-seed） */
export function rankText(level: string | number): string {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return "";
  const row = RANK_SEEDS[value - 1];
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

/** 直读一个数字字段（缺失 / 非数字 → 0，调用方不用到处判 undefined） */
function rowNumber(table: Record<string, unknown>, key: string, field: string): number {
  const row = table[key];
  if (!row || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 装备 id → 基础件 id（`cloth_1_p2s1` → `cloth_1`）
 *
 * 变体规则与客户端 `getEquipmentBaseKey`、服务端 `parseEquipmentVariantId` 同一口径：
 * 只有末尾 `_pXsY` 是变体段。管理端不自己发明第二套规则，剥完还要在基础件表里查得到才算。
 * 查不到返回空串（脏 id / 未来新增的其它形态都不猜）。
 */
export function equipmentBaseId(id: string): string {
  if (!id) return "";
  if (EQUIPMENT_BASES[id]) return id;
  const match = /^(.*)_p\d+s\d+$/.exec(id);
  const base = match ? match[1] : "";
  return base && EQUIPMENT_BASES[base] ? base : "";
}

/** 装备 id（基础件或变体）→ 部位 key；认不出返回空串 */
export function equipmentSlot(id: string): string {
  return EQUIPMENT_SLOT_OF[id] ?? "";
}

/**
 * 装备 id → 穿戴等级门槛
 *
 * 变体不带自己的等级，一律取基础件那一行（与客户端「变体只改倍率、不改门槛」一致）。
 * 认不出 → 0（界面显示成「等级未知」由调用方决定，不在这里编一个数）。
 */
export function equipmentLevel(id: string): number {
  const base = equipmentBaseId(id);
  return base ? rowNumber(EQUIPMENT_BASES, base, "level") : 0;
}

/** 不给部位前缀的装备显示名（`equipmentText` 是「部位 · 名字」，这个只取名字） */
export function equipmentName(id: string): string {
  if (!id) return "";
  return EQUIPMENT_DISPLAY_NAMES[id] ?? ITEM_LABELS[id] ?? "";
}

/**
 * 部位清单与顺序（生成物 `EQUIPMENT_SLOT_ORDER`：背包一键整理的部位顺序）
 *
 * 界面按它排装备格 —— 顺序也归客户端配置管，管理端不另排一套。
 */
export function equipmentSlotKeys(): string[] {
  return Object.keys(EQUIPMENT_SLOT_ORDER).sort(
    (a, b) =>
      (EQUIPMENT_SLOT_ORDER as Record<string, number>)[a] - (EQUIPMENT_SLOT_ORDER as Record<string, number>)[b],
  );
}

/** 技能 id → 描述（列表里当副标题；没有就空串） */
export function skillDescription(id: string): string {
  return rowField(SKILLS, id, "description");
}

/** 技能 id → 学习 / 升级所需等级 */
export function skillLevelReq(id: string): number {
  return rowNumber(SKILLS, id, "levelReq");
}

/** 技能 id → 拥有者（`role` 玩家 / `monster` 怪物），用来分组 */
export function skillOwner(id: string): string {
  return rowField(SKILLS, id, "owner");
}

/** 物品 id → 描述（材料 / 药品有，装备没有） */
export function itemDescription(id: string): string {
  return rowField(ITEM_BASES, id, "description");
}

/** 物品 id → 类型（`material` 等；装备 id 不在物品表里，返回空串） */
export function itemType(id: string): string {
  return rowField(ITEM_BASES, id, "type");
}

/** 药品 id → 名（不在药品表返回空串，让调用方去试别的表） */
export function drugText(id: string): string {
  return rowField(DRUGS, id, "label");
}

/** 药品 id → 使用等级 */
export function drugLevel(id: string): number {
  return rowNumber(DRUGS, id, "level");
}

/** 时装 id → 名 */
export function fashionText(id: string): string {
  return rowField(FASHIONS, id, "label");
}

/** 时装 id → 描述 */
export function fashionDescription(id: string): string {
  return rowField(FASHIONS, id, "description");
}

/**
 * 单格堆叠上限
 *
 * 药品 / 材料各表自己写着 `maxStack`；装备不进堆叠（1 件 1 格）。
 * 查不到的一律按 1 —— 宁可让运营多摆一格，也不让界面允许一个服务端会拒的数量。
 */
export function maxStackOf(id: string): number {
  const drug = rowNumber(DRUGS, id, "maxStack");
  if (drug > 0) return drug;
  const item = rowNumber(ITEM_BASES, id, "maxStack");
  if (item > 0) return item;
  return 1;
}

/** 一档养成等级的元数据（称号 / 战魂：说明文案 + 升到该级消耗 + 动画图集） */
export interface GrowthStepMeta {
  description: string;
  bindGold: number;
  animation: string;
}

function seedStep(row: { description: string; bindGold: number; animation: string } | undefined): GrowthStepMeta | null {
  if (!row) return null;
  return {
    description: row.description,
    bindGold: row.bindGold,
    animation: row.animation,
  };
}

/** 称号等级 → 元数据（#590：唯一来源 = 服务端 title-seed，下标 = 等级 - 1） */
export function titleMeta(level: string | number): GrowthStepMeta | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  return seedStep(TITLE_SEEDS[value - 1]);
}

/** 战魂阶数 → 元数据（#590：唯一来源 = 服务端 soul-seed） */
export function soulMeta(level: string | number): GrowthStepMeta | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  return seedStep(SOUL_SEEDS[value - 1]);
}

/** 军衔阶数 → { 大段, 衔名 }（#590：唯一来源 = 服务端 rank-seed）；无动画（军衔只有名字） */
export function rankMeta(level: string | number): { tier: string; label: string } | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null;
  const row = RANK_SEEDS[value - 1];
  return row ? { tier: row.tier, label: row.label } : null;
}

/** 三张等级表各有多少档（等级选择器的上限；不是页面写死的数字） */
export function levelCount(kind: "title" | "soul" | "rank"): number {
  if (kind === "title") return TITLE_SEEDS.length;
  if (kind === "soul") return SOUL_SEEDS.length;
  return RANK_SEEDS.length;
}

/* ===========================================================================
 * 可选清单（选择器用）
 *
 * 清单键一律取自生成物各表本身 —— 页面 / 组件不写死「有哪些装备、哪些技能」，
 * 客户端配置加一件，这里的下拉就自动多一条。
 * =========================================================================== */

/** 全部装备 id（基础件 + 全部前后缀变体，与角色身上穿的 id 同一形态） */
export function equipmentIds(): string[] {
  return Object.keys(EQUIPMENT_DISPLAY_NAMES);
}

/** 全部可进背包的物品 id（装备 / 药品 / 材料都在内，`ITEM_LABELS` 是客户端那份总表） */
export function itemIds(): string[] {
  return Object.keys(ITEM_LABELS);
}

/** 全部技能 id（玩家技能 + 怪物技能） */
export function skillIds(): string[] {
  return Object.keys(SKILL_LABELS);
}

/** 全部药品 id */
export function drugIds(): string[] {
  return Object.keys(DRUGS);
}

/** 全部时装 id */
export function fashionIds(): string[] {
  return Object.keys(FASHIONS);
}

/**
 * 地图预览图（小地图弹窗用的那张底图）
 *
 * 路径规则来自客户端 `configs/layout/images.ts` 的 `mapPreviewImage`：`map/<id>/preview`，
 * 磁盘上是 **.jpg**（不是 png）—— 所以取图时要带扩展名，直接按默认 png 拼会 404。
 * 生成物里只有地图名（`MAP_LABELS`），没有这张图的字段，规则只能在这里落一处。
 */
export function mapPreview(id: string): string {
  return id ? `map/${id}/preview` : "";
}

/**
 * 角色头像：按「职业-性别」取图（`avatars/<occupation>-<sex>.png`）
 *
 * 同样是客户端的取图规则（`configs/layout/images.ts` 的 `avatarImage`）。
 * 注意：角色数据里的 `avatar`（数字）是**头像编号**，不是这张图的下标 ——
 * 客户端 HUD 头像一直按职业 + 性别取，所以这里也按这两个字段取，不去索引数字。
 */
export function avatarPath(occupation: string, sex: string): string {
  if (!occupation || !sex) return "";
  return `avatars/${occupation}-${sex}`;
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

/** 怪物 key → 图标（monster-presentation 生成物；数值在 monsters 表，走管理端接口） */
export function monsterIcon(id: string): string {
  const row = MONSTER_PRESENTATION_ROWS.find((item) => item.id === id);
  return row?.icon ?? "";
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

/** 称号等级 → 动画图集目录（#590：服务端 title-seed，下标 = 等级 - 1；缩略图取首帧） */
export function titleAnimation(level: string | number): string {
  const value = Number(level);
  return Number.isFinite(value) && value >= 1 ? (TITLE_SEEDS[value - 1]?.animation ?? "") : "";
}

/** 战魂阶数 → 动画图集目录（#590：服务端 soul-seed，下标 = 阶数 - 1；缩略图取首帧） */
export function soulAnimation(level: string | number): string {
  const value = Number(level);
  return Number.isFinite(value) && value >= 1 ? (SOUL_SEEDS[value - 1]?.animation ?? "") : "";
}
