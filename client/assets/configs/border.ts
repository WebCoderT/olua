import { Equipment } from "../types/good";
import type { BorderAssignment, BorderResource, CustomBorderAssignment } from "../types/border";
import { getEquipmentBaseKey } from "./equipments";

/**
 * 装备边框（品质光效框）
 *
 * 素材：resources/borders 下 84 张图集（plist + 同名 png，整包 8~12 帧循环），
 * 显示在背包格子与身上装备槽的物品图标上（唯一挂点 = GameUiHelper.createGood，见 applyEquipmentBorder）。
 *
 * ## #695：映射表搬到服务端了
 * 「哪个前后缀组合用哪个边框」「哪件特殊装备单独用哪个」是**运营内容**，来自配置快照的
 * `equipmentAppearance` 段（出厂值在 `server/src/common/constants/equipment-appearance`，
 * 运营在管理端「装备外观」页改），由 `applyEquipmentAppearance()` 重建两张映射。
 * 快照到达前映射是**空的** —— 边框整个不显示（与音效 / 引导同一口径：没有本地兜底表）。
 *
 * 本文件保留的是**客户端自己的那一半**：
 * - **资源清单**（`borderSerials` → `borderResources`）：哪些边框图集存在是与磁盘文件
 *   一一对应的资源约定，`test-equipment-border.cjs` 会拿它与磁盘实际文件比对，写错当场报；
 * - key → 资源的解析（`borders` Map）：服务端下发的 key 在这里查资源，查不到 = 配置写错了
 *   （管理端填了资源包里没有的编号），显示层安静跳过并留日志。
 *
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
 * 前后缀组合 → 边框 key（键 = `${prefix}|${suffix}`）
 *
 * 快照到达前为空（#695：映射来自服务端，见文件头）；`applyEquipmentAppearance()` 重建。
 */
export const prefixSuffixBorders = new Map<string, string>();

/**
 * 特殊装备的自定义边框（key = 物品 id 或基础件 key；**优先于**前后缀表）
 *
 * 快照到达前为空（#695）；`applyEquipmentAppearance()` 重建。
 */
export const customEquipmentBorders = new Map<string, string>();

/**
 * 应用快照的 `equipmentAppearance` 段（`apply-snapshot` 用）—— 重建两张映射
 *
 * 只认「**格式合法且在资源清单里**」的边框 key：服务端 DTO 已按 key 格式校验过一遍，
 * 这里再卡「资源清单里真的有」——「配了资源包里没有的编号」的后果是**整个边框消失**
 * （图集加载失败），与其到进背包才看到光效缺一块，不如在这里丢弃并留日志。
 * 组合覆盖度（15 条是否齐全）由服务端保证：缺的组合查不到映射，边框不显示 ——
 * 那是合法的配置状态（运营想关掉某个品质的边框就少配一条……服务端现在卡全覆盖，
 * 真要支持得在管理端加「不显示」语义，别在这里偷偷兜）。
 */
export function applyEquipmentAppearance(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const source = data as Record<string, unknown>;

  // —— 前后缀映射表 ——
  prefixSuffixBorders.clear();
  if (Array.isArray(source.borders)) {
    for (const row of source.borders) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const prefix = Number(item.prefix);
      const suffix = Number(item.suffix);
      const key = typeof item.key === "string" ? item.key : "";
      if (!borders.has(key)) {
        if (key) console.warn(`[border] 跳过组合 ${prefix}|${suffix}：边框「${key}」不在客户端资源清单里`);
        continue;
      }
      prefixSuffixBorders.set(`${prefix}|${suffix}`, key);
    }
  }

  // —— 特殊装备自定义表 ——
  customEquipmentBorders.clear();
  if (Array.isArray(source.customBorders)) {
    for (const row of source.customBorders) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const equipment = typeof item.equipment === "string" ? item.equipment : "";
      const key = typeof item.key === "string" ? item.key : "";
      if (!equipment) continue;
      if (!borders.has(key)) {
        console.warn(`[border] 跳过自定义 ${equipment}：边框「${key}」不在客户端资源清单里`);
        continue;
      }
      customEquipmentBorders.set(equipment, key);
    }
  }
}

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
  prefixSuffixBorders.forEach((key) => {
    const resource = borders.get(key);
    if (resource && !result.some((item) => item.key === resource.key)) result.push(resource);
  });
  return result;
}

/** 类型再出口（历史 import 路径兼容：`configs/border` 曾是这些类型的唯一出口） */
export type { BorderAssignment, BorderResource, CustomBorderAssignment };
