import { sys } from "cc";
import type { BagRecycleSelection } from "../../../configs/items";

/**
 * 自动回收 / 自动使用 / 自动穿戴的勾选偏好（#1278）
 *
 * 三份勾选都是**本机偏好**（用户拍板）：存 `sys.localStorage`、按角色 id 分键 ——
 * 换设备或清缓存后要重新勾一遍，这是接受的代价（不为此动服务端存档）。
 *
 * 存的是「勾了什么」，**不是**游戏数据：真正的回收 / 使用 / 穿戴照旧走服务端权威接口，
 * 这里只影响「客户端要不要替玩家做」。解析失败（手改 / 版本变更）一律回落全不勾 ——
 * 宁可让玩家重新勾，也不替他多勾一样东西。
 */

/** localStorage 键前缀（按角色分键：`<前缀>:<roleId>`） */
const KEY_PREFIX = "auto_bag_prefs";

/** 一份角色的全部勾选（落盘形状） */
interface AutoBagPrefsBlob {
  /** 自动回收勾选：全部装备开关 + 非装备 id 列表 */
  recycle?: { allEquipment?: boolean; ids?: unknown };
  /** 自动使用勾选的非装备 id 列表 */
  use?: unknown;
  /** 自动穿戴开关 */
  autoWear?: boolean;
}

/** 未知形状安全地读成 string[]（只收字符串元素，其余丢弃） */
function stringListOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** 读某角色的整份偏好（没有 / 坏了回落全不勾） */
function readBlob(roleId: string): AutoBagPrefsBlob {
  if (!roleId) return {};
  try {
    const raw = sys.localStorage.getItem(`${KEY_PREFIX}:${roleId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AutoBagPrefsBlob;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 写某角色的整份偏好（落盘失败静默 —— 偏好丢了不影响玩法，只影响便利） */
function writeBlob(roleId: string, blob: AutoBagPrefsBlob): void {
  if (!roleId) return;
  try {
    sys.localStorage.setItem(`${KEY_PREFIX}:${roleId}`, JSON.stringify(blob));
  } catch {
    // 存储不可用（隐私模式 / 已满）：保持内存态，下次进来重新勾
  }
}

/** 自动回收勾选的默认值（全不勾 = 永不自动回收） */
export const DEFAULT_RECYCLE_SELECTION: BagRecycleSelection = { allEquipment: false, ids: new Set<string>() };

/** 读自动回收勾选（没有记录 = 全不勾） */
export function getRecycleSelection(roleId: string): BagRecycleSelection {
  const recycle = readBlob(roleId).recycle;
  if (!recycle || typeof recycle !== "object") return DEFAULT_RECYCLE_SELECTION;
  return { allEquipment: recycle.allEquipment === true, ids: new Set(stringListOf(recycle.ids)) };
}

/** 写自动回收勾选 */
export function setRecycleSelection(roleId: string, selection: BagRecycleSelection): void {
  writeBlob(roleId, { ...readBlob(roleId), recycle: { allEquipment: selection.allEquipment, ids: Array.from(selection.ids) } });
}

/** 读自动使用勾选的物品 id 集（没有记录 = 空集 = 永不自动使用） */
export function getUseIds(roleId: string): Set<string> {
  return new Set(stringListOf(readBlob(roleId).use));
}

/** 写自动使用勾选 */
export function setUseIds(roleId: string, ids: ReadonlySet<string>): void {
  writeBlob(roleId, { ...readBlob(roleId), use: Array.from(ids) });
}

/** 读自动穿戴开关（没有记录 = 关） */
export function getAutoWear(roleId: string): boolean {
  return readBlob(roleId).autoWear === true;
}

/** 写自动穿戴开关 */
export function setAutoWear(roleId: string, enabled: boolean): void {
  writeBlob(roleId, { ...readBlob(roleId), autoWear: enabled });
}
