import { EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX, Equipment } from "../types/good";
import type { BorderAssignment, BorderResource, CustomBorderAssignment } from "../types/border";
import { getEquipmentBaseKey } from "./equipments";

/**
 * 装备边框（品质光效框）
 *
 * 素材：resources/borders 下 84 张图集（plist + 同名 png，整包 8~12 帧循环），
 * 显示在背包格子与身上装备槽的物品图标上（唯一挂点 = GameUiHelper.createGood，见 applyEquipmentBorder）。
 * 边框的取用优先级：**特殊装备的自定义表 → 前后缀组合表**，都没命中就不显示。
 *
 * 前后缀组合表用的是**前 15 张**（sfx_30123_0 ~ sfx_30137_0）：5 个前缀 × 3 个后缀 = 15 种组合各一张，
 * 按强度升序（先按后缀分三档、档内按前缀递增）。剩下的 69 张暂不分配，
 * 留给「某件特殊装备单独配边框」用（写进 customEquipmentBorderData 即生效）。
 *
 * 想换某个组合的边框 / 给特殊装备配边框，只改下面这两张表；
 * 素材长什么样见 tools/border-preview.png（编号索引图，重新生成方式见该目录下的说明）。
 */

/**
 * 边框图集编号（resources/borders/sfx_<编号>_0；与磁盘文件一一对应，增删边框改这里，
 * test-equipment-border.cjs 会拿它与磁盘实际文件比对，写错会当场报出来）
 */
const borderSerials: number[] = [
  // 91×104 厚框（带星点）：30123 ~ 30134
  30123, 30124, 30125, 30126, 30127, 30128,
  30129, 30130, 30131, 30132, 30133, 30134,
  // 200×200 细裂纹框：30135 ~ 30146
  30135, 30136, 30137, 30138, 30139, 30140,
  30141, 30142, 30143, 30144, 30145, 30146,
  // 80×80 框：30147 ~ 30158
  30147, 30148, 30149, 30150, 30151, 30152,
  30153, 30154, 30155, 30156, 30157, 30158,
  // 200×200 框（张数最多的家族）：30159 ~ 30182
  30159, 30160, 30161, 30162, 30163, 30164,
  30165, 30166, 30167, 30168, 30169, 30170,
  30171, 30172, 30173, 30174, 30175, 30176,
  30177, 30178, 30179, 30180, 30181, 30182,
  // 98×92 框：30183 ~ 30194
  30183, 30184, 30185, 30186, 30187, 30188,
  30189, 30190, 30191, 30192, 30193, 30194,
  // 89×88 框：30195 ~ 30206
  30195, 30196, 30197, 30198, 30199, 30200,
  30201, 30202, 30203, 30204, 30205, 30206,
];

/** 边框资源表（数组为源 + 尾部建 Map）：key = 图集文件名，atlas = resources 加载路径 */
export const borderResources: BorderResource[] = borderSerials.map((serial) => ({
  key: `sfx_${serial}_0`,
  atlas: `borders/sfx_${serial}_0`,
}));

/** 边框 key → 资源（按 key 查表用；查不到 = 配置写错了，显示层会安静跳过） */
export const borders = new Map<string, BorderResource>();
borderResources.forEach((resource) => borders.set(resource.key, resource));

/**
 * 前后缀组合 → 边框（15 种组合各一张；想换边框只改这张表）
 *
 * 顺序按强度升序：先按后缀分「人级 / 天级 / 神级」三档，档内按前缀「普通的 → 超神的」递增，
 * 依次取前 15 张边框 —— 于是每个后缀档独占连续 5 张，前后缀越强边框越靠后。
 */
