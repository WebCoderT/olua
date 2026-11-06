import { Equipment } from "../types/good";
import type { AppearanceEffect } from "../types/appearance";
import type { CustomDetailBackgroundAssignment, DetailBackgroundAssignment, DetailBackgroundResource } from "../types/background";
import { getEquipmentBaseKey } from "./equipments";
import { DEFAULT_APPEARANCE_EFFECT, parseAppearanceEffect } from "./appearance";

/** 一条详情背景指派：用哪个帧序列目录（key）+ 怎么显示（effect，#700；缺省 = 铺满弹窗面板） */
export interface BackgroundPick {
  key: string;
  effect: AppearanceEffect;
}

/**
 * 装备详情背景（品质背景动画）
 *
 * 素材：resources/effect/background 下 41 张图集（bg-<编号>.plist + 同名 png，整包 6~20 帧循环），
 * 播放在物品详情弹窗自身的精灵上（唯一挂点 = GameUiHelper.createGoodDetailDialog，见 applyEquipmentDetailBackground）。
 *
 * ## #695：映射表搬到服务端了
 * 「哪个前后缀组合用哪个背景」「哪件特殊装备单独用哪个」是**运营内容**，来自配置快照的
 * `equipmentAppearance` 段（出厂值在 `server/src/common/constants/equipment-appearance`，
 * 运营在管理端「装备外观」页改），由 `applyEquipmentDetailBackgrounds()` 重建两张映射。
 * 快照到达前映射是**空的** —— 详情弹窗保持静态底图（没有本地兜底表）。
 *
 * 本文件保留的是**客户端自己的那一半**：
 * - **资源清单**（`detailBackgroundSerials` → `detailBackgroundResources`）：哪些背景帧序列
 *   目录存在是与磁盘文件一一对应的资源约定，`test-equipment-detail-background.cjs`
 *   会拿它与磁盘实际目录比对，写错当场报；
 * - key → 资源的解析（`detailBackgrounds` Map）：服务端下发的 key 在这里查资源，
 *   查不到 = 配置写错了（管理端填了资源包里没有的编号），显示层安静跳过并留日志。
 */

/**
 * 背景图集编号（resources/effect/background/bg-<编号>；与磁盘文件一一对应，增删背景改这里，
 * test-equipment-detail-background.cjs 会拿它与磁盘实际目录比对，写错会当场报出来）
 */
const detailBackgroundSerials: number[] = [
  // 288×132~139 横幅渐变带：16000 ~ 16008
  16000, 16001, 16002, 16003, 16004,
  16005, 16006, 16007, 16008,
  // ~307×214~280 场景框：16009 ~ 16014
  16009, 16010, 16011, 16012, 16013, 16014,
  // 竖幅大图与大场景（其余家族）：16015 ~ 16040
  16015, 16016, 16017, 16018, 16019, 16020,
  16021, 16022, 16023, 16024, 16025, 16026,
  16027, 16028, 16029, 16030, 16031, 16032,
  16033, 16034, 16035, 16036, 16037, 16038,
  16039, 16040,
];

/** 背景资源表（数组为源 + 尾部建 Map）：key = 图集名，dir = resources 加载路径（不含扩展名） */
export const detailBackgroundResources: DetailBackgroundResource[] = detailBackgroundSerials.map((serial) => ({
  key: `bg-${serial}`,
  dir: `effect/background/bg-${serial}`,
}));

/** 背景 key → 资源（按 key 查表用；查不到 = 配置写错了，显示层会安静跳过） */
export const detailBackgrounds = new Map<string, DetailBackgroundResource>();
detailBackgroundResources.forEach((resource) => detailBackgrounds.set(resource.key, resource));

/**
 * 前后缀组合 → 详情背景指派（键 = `${prefix}|${suffix}`；值带 effect，#700）
 *
 * 快照到达前为空（#695：映射来自服务端，见文件头）；`applyEquipmentDetailBackgrounds()` 重建。
 */
export const prefixSuffixDetailBackgrounds = new Map<string, BackgroundPick>();

/**
 * 特殊装备的自定义详情背景（key = 物品 id 或基础件 key；**优先于**前后缀表）
 *
 * 快照到达前为空（#695）；`applyEquipmentDetailBackgrounds()` 重建。
 */
export const customEquipmentDetailBackgrounds = new Map<string, BackgroundPick>();

