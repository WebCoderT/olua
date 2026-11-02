/**
 * 成长底座（#603 第九域起只剩「运行时表 + 取样函数」）
 *
 * 这个文件历史上换过两次主人：
 * - #361 时代它是全角色数值的唯一来源（曲线 / 标量 / 属性派生全手写在客户端）；
 * - #590 起曲线、标量、等级表、三条成长线搬去服务端种子，客户端只剩「装备前后缀倍率 +
 *   回收价曲线 + roleMaxLevel」三样客户端常量；
 * - **#603 第九域起连那三样也不在客户端了**：倍率、品质文案、回收价曲线的唯一书写处是
 *   `server/src/shared/equipment-seed.ts`（→ `equipment_meta` 表，管理端可改），
 *   进游戏由配置快照 `equipmentMeta` 段下发，本文件只剩空运行时表 + 一段取样算术。
 *
 * 所以这里**一个数字都不许再写**：想调倍率 / 回收价 / 等级上限，改服务端种子或管理端。
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

/**
 * 在分段线性曲线上取某等级的值（目前只服务回收价曲线；超出最后一段按最后一段斜率外推）
 *
 * 服务端 `equipment-seed.sampleEquipmentCurve` 是同一段算术（两端各写一份是因为
 * 服务端不能 import 客户端代码）—— 改这里必须同步改那边，判据是
 * `test-equipment-recycle` 里「客户端与服务端取价逐级相同」那组断言。
 */
export function sampleGrowth(segments: GrowthSegment[], level: number): number {
  if (level <= 0 || segments.length === 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/**
 * 装备前缀属性倍率（下标 = EQUIPMENT_PREFIX 序号）
 *
 * **空数组 = 快照还没到**：此时 `buildEquipmentMap` 展开不出任何变体（装备表整个是空的）。
 * 正常路径上 `Loading` 场景的 `loadGameConfig()` 在进场景前 await 过（#604 起拿不到就不让进图），玩家看不到空表。
 */
export let equipmentPrefixRates: number[] = [];

/** 装备后缀属性倍率（下标 = EQUIPMENT_SUFFIX 序号）；空数组的含义同上 */
export let equipmentSuffixRates: number[] = [];

/** 装备回收价的成长曲线（背包「一键回收」与卖装备结算的计价依据）；空数组 = 快照没到 */
export let equipmentRecycleCurve: GrowthSegment[] = [];

/**
 * 装载装备规则（`configs/apply-snapshot` 调；快照 `equipmentMeta` 段）
 *
 * 只收正数倍率（≤ 0 或非数字会让变体属性变成 0 或负数，比「没升级」更糟）；
 * 曲线按原样收（取样函数自己处理越界）。
 */
export function applyEquipmentRules(prefixRates: number[], suffixRates: number[], recycleCurve: GrowthSegment[]): void {
  equipmentPrefixRates = (prefixRates || []).map((rate) => Number(rate)).filter((rate) => Number.isFinite(rate) && rate > 0);
  equipmentSuffixRates = (suffixRates || []).map((rate) => Number(rate)).filter((rate) => Number.isFinite(rate) && rate > 0);
  equipmentRecycleCurve = (recycleCurve || []).map((segment) => ({
    from: Number(segment.from) || 0,
    to: Number(segment.to) || 0,
    start: Number(segment.start) || 0,
    perLevel: Number(segment.perLevel) || 0,
  }));
}

/**
 * 取某等级装备的回收基础价（普通·人级；前后缀倍率由调用方乘上）
 *
 * 曲线来自服务端（`equipmentMeta.recycleCurve`）—— 快照没到时返回 0，
 * **不兜一份本地曲线**（那等于又造一份价格真相，正是 #603 要消掉的东西）。
 */
export function equipmentRecyclePrice(level: number): number {
  return Math.max(0, Math.round(sampleGrowth(equipmentRecycleCurve, level)));
}
