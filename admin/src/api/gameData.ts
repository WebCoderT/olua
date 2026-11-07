/**
 * 游戏数据查表（管理端）：**数据来自数据库，接口拉一次，之后同步读**
 *
 * ===========================================================================
 * 这个文件解决什么
 * ===========================================================================
 * 管理端有大量「同步渲染」的查表：角色详情里背包那件装备叫什么、掉落条目引用的是
 * 哪只怪、可视化选择器的下拉有哪几个物品……这些必须在 render 里同步拿到。
 *
 * #655 之前这些名字来自**生成物**（`server/src/shared/game-data.generated.ts`）——
 * 那是「代码里躺着第二份数据」：改一个名字要重新生成，忘了重生成就与库里对不上，
 * 而且全部装备变体的名字在包里再存一遍。
 *
 * 现在唯一权威是数据库：登录后 `Layout` 调一次 `ensureGameData()`，拉
 * `GET /admin/game-data`（与客户端 `GET /game-config` 同一份快照），本文件把它索引成
 * 几张 Map，之后所有查表都是同步的。**代码里没有任何一份数据副本**。
 *
 * ## 约定
 * - 缓存没到 / 拉取失败时，名字类查表回落 **id 本身**（`itemText("1234")` → `"1234"`）——
 *   那一眼能看出「名字还没加载」，而不是显示一个假装正确的空串；
 * - 职业 / 性别 / 怪物定位的中文名**不在这里**：那三个是枚举（加一个值就要改代码），
 *   住在服务端 `common/constants/game-enums.ts`，与客户端 `assets/types/*` 逐值一致；
 * - 地图名字走 `./mapCatalog`（`maps` 表，#573），不重复拉。
 *
 * ## 什么时候会刷新
 * 管理端改完配置（改装备名 / 技能名）后，本进程的缓存还是旧的 —— 刷新页面即最新。
 * 不做「写操作后自动重拉」：**同步渲染的字典要求稳定**，随时变会让表格里的名字跳。
 */

import { MONSTER_TIER_LABELS, OCCUPATION_LABELS, SEX_LABELS } from "../../../server/src/common/constants/game-enums";
import { gameDataApi } from "./endpoints";
import type {
  Drug,
  EquipmentVariant,
  Fashion,
  GameConfigSnapshot,
  Item,
  Rank,
  Skill,
  Soul,
  Status,
  Title,
} from "./models";

// 枚举（代码即真源）：与客户端 types 逐值一致，直接从服务端常量转发，不另抄一份
export { MONSTER_TIER_LABELS, OCCUPATION_LABELS, SEX_LABELS };

/** 职业码 → 名（查不到原样显示码，不静静留空） */
export function occupationLabel(code: string): string {
  return OCCUPATION_LABELS[code] ?? code;
}

/** 性别码 → 名 */
export function sexLabel(code: string): string {
  return SEX_LABELS[code] ?? code;
}

//#region 缓存与索引

/** 一档养成等级的元数据（称号 / 战魂：说明文案 + 升到该级消耗 + 动画图集） */
export interface GrowthStepMeta {
  description: string;
  bindGold: number;
  animation: string;
}

/** 怪物的一行（选择器 / 任务目标 / 成就条件共用；`out` 供帧动画预览） */
export interface MonsterInfo {
  id: string;
  label: string;
  level: number;
  tier: string;
  /** 外观图集目录（`monster/out/<key>`；缺演示行的怪是空串） */
  out: string;
}

/** NPC 的一行（`src` 是图集动画目录，选择器拿它当缩略图） */
export interface NpcInfo {
  id: string;
  label: string;
  src: string;
}

/** 基础件信息（从「前缀 0 + 后缀 0」那条变体行反推：它的显示字段就是基础件的字段） */
interface BaseInfo {
  label: string;
  level: number;
  icon: string;
  slot: string;
  /** 外观图集目录（帧动画预览用；同款变体共用一套外观） */
  outAtlas: string;
}

let loaded = false;
let loading: Promise<void> | null = null;

let variants = new Map<string, EquipmentVariant>();
let bases = new Map<string, BaseInfo>();
let slotLabels = new Map<string, string>();
let slotOrder: string[] = [];
let items = new Map<string, Item>();
let drugs = new Map<string, Drug>();
let skills = new Map<string, Skill>();
let statuses = new Map<string, Status>();
let fashions = new Map<string, Fashion>();
let monsterList: MonsterInfo[] = [];
let monsterIconOf = new Map<string, string>();
let monsterOutOf = new Map<string, string>();
let npcList: NpcInfo[] = [];
let titles: Title[] = [];
let souls: Soul[] = [];
let ranks: Rank[] = [];

