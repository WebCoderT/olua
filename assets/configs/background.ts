import { EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX, Equipment } from "../types/good";
import type { CustomDetailBackgroundAssignment, DetailBackgroundAssignment, DetailBackgroundResource } from "../types/background";
import { getEquipmentBaseKey } from "./equipments";

/**
 * 装备详情背景（品质背景动画）
 *
 * 素材：resources/backgrounds 下 41 个帧序列目录（每个目录 6~20 帧 png，整包循环），
 * 播放在物品详情弹窗自身的精灵上（唯一挂点 = GameUiHelper.createGoodDetailDialog，见 applyEquipmentDetailBackground）。
 * 背景的取用优先级：**特殊装备的自定义表 → 前后缀组合表**，都没命中就保持弹窗的静态底图。
 *
 * 前后缀组合表用的是**前 15 个**（sfx_16000 ~ sfx_16014）：5 个前缀 × 3 个后缀 = 15 种组合各一个，
 * 按强度升序（先按后缀分三档、档内按前缀递增）。剩下的 26 个暂不分配，
 * 留给「某件特殊装备单独配详情背景」用（写进 customEquipmentDetailBackgroundData 即生效）。
 *
 * 想换某个组合的背景 / 给特殊装备配背景，只改下面这两张表。
 */

/**
 * 背景帧序列目录编号（resources/backgrounds/sfx_<编号>_0；与磁盘目录一一对应，增删背景改这里，
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

/** 背景资源表（数组为源 + 尾部建 Map）：key = 帧序列目录名，dir = resources 加载路径 */
export const detailBackgroundResources: DetailBackgroundResource[] = detailBackgroundSerials.map((serial) => ({
  key: `sfx_${serial}`,
  dir: `backgrounds/sfx_${serial}`,
}));

/** 背景 key → 资源（按 key 查表用；查不到 = 配置写错了，显示层会安静跳过） */
export const detailBackgrounds = new Map<string, DetailBackgroundResource>();
detailBackgroundResources.forEach((resource) => detailBackgrounds.set(resource.key, resource));

/**
 * 前后缀组合 → 详情背景（15 种组合各一个；想换背景只改这张表）
 *
 * 顺序按强度升序：先按后缀分「人级 / 天级 / 神级」三档，档内按前缀「普通的 → 超神的」递增，
 * 依次取前 15 个背景 —— 于是每个后缀档独占连续 5 个，前后缀越强背景越靠后。
 */
const prefixSuffixDetailBackgroundData: DetailBackgroundAssignment[] = [
  // —— 人级（后缀 0）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.MORTAL, background: "sfx_16000" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.MORTAL, background: "sfx_16001" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.MORTAL, background: "sfx_16002" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.MORTAL, background: "sfx_16003" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.MORTAL, background: "sfx_16004" },
  // —— 天级（后缀 1）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.HEAVEN, background: "sfx_16005" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.HEAVEN, background: "sfx_16006" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.HEAVEN, background: "sfx_16007" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.HEAVEN, background: "sfx_16008" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.HEAVEN, background: "sfx_16009" },
  // —— 神级（后缀 2）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.GODLY, background: "sfx_16010" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.GODLY, background: "sfx_16011" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.GODLY, background: "sfx_16012" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.GODLY, background: "sfx_16013" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.GODLY, background: "sfx_16014" },
];

/** 前后缀组合 → 背景 key（键 = `${prefix}|${suffix}`；按组合查表用） */
export const prefixSuffixDetailBackgrounds = new Map<string, string>();
prefixSuffixDetailBackgroundData.forEach((assignment) => prefixSuffixDetailBackgrounds.set(`${assignment.prefix}|${assignment.suffix}`, assignment.background));

/**
 * 特殊装备的自定义详情背景（key = 物品 id 或基础件 key；**优先于**前后缀表，剩下的 26 个背景留给它用）
 *
 * · 写变体 id（如 weapon_20_p4s2）→ 只有那一个变体生效；
 * · 写基础件 key（如 weapon_20）→ 该装备的**全部**前后缀变体都生效；
 * · background 写了没登记的 key = 配置错误：回退前后缀表并留一条可查日志（不让背景整个消失）。
 */
const customEquipmentDetailBackgroundData: CustomDetailBackgroundAssignment[] = [
  // 示例（去掉注释即生效）：焚世巨剑（含全部前后缀变体）改用编号最大的背景
  // { equipment: "weapon_20", background: "sfx_16040" },
];

/** 物品 id / 基础件 key → 背景 key（按装备查表用） */
export const customEquipmentDetailBackgrounds = new Map<string, string>();
customEquipmentDetailBackgroundData.forEach((assignment) => customEquipmentDetailBackgrounds.set(assignment.equipment, assignment.background));

/**
 * 取装备详情应显示的背景 key（不显示返回 null，详情弹窗保持静态底图）
 *
 * 1. 自定义表：先按物品 id 精确命中，再按基础件 key 命中（命中但背景未登记 = 配置错误，回退前后缀表）；
 * 2. 前后缀组合表：按 `${prefix}|${suffix}` 查（前后缀异常时查不到，返回 null 不显示）。
 *
 * 只读装备对象自带的 prefix / suffix / id（背包、装备槽解析出的物品都带 id），不反查总表
 */
export function getEquipmentDetailBackgroundKey(equipment: Equipment | null | undefined): string | null {
  if (!equipment) return null;
  const id = equipment.id ?? "";
  const custom = customEquipmentDetailBackgrounds.get(id) ?? customEquipmentDetailBackgrounds.get(getEquipmentBaseKey(id));
  if (custom) {
    if (detailBackgrounds.has(custom)) return custom;
    console.warn(`[detail-background] 自定义详情背景未登记：${id} → ${custom}，回退前后缀表`);
  }
  return prefixSuffixDetailBackgrounds.get(`${equipment.prefix}|${equipment.suffix}`) ?? null;
}

/**
 * 前后缀组合表用到的全部背景资源（去重、按登记顺序）
 * 预加载用（见 ui/core/PreloadManager）：进图前把它们全部载入，详情弹窗一开背景动画就在
 */
export function getAssignedDetailBackgrounds(): DetailBackgroundResource[] {
  const result: DetailBackgroundResource[] = [];
  prefixSuffixDetailBackgroundData.forEach((assignment) => {
    const resource = detailBackgrounds.get(assignment.background);
    if (resource && !result.some((item) => item.key === resource.key)) result.push(resource);
  });
  return result;
}