/**
 * 应用快照的 `equipmentAppearance` 段（`apply-snapshot` 用）—— 重建两张映射
 *
 * 只认「**格式合法且在资源清单里**」的背景 key：服务端 DTO 已按 key 格式校验过一遍，
 * 这里再卡「资源清单里真的有」——「配了资源包里没有的编号」的后果是**背景动画消失**
 * （帧序列加载失败），与其到开详情弹窗才发现，不如在这里丢弃并留日志。
 * 组合覆盖度（15 条是否齐全）由服务端保证：缺的组合查不到映射，弹窗保持静态底图。
 */
export function applyEquipmentDetailBackgrounds(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const source = data as Record<string, unknown>;

  // —— 前后缀映射表 ——
  prefixSuffixDetailBackgrounds.clear();
  if (Array.isArray(source.backgrounds)) {
    for (const row of source.backgrounds) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const prefix = Number(item.prefix);
      const suffix = Number(item.suffix);
      const key = typeof item.key === "string" ? item.key : "";
      if (!detailBackgrounds.has(key)) {
        if (key) console.warn(`[detail-background] 跳过组合 ${prefix}|${suffix}：背景「${key}」不在客户端资源清单里`);
        continue;
      }
      // effect 坏只丢效果（回落默认），映射本身保留
      const effect = parseAppearanceEffect(item.effect, (message) => console.warn(`[detail-background] 组合 ${prefix}|${suffix} 的 ${message}`));
      prefixSuffixDetailBackgrounds.set(`${prefix}|${suffix}`, { key, effect: effect ?? DEFAULT_APPEARANCE_EFFECT });
    }
  }

  // —— 特殊装备自定义表 ——
  customEquipmentDetailBackgrounds.clear();
  if (Array.isArray(source.customBackgrounds)) {
    for (const row of source.customBackgrounds) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const equipment = typeof item.equipment === "string" ? item.equipment : "";
      const key = typeof item.key === "string" ? item.key : "";
      if (!equipment) continue;
      if (!detailBackgrounds.has(key)) {
        console.warn(`[detail-background] 跳过自定义 ${equipment}：背景「${key}」不在客户端资源清单里`);
        continue;
      }
      const effect = parseAppearanceEffect(item.effect, (message) => console.warn(`[detail-background] 自定义 ${equipment} 的 ${message}`));
      customEquipmentDetailBackgrounds.set(equipment, { key, effect: effect ?? DEFAULT_APPEARANCE_EFFECT });
    }
  }
}

/**
 * 解析装备详情应显示的背景指派（不显示返回 null，详情弹窗保持静态底图）
 *
 * 1. 自定义表：先按物品 id 精确命中，再按基础件 key 命中（命中但背景未登记 = 配置错误，回退前后缀表）；
 * 2. 前后缀组合表：按 `${prefix}|${suffix}` 查（前后缀异常时查不到，返回 null 不显示）。
 *
 * 只读装备对象自带的 prefix / suffix / id（背包、装备槽解析出的物品都带 id），不反查总表
 */
export function resolveEquipmentDetailBackground(equipment: Equipment | null | undefined): BackgroundPick | null {
  if (!equipment) return null;
  const id = equipment.id ?? "";
  const custom = customEquipmentDetailBackgrounds.get(id) ?? customEquipmentDetailBackgrounds.get(getEquipmentBaseKey(id));
  if (custom) {
    if (detailBackgrounds.has(custom.key)) return custom;
    console.warn(`[detail-background] 自定义详情背景未登记：${id} → ${custom.key}，回退前后缀表`);
  }
  return prefixSuffixDetailBackgrounds.get(`${equipment.prefix}|${equipment.suffix}`) ?? null;
}

/**
 * 取装备详情应显示的背景 key（不显示返回 null，详情弹窗保持静态底图）
 *
 * `resolveEquipmentDetailBackground` 的 key 快捷方式（渲染层要连 effect 一起拿，那个走 resolve）
 */
export function getEquipmentDetailBackgroundKey(equipment: Equipment | null | undefined): string | null {
  return resolveEquipmentDetailBackground(equipment)?.key ?? null;
}

/**
 * 前后缀组合表用到的全部背景资源（去重、按登记顺序）
 * 预加载用（见 ui/core/PreloadManager）：进图前把它们全部载入，详情弹窗一开背景动画就在
 */
export function getAssignedDetailBackgrounds(): DetailBackgroundResource[] {
  const result: DetailBackgroundResource[] = [];
  prefixSuffixDetailBackgrounds.forEach((pick) => {
    const resource = detailBackgrounds.get(pick.key);
    if (resource && !result.some((item) => item.key === resource.key)) result.push(resource);
  });
  return result;
}

/** 类型再出口（历史 import 路径兼容） */
export type { DetailBackgroundAssignment, DetailBackgroundResource, CustomDetailBackgroundAssignment };
