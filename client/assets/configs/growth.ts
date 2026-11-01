/**
 * 成长底座（#590 起客户端只剩「装备前后缀倍率 + 回收价曲线」这几个**客户端常量**）
 *
 * #361 时代这里是全角色的数值唯一来源（曲线 / 标量 / 属性派生都在这份文件里手写），
 * #590 起归属翻转：曲线、标量、等级表、三条成长线的**唯一书写处**在
 * `server/src/shared/growth-seed.ts`（以及 title/soul/rank-seed），管理端可改，
 * 客户端经快照 `levels` 段拿最终值（configs/level 的 levelMap）。
 *
 * 留在这里的三样东西：
 * - **装备前后缀倍率**：客户端把服务端下发的基础件展开成 15 个变体要用
 *   （applyEquipmentRows 与 buildEquipmentMap 同口径，服务端生成物里也有一份对账）；
 * - **装备回收价曲线**：背包「一键回收」的计价（归属装备批次再收）；
 * - **roleMaxLevel**：等级上限的运行时值（快照 growthScalars 里的 roleMaxLevel 覆写，
 *   见 configs/apply-snapshot）—— UI 的「等级/上限」判断直接读它。
 *
 * 想调血量 / 攻防 / 升级节奏 / 军衔强度，改服务端种子或管理端，**不要在这里写数字**。
 */

/** 一条分段线性曲线的一档：档内按等级线性增长，档间靠 perLevel 跳档 */
export interface GrowthSegment {
  /** 起始等级（含） */
  from: number;
  /** 结束等级（含） */
  to: number;
  /** 该档起始等级（from）的值 */
  start: number;
  /** 该档内每升一级的增量 */
  perLevel: number;
}

/**
 * 角色等级上限（**可变**：快照 growthScalars 的 roleMaxLevel 覆写）
 *
 * 用 `let` 而不是 getter，是为了让消费方的 `if (role.level >= roleMaxLevel)` 这类写法一行都不用改。
 * #590 起等级表本身由快照 `levels` 段整表下发，这里的值只影响「读表的边界判断」；
 * 快照没到时保持出厂值 60，进游戏后即被服务端值覆盖。
 */
export let roleMaxLevel = 60;

/**
 * 改等级上限（**唯一写入口**）
 *
 * ESM 的导入绑定是只读的，`apply-snapshot` 不能直接给 `roleMaxLevel` 赋值 ——
 * 收一个函数在这里，写入点就还是「只有 growth.ts 自己能改这个数」。
 */
export function setRoleMaxLevel(level: number): void {
  roleMaxLevel = Math.max(1, Math.floor(level));
}

/** 在分段线性曲线上取某等级的值（目前只服务回收价曲线；超出最后一段按最后一段斜率外推） */
export function sampleGrowth(segments: GrowthSegment[], level: number): number {
  if (level <= 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/**
 * 装备前缀属性倍率（下标 = EQUIPMENT_PREFIX 序号）
 * 普通的 / 强化的 / 精良的 / 极品的 / 超神的
 */
export const equipmentPrefixRates = [1, 1.1, 1.2, 1.3, 1.4] as const;

/**
 * 装备后缀属性倍率（下标 = EQUIPMENT_SUFFIX 序号）
 * 人级 / 天级 / 神级
 */
export const equipmentSuffixRates = [1, 2, 3] as const;

/**
 * 装备回收价的成长曲线（背包「一键回收」的计价唯一来源，货币 = **绑定元宝**）
 *
 * 与装备属性同一口径，**只按装备自己的 level 取基础价**（普通·人级 的价），
 * 前后缀变体再乘对应倍率（equipmentPrefixRates × equipmentSuffixRates，最高 4.2 倍），
 * 在 configs/equipments.buildEquipmentMap 里生成；快照覆写时服务端下发的行
 * 也按「服务端等级 × 同一曲线」重算（applyEquipmentRows）。
 * 归属备注：这是装备定价数据，随装备批次（#590 之后）再决定是否搬服务端。
 *
 * 量级参考：升满战魂合计约 527 万绑定元宝（300 × Σn²，n = 1..37，见 server/src/shared/soul-seed），
 * 角色出生带 1 万。当前曲线下 60 级基础装备回收约 4 万，1 级装备 10（新手装直接丢掉不心疼）。
 */
export const equipmentRecyclePriceCurve: GrowthSegment[] = [
  { from: 1, to: 10, start: 10, perLevel: 5 }, // 1 级 10 → 10 级 55
  { from: 11, to: 20, start: 60, perLevel: 20 }, // 20 级 240
  { from: 21, to: 30, start: 260, perLevel: 70 }, // 30 级 890
  { from: 31, to: 40, start: 960, perLevel: 270 }, // 40 级 3,390
  { from: 41, to: 50, start: 3600, perLevel: 840 }, // 50 级 11,160
  { from: 51, to: 60, start: 12000, perLevel: 3100 }, // 60 级 39,900
];

/** 取某等级装备的回收基础价（普通·人级；前后缀倍率由 configs/equipments 乘上） */
export function equipmentRecyclePrice(level: number): number {
  return Math.max(0, Math.round(sampleGrowth(equipmentRecyclePriceCurve, level)));
}