/**
 * 保证查表数据已加载（幂等；失败静默）
 *
 * 失败静默的理由：这些数据只影响「显示出来的名字」，不该挡住后台任何页面。
 * 下次调用会再试一次（`loading` 置回 null，缓存仍空）。
 */
export function ensureGameData(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = gameDataApi
      .snapshot()
      .then((data) => index(data))
      .catch(() => {
        // 名字拉不到就按 id 显示：这不是错误状态，只是少了个好听的名字
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 数据是否已加载（只用于展示兜底判断，不该拿来挡操作） */
export function gameDataLoaded(): boolean {
  return loaded;
}

/** 把快照索引成查表用的 Map / 数组（顺序一并在这一次算好，避免每处调用各排一遍） */
function index(data: GameConfigSnapshot): void {
  variants = new Map(data.equipments.map((row) => [row.id, row]));
  bases = new Map();
  for (const row of data.equipments) {
    // 前缀 0 + 后缀 0 的行显示字段 = 基础件本身（同一次快照里一定有这一行，见 equipment-variant 展开规则）
    if (row.prefix !== 0 || row.suffix !== 0) continue;
    bases.set(row.baseId, { label: row.label, level: row.level, icon: row.icon, slot: row.slot, outAtlas: row.outAtlas });
  }

  slotLabels = new Map(data.equipmentSlots.map((row) => [row.key, row.label]));
  slotOrder = [...data.equipmentSlots].sort((a, b) => a.order - b.order).map((row) => row.key);

  items = new Map(data.items.map((row) => [row.id, row]));
  drugs = new Map(data.drugs.map((row) => [row.id, row]));
  skills = new Map(data.skills.map((row) => [row.id, row]));
  statuses = new Map(data.statuses.map((row) => [row.id, row]));
  fashions = new Map(data.fashions.map((row) => [row.id, row]));

  titles = [...data.titles].sort((a, b) => a.level - b.level);
  souls = [...data.souls].sort((a, b) => a.level - b.level);
  ranks = [...data.ranks].sort((a, b) => a.level - b.level);

  monsterIconOf = new Map(data.monsterPresentations.map((row) => [row.id, row.icon]));
  monsterOutOf = new Map(data.monsterPresentations.map((row) => [row.id, row.out]));
  monsterList = data.monsters
    .map((row) => ({
      id: row.id,
      label: row.label,
      level: row.level,
      tier: row.tier,
      out: monsterOutOf.get(row.id) ?? "",
    }))
    // 排序不用字典序：怪 id 是 "1" / "2" / "10"，字典序会把 10 排在 2 前面，
    // 按等级排才符合「打怪的推进顺序」
    .sort((a, b) => a.level - b.level || Number(a.id) - Number(b.id));

  npcList = data.npcs
    .map((row) => ({ id: row.id, label: row.label, src: row.src }))
    .sort((a, b) => a.id.localeCompare(b.id));

  loaded = true;
}

//#endregion

//#region 装备

/** 装备槽位 key（`cloth` / `weapon`…）→ 部位名 */
export function slotLabel(slot: string): string {
  return slotLabels.get(slot) ?? slot;
}

/** 部位清单与顺序（`equipment_slots.order`：背包一键整理的部位顺序） */
export function equipmentSlotKeys(): string[] {
  return slotOrder;
}

/**
 * 装备 id → 基础件 id（`cloth_1_p2s1` → `cloth_1`）
 *
 * 变体规则只有末尾 `_pXsY` 一段；但这里**不自己剥**——直接看快照里的 `baseId`，
 * 剥字符串的规则只在服务端一处（`parseEquipmentVariantId`）。认不出返回空串。
 */
export function equipmentBaseId(id: string): string {
  if (!id) return "";
  if (bases.has(id)) return id;
  const base = variants.get(id)?.baseId ?? "";
  return base && bases.has(base) ? base : "";
}

/** 装备 id（基础件或变体）→ 部位 key；认不出返回空串 */
export function equipmentSlot(id: string): string {
  return variants.get(id)?.slot ?? bases.get(id)?.slot ?? "";
}

/** 装备 id → 穿戴等级门槛（每行自带 level，#655 起不再「一律取基础件」） */
export function equipmentLevel(id: string): number {
  return variants.get(id)?.level ?? bases.get(id)?.level ?? 0;
}

/** 不给部位前缀的装备显示名（`equipmentText` 是「部位 · 名字」，这个只取名字） */
export function equipmentName(id: string): string {
  if (!id) return "";
  return variants.get(id)?.label ?? bases.get(id)?.label ?? items.get(id)?.label ?? drugs.get(id)?.label ?? "";
}

/** 装备 id → 「部位 · 装备显示名」 */
export function equipmentText(id: string): string {
  if (!id) return "";
  const name = equipmentName(id) || `未知装备 ${id}`;
  const slot = equipmentSlot(id);
  return slot ? `${slotLabel(slot)} · ${name}` : name;
}

/** 装备基础件 id → 图标（商城商品 = 装备，同一份） */
export function equipmentIcon(id: string): string {
  return variants.get(id)?.icon ?? bases.get(id)?.icon ?? "";
}

/**
 * 装备 id → 外观图集目录（`equipment/clothes/out/005`；管理端帧动画预览用）
 *
 * 外观挂在基础件上（同款变体共用一套），变体 id 先剥回基础件再查。
 * 库里没配外观的装备返回空串 —— 调用方落回静态图标。
 */
export function equipmentOutAtlas(id: string): string {
  const base = equipmentBaseId(id);
  return variants.get(base ?? "")?.outAtlas ?? bases.get(base ?? "")?.outAtlas ?? "";
}

/** 全部装备 id（基础件 + 全部前后缀变体，与角色身上穿的 id 同一形态） */
export function equipmentIds(): string[] {
  return [...variants.keys()];
}

//#endregion

//#region 物品 / 药品 / 时装 / 技能 / 状态

/** 物品 id → 名（装备 / 药品 / 材料都在内） */
export function itemText(id: string): string {
  if (!id) return "";
  return equipmentName(id) || items.get(id)?.label || drugs.get(id)?.label || `未知物品 ${id}`;
}

/** 全部可进背包的物品 id（装备 / 药品 / 材料都在内） */
export function itemIds(): string[] {
  return [...variants.keys(), ...items.keys(), ...drugs.keys()];
}

/** 物品 id → 描述（材料 / 药品有，装备没有） */
export function itemDescription(id: string): string {
  return items.get(id)?.description ?? "";
}

/** 物品 id → 类型（`material` 等；装备 / 药品不在物品表里，返回空串） */
export function itemType(id: string): string {
  return items.get(id)?.type ?? "";
}

/** 物品（材料 / 其他）id → 图标 */
export function itemIcon(id: string): string {
  return items.get(id)?.icon ?? "";
}

/** 药品 id → 名（不在药品表返回空串，让调用方去试别的表） */
export function drugText(id: string): string {
  return drugs.get(id)?.label ?? "";
}

/** 药品 id → 使用等级 */
export function drugLevel(id: string): number {
  return drugs.get(id)?.level ?? 0;
}

/** 药品 id → 图标 */
export function drugIcon(id: string): string {
  return drugs.get(id)?.icon ?? "";
}

/** 全部药品 id */
export function drugIds(): string[] {
  return [...drugs.keys()];
}

/** 时装 id → 名 */
export function fashionText(id: string): string {
  return fashions.get(id)?.label ?? "";
}

/** 时装 id → 描述 */
export function fashionDescription(id: string): string {
  return fashions.get(id)?.description ?? "";
}

/** 时装 id → 图标 */
export function fashionIcon(id: string): string {
  return fashions.get(id)?.icon ?? "";
}

/** 全部时装 id */
export function fashionIds(): string[] {
  return [...fashions.keys()];
}

/** 技能 id → 技能名 */
export function skillText(id: string): string {
  if (!id) return "";
  return skills.get(id)?.label ?? `未知技能 ${id}`;
}

/** 技能 id → 描述（列表里当副标题；没有就空串） */
export function skillDescription(id: string): string {
  return skills.get(id)?.description ?? "";
}

/** 技能 id → 学习 / 升级所需等级 */
export function skillLevelReq(id: string): number {
  return skills.get(id)?.levelReq ?? 0;
}

/** 技能 id → 拥有者（`role` 玩家 / `monster` 怪物），用来分组 */
export function skillOwner(id: string): string {
  return skills.get(id)?.owner ?? "";
}

/** 技能 id → 图标 */
export function skillIcon(id: string): string {
  return skills.get(id)?.icon ?? "";
}

/** 全部技能 id（玩家技能 + 怪物技能） */
export function skillIds(): string[] {
  return [...skills.keys()];
}

/** 状态 id → 图标 */
export function statusIcon(id: string): string {
  return statuses.get(id)?.icon ?? "";
}

/**
 * 单格堆叠上限
 *
 * 药品 / 材料各表自己写着 `maxStack`；装备不进堆叠（1 件 1 格）。
 * 查不到的按 1 —— 宁可让运营多摆一格，也不让界面允许一个服务端会拒的数量。
 */
export function maxStackOf(id: string): number {
  const drug = drugs.get(id)?.maxStack ?? 0;
  if (drug > 0) return drug;
  const item = items.get(id)?.maxStack ?? 0;
  if (item > 0) return item;
  return 1;
}

//#endregion

//#region 三条成长线（称号 / 战魂 / 军衔）

/** 档位序号（1 起）→ 数组下标（越界返回 -1） */
function stepOf(list: { level: number }[], level: string | number): number {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return -1;
  return list.findIndex((row) => row.level === value);
}

function stepMeta(row: { description: string; bindGold: number; animation?: string } | undefined): GrowthStepMeta | null {
  if (!row) return null;
  return { description: row.description, bindGold: row.bindGold, animation: row.animation ?? "" };
}

/** 称号等级 → 名 */
export function titleText(level: string | number): string {
  const index = stepOf(titles, level);
  return index < 0 ? "" : titles[index].label;
}

/** 称号等级 → 元数据（说明文案 + 升级消耗 + 动画图集） */
export function titleMeta(level: string | number): GrowthStepMeta | null {
  const index = stepOf(titles, level);
  return index < 0 ? null : stepMeta(titles[index]);
}

/** 称号等级 → 动画图集目录（缩略图取首帧） */
export function titleAnimation(level: string | number): string {
  const index = stepOf(titles, level);
  return index < 0 ? "" : titles[index].animation;
}

/** 战魂阶数 → 名 */
export function soulText(level: string | number): string {
  const index = stepOf(souls, level);
  return index < 0 ? "" : souls[index].label;
}

/** 战魂阶数 → 元数据 */
export function soulMeta(level: string | number): GrowthStepMeta | null {
  const index = stepOf(souls, level);
  return index < 0 ? null : stepMeta(souls[index]);
}

/** 战魂阶数 → 动画图集目录 */
export function soulAnimation(level: string | number): string {
  const index = stepOf(souls, level);
  return index < 0 ? "" : souls[index].animation;
}

/** 军衔阶数 → 名（大段 + 衔名） */
export function rankText(level: string | number): string {
  const index = stepOf(ranks, level);
  return index < 0 ? "" : `${ranks[index].tier} · ${ranks[index].label}`;
}

/** 军衔阶数 → { 大段, 衔名 }；无动画（军衔只有名字） */
export function rankMeta(level: string | number): { tier: string; label: string } | null {
  const index = stepOf(ranks, level);
  return index < 0 ? null : { tier: ranks[index].tier, label: ranks[index].label };
}

/** 三张等级表各有多少档（等级选择器的上限；不是页面写死的数字） */
export function levelCount(kind: "title" | "soul" | "rank"): number {
  if (kind === "title") return titles.length;
  if (kind === "soul") return souls.length;
  return ranks.length;
}

//#endregion

//#region 怪物 / NPC

/** 全部怪物（按等级 → id 数值序；清单来自 `monsters` 表） */
export function monsterRows(): MonsterInfo[] {
  return monsterList;
}

/** 怪物 key → 一行（查不到返回 null，由调用方决定显示什么） */
export function monsterInfo(id: string): MonsterInfo | null {
  if (!id) return null;
  return monsterList.find((row) => row.id === id) ?? null;
}

/** 怪物 key → 图标（`monster_presentation` 表；数值在 `monsters` 表） */
export function monsterIcon(id: string): string {
  return monsterIconOf.get(id) ?? "";
}

/** 怪物 key → 外观图集目录（`monster/out/<key>`；管理端帧动画预览用，缺演示行返回空串） */
export function monsterOut(id: string): string {
  return monsterOutOf.get(id) ?? "";
}

/** 全部 NPC（按编号；同一批「未激活」的也照实列出来 —— 地图上引用得到就选得到） */
export function npcRows(): NpcInfo[] {
  return npcList;
}

/** NPC 编号 → 一行（查不到返回 null） */
export function npcInfo(id: string): NpcInfo | null {
  if (!id) return null;
  return npcList.find((row) => row.id === id) ?? null;
}

//#endregion

//#region 纯规则（不是数据：客户端资源路径的约定）

/**
 * 地图预览图（小地图弹窗用的那张底图）
 *
 * 路径规则来自客户端 `configs/layout/images.ts` 的 `mapPreviewImage`：`map/<id>/preview`，
 * 磁盘上是 **.jpg**（不是 png）—— 所以取图时要带扩展名，直接按默认 png 拼会 404。
 */
export function mapPreview(id: string): string {
  return id ? `map/${id}/preview` : "";
}

/**
 * 角色头像：按「职业-性别」取图（`ui/avatar/<occupation>-<sex>.png`）
 *
 * 同样是客户端的取图规则（`configs/layout/images.ts` 的 `avatarImage`）。
 * 注意：角色数据里的 `avatar`（数字）是**头像编号**，不是这张图的下标 ——
 * 客户端 HUD 头像一直按职业 + 性别取，所以这里也按这两个字段取，不去索引数字。
 */
export function avatarPath(occupation: string, sex: string): string {
  if (!occupation || !sex) return "";
  return `ui/avatar/${occupation}-${sex}`;
}

//#endregion
