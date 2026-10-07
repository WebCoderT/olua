import { EQUIPMENT_PREFIX, Equipment } from "../types/good";
import type { CustomLightAssignment, LightAssignment, LightResource } from "../types/light";
import { getEquipmentBaseKey } from "./equipments";

/**
 * 装备光柱（装备掉在地上时的品质光效）
 *
 * 素材：resources/effect/light 下 6 个帧序列目录（各 14~15 帧循环，400×400 画布），
 * 显示在地面掉落物的装备图标上（唯一挂点 = GameUiHelper.createDropItem，见 applyEquipmentLight）——
 * 光柱画在**图标下层**（图标压住光柱中心，光柱从四周透出，物品本身始终清晰可辨）。
 * 光柱的取用优先级：**特殊装备的自定义表 → 前缀表**，都没命中就不显示（非装备一律不显示）。
 *
 * 前缀表用 **1~5 号**：5 个前缀各一个，按强度升序（普通的 → 超神的），越强的装备光柱越炫。
 * **6 号光柱预留给特殊装备**：写进 customEquipmentLightData 即生效（某件装备单独换用 6 号）。
 *
 * 想换某个前缀的光柱 / 给特殊装备配光柱，只改下面这两张表。
 */

/**
 * 光柱素材目录编号（resources/effect/light/<编号>；与磁盘目录一一对应，
 * 增删光柱改这里，test-equipment-light.cjs 会拿它与磁盘实际目录比对，写错会当场报出来）
 */
const lightSerials: number[] = [1, 2, 3, 4, 5, 6];

/** 光柱资源表（数组为源 + 尾部建 Map）：key = `light/<编号>`，dir = resources 加载路径 */
export const lightResources: LightResource[] = lightSerials.map((serial) => ({
  key: `light/${serial}`,
  dir: `effect/light/${serial}`,
}));

/** 光柱 key → 资源（按 key 查表用；查不到 = 配置写错了，显示层会安静跳过） */
export const lights = new Map<string, LightResource>();
lightResources.forEach((resource) => lights.set(resource.key, resource));

/**
 * 前缀 → 光柱（5 个前缀各一个，数组顺序即强度升序：普通的 → 超神的；想换光柱只改这张表）
 */
const prefixLightData: LightAssignment[] = [
  { prefix: EQUIPMENT_PREFIX.NORMAL, light: "light/1" },
  { prefix: EQUIPMENT_PREFIX.STRENGTHENED, light: "light/2" },
  { prefix: EQUIPMENT_PREFIX.FINE, light: "light/3" },
  { prefix: EQUIPMENT_PREFIX.SUPERB, light: "light/4" },
  { prefix: EQUIPMENT_PREFIX.GODLY, light: "light/5" },
];

/** 前缀 → 光柱 key（按前缀查表用） */
export const prefixLights = new Map<EQUIPMENT_PREFIX, string>();
prefixLightData.forEach((assignment) => prefixLights.set(assignment.prefix, assignment.light));

/**
 * 特殊装备的自定义光柱（key = 物品 id 或基础件 key；**优先于**前缀表；6 号光柱留给它用）
 *
 * · 写变体 id（如 weapon_20_p4s2）→ 只有那一个变体生效；
 * · 写基础件 key（如 weapon_20）→ 该装备的**全部**前后缀变体都生效；
 * · light 写了没登记的 key = 配置错误：回退前缀表并留一条可查日志（不让光柱整个消失）。
 */
const customEquipmentLightData: CustomLightAssignment[] = [
  // 示例（去掉注释即生效）：焚世巨剑（含全部前后缀变体）改用预留的 6 号光柱
  // { equipment: "weapon_20", light: "light/6" },
];

/** 物品 id / 基础件 key → 光柱 key（按装备查表用） */
export const customEquipmentLights = new Map<string, string>();
customEquipmentLightData.forEach((assignment) => customEquipmentLights.set(assignment.equipment, assignment.light));

/**
 * 取装备在地面上应显示的光柱 key（不显示返回 null）
 *
 * 1. 自定义表：先按物品 id 精确命中，再按基础件 key 命中（命中但光柱未登记 = 配置错误，回退前缀表）；
 * 2. 前缀表：按 equipment.prefix 查（前缀异常时查不到，返回 null 不显示）。
 *
 * 只读装备对象自带的 prefix / id（掉落物解析出的物品都带 id），不反查总表
 */
export function getEquipmentLightKey(equipment: Equipment | null | undefined): string | null {
  if (!equipment) return null;
  const id = equipment.id ?? "";
  const custom = customEquipmentLights.get(id) ?? customEquipmentLights.get(getEquipmentBaseKey(id));
  if (custom) {
    if (lights.has(custom)) return custom;
    console.warn(`[light] 自定义光柱未登记：${id} → ${custom}，回退前缀表`);
  }
  return prefixLights.get(equipment.prefix) ?? null;
}

/**
 * 前缀表用到的全部光柱资源（去重、按登记顺序）
 * 预加载用（见 ui/core/PreloadManager）：进图前把它们全部载入，掉落物一生成光柱就在
 */
export function getAssignedLights(): LightResource[] {
  const result: LightResource[] = [];
  prefixLightData.forEach((assignment) => {
    const resource = lights.get(assignment.light);
    if (resource && !result.some((item) => item.key === resource.key)) result.push(resource);
  });
  return result;
}