const prefixSuffixBorderData: BorderAssignment[] = [
  // —— 人级（后缀 0）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.MORTAL, border: "sfx_30123_0" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.MORTAL, border: "sfx_30124_0" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.MORTAL, border: "sfx_30125_0" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.MORTAL, border: "sfx_30126_0" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.MORTAL, border: "sfx_30127_0" },
  // —— 天级（后缀 1）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.HEAVEN, border: "sfx_30128_0" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.HEAVEN, border: "sfx_30129_0" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.HEAVEN, border: "sfx_30130_0" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.HEAVEN, border: "sfx_30131_0" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.HEAVEN, border: "sfx_30132_0" },
  // —— 神级（后缀 2）：普通 → 超神 ——
  { prefix: EQUIPMENT_PREFIX.NORMAL, suffix: EQUIPMENT_SUFFIX.GODLY, border: "sfx_30133_0" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, suffix: EQUIPMENT_SUFFIX.GODLY, border: "sfx_30134_0" },
  { prefix: EQUIPMENT_PREFIX.FINE, suffix: EQUIPMENT_SUFFIX.GODLY, border: "sfx_30135_0" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, suffix: EQUIPMENT_SUFFIX.GODLY, border: "sfx_30136_0" },
  { prefix: EQUIPMENT_PREFIX.GODLY, suffix: EQUIPMENT_SUFFIX.GODLY, border: "sfx_30137_0" },
];

/** 前后缀组合 → 边框 key（键 = `${prefix}|${suffix}`；按组合查表用） */
export const prefixSuffixBorders = new Map<string, string>();
prefixSuffixBorderData.forEach((assignment) => prefixSuffixBorders.set(`${assignment.prefix}|${assignment.suffix}`, assignment.border));

/**
 * 特殊装备的自定义边框（key = 物品 id 或基础件 key；**优先于**前后缀表，剩下的 69 张边框留给它用）
 *
 * · 写变体 id（如 weapon_20_p4s2）→ 只有那一个变体生效；
 * · 写基础件 key（如 weapon_20）→ 该装备的**全部**前后缀变体都生效；
 * · border 写了没登记的 key = 配置错误：回退前后缀表并留一条可查日志（不让边框整个消失）。
 */
const customEquipmentBorderData: CustomBorderAssignment[] = [
  // 示例（去掉注释即生效）：焚世巨剑（含全部前后缀变体）改用编号最大的边框
  // { equipment: "weapon_20", border: "sfx_30206_0" },
];

/** 物品 id / 基础件 key → 边框 key（按装备查表用） */
export const customEquipmentBorders = new Map<string, string>();
customEquipmentBorderData.forEach((assignment) => customEquipmentBorders.set(assignment.equipment, assignment.border));

/**
 * 取装备应显示的边框 key（不显示返回 null）
 *
 * 1. 自定义表：先按物品 id 精确命中，再按基础件 key 命中（命中但边框未登记 = 配置错误，回退前后缀表）；
 * 2. 前后缀组合表：按 `${prefix}|${suffix}` 查（前后缀异常时查不到，返回 null 不显示）。
 *
 * 只读装备对象自带的 prefix / suffix / id（背包、装备槽解析出的物品都带 id），不反查总表
 */
export function getEquipmentBorderKey(equipment: Equipment | null | undefined): string | null {
  if (!equipment) return null;
  const id = equipment.id ?? "";
  const custom = customEquipmentBorders.get(id) ?? customEquipmentBorders.get(getEquipmentBaseKey(id));
  if (custom) {
    if (borders.has(custom)) return custom;
    console.warn(`[border] 自定义边框未登记：${id} → ${custom}，回退前后缀表`);
  }
  return prefixSuffixBorders.get(`${equipment.prefix}|${equipment.suffix}`) ?? null;
}

/**
 * 前后缀组合表用到的全部边框资源（去重、按登记顺序）
 * 预加载用（见 ui/core/PreloadManager）：进图前把它们全部载入，背包/角色弹窗一开边框就在
 */
export function getAssignedBorders(): BorderResource[] {
  const result: BorderResource[] = [];
  prefixSuffixBorderData.forEach((assignment) => {
    const resource = borders.get(assignment.border);
    if (resource && !result.some((item) => item.key === resource.key)) result.push(resource);
  });
  return result;
}
