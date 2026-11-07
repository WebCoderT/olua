/**
 * 角色等级曲线（#786：等级上限扩到 100 万级）
 *
 * ## 为什么从「逐行表」改成「段参数」
 * #655 把等级存成 `role_levels` 一行一级（60 行）。到 100 万级时：
 * - `config-sync.sql` 要 1.5 GB、快照 JSON 要 250 MB —— 传输与仓库都装不下；
 * - 服务端/客户端各要 100 万个属性对象（各几百 MB），手机端必崩；
 * - 而且原曲线是「每 10 级 ×3.28」的指数型，外推到 100 万级直接 `Infinity`。
 *
 * 所以等级改回**参数化**：库里只存「段」（起始等级 / 结束等级 / 起始值 / 每级增量 /
 * 每级增量的增量），运行时按需求值。24 行参数完整复现原来 60 行的每一级数值
 * （见 `ROLE_LEVEL_CURVE_SEEDS`，`e2e-level-curve` 逐级比对守着）。
 *
 * ## 只有 4 条独立曲线
 * 原来 16 列里有一半是派生的，且 1..60 级实测**精确成立**（不是近似）：
 * - `max_mp        = round(hp / 2)`
 * - `hp_recover    = round(hp / 100)`
 * - `attack_min    = round(attack_max * 0.7)`，三系攻（物/魔/道）同值
 * - `defense_min   = round(defense_max * 0.7)`，三系防同值
 *
 * 所以配 4 条曲线就够了。比例放在 `ROLE_LEVEL_RATIOS`，不开放管理端 ——
 * 多开一个口子就多一种「三系攻防被调歪了没人发现」的可能。
 *
 * ## 段内公式
 * ```
 * value(level) = start_value + per_level * k + accel * k * (k - 1) / 2    （k = level - from_level）
 * ```
 * 前 5 段 `accel = 0`（段内线性）；只有 `exp` 是二阶的（升级经验越涨越快）。
 * 段与段之间允许跳变（原数据就是这样：每 10 级跳一次）。
 *
 * ## 超出最后一段就外推
 * 最后一段的 `to_level` 是出厂上限 1000000，但运营随时可能把 `roleMaxLevel`
 * 调得更大 —— 求值时**不做硬边界**，直接用最后一段的公式继续外推，
 * 这样「调大上限」不需要同时改 4 条曲线的末段。
 */
import type { RoleLevelCurveRow, RoleLevelRow } from "../../database/rows";

/** 4 条独立曲线（顺序 = 管理端展示顺序 = 快照下发顺序） */
export const ROLE_LEVEL_CURVES = ["exp", "hp", "attack_max", "defense_max"] as const;

export type RoleLevelCurveKey = (typeof ROLE_LEVEL_CURVES)[number];

/** 曲线中文名（管理端与文案共用；未登记的原样显示 key） */
export const ROLE_LEVEL_CURVE_LABELS: Record<RoleLevelCurveKey, string> = {
  exp: "升级经验",
  hp: "生命上限",
  attack_max: "物攻上限",
  defense_max: "物防上限",
};

/**
 * 派生比例（1..60 级逐级验证过，误差 0）
 *
 * `hpRecoverOfHp = 0.01` 就是「每 100 点血 1 点回血」；`attackMinOfMax = 0.7`
 * 是「下限 = 上限的七成」。三系攻 / 三系防共用同一组比例与数值（原表就是同值）。
 */
export const ROLE_LEVEL_RATIOS = {
  /** 魔法上限 = 生命上限 × 该值 */
  mpOfHp: 0.5,
  /** 每秒回血 = 生命上限 × 该值 */
  hpRecoverOfHp: 0.01,
  /** 攻/防下限 = 各自上限 × 该值 */
  floorOfMax: 0.7,
} as const;

/** 等级上限的出厂值（`growth_scalars.roleMaxLevel` 同步改；这里只给种子用） */
export const ROLE_MAX_LEVEL_SEED = 1_000_000;

/** 一条曲线段（`role_level_curves` 表一行；形状在 `database/rows` 里定义） */
export type RoleLevelCurveSegment = RoleLevelCurveRow;

/** 段参数可改的四列（管理端 PUT 的载荷形状） */
export interface RoleLevelCurvePatch {
  toLevel?: number;
  startValue?: number;
  perLevel?: number;
  accel?: number;
}

/** 出厂段参数：由 1..60 级实际值反推，逐级复现误差 0；末段拉到 100 万级 */
export const ROLE_LEVEL_CURVE_SEEDS: ReadonlyArray<Omit<RoleLevelCurveSegment, "updated_at">> = [
  // 升级经验：段内二阶（越升越慢长），加速度 20 → 100
  { curve: "exp", seq: 1, from_level: 1, to_level: 10, start_value: 100, per_level: 80, accel: 20 },
  { curve: "exp", seq: 2, from_level: 11, to_level: 20, start_value: 1_920, per_level: 355, accel: 30 },
  { curve: "exp", seq: 3, from_level: 21, to_level: 30, start_value: 7_150, per_level: 785, accel: 40 },
  { curve: "exp", seq: 4, from_level: 31, to_level: 40, start_value: 17_600, per_level: 1_540, accel: 60 },
  { curve: "exp", seq: 5, from_level: 41, to_level: 50, start_value: 36_750, per_level: 2_595, accel: 80 },
  // 末段（#786：60 级后线性延展到 100 万级）—— 到 100 万级约 5.0e13
  { curve: "exp", seq: 6, from_level: 51, to_level: ROLE_MAX_LEVEL_SEED, start_value: 67_600, per_level: 3_950, accel: 100 },
  // 生命上限：段内线性，步长 18 → 6780（到 100 万级约 67.8 亿）
  { curve: "hp", seq: 1, from_level: 1, to_level: 10, start_value: 100, per_level: 18, accel: 0 },
  { curve: "hp", seq: 2, from_level: 11, to_level: 20, start_value: 330, per_level: 59, accel: 0 },
  { curve: "hp", seq: 3, from_level: 21, to_level: 30, start_value: 1_080, per_level: 192, accel: 0 },
  { curve: "hp", seq: 4, from_level: 31, to_level: 40, start_value: 3_520, per_level: 630, accel: 0 },
  { curve: "hp", seq: 5, from_level: 41, to_level: 50, start_value: 11_500, per_level: 2_070, accel: 0 },
  { curve: "hp", seq: 6, from_level: 51, to_level: ROLE_MAX_LEVEL_SEED, start_value: 37_700, per_level: 6_780, accel: 0 },
  // 物攻上限（三系攻同值）：步长 4 → 860
  { curve: "attack_max", seq: 1, from_level: 1, to_level: 10, start_value: 20, per_level: 4, accel: 0 },
  { curve: "attack_max", seq: 2, from_level: 11, to_level: 20, start_value: 62, per_level: 11, accel: 0 },
  { curve: "attack_max", seq: 3, from_level: 21, to_level: 30, start_value: 184, per_level: 33, accel: 0 },
  { curve: "attack_max", seq: 4, from_level: 31, to_level: 40, start_value: 550, per_level: 100, accel: 0 },
  { curve: "attack_max", seq: 5, from_level: 41, to_level: 50, start_value: 1_650, per_level: 290, accel: 0 },
  { curve: "attack_max", seq: 6, from_level: 51, to_level: ROLE_MAX_LEVEL_SEED, start_value: 4_800, per_level: 860, accel: 0 },
  // 物防上限（三系防同值）：步长 1 → 258
  { curve: "defense_max", seq: 1, from_level: 1, to_level: 10, start_value: 6, per_level: 1, accel: 0 },
  { curve: "defense_max", seq: 2, from_level: 11, to_level: 20, start_value: 18, per_level: 3, accel: 0 },
  { curve: "defense_max", seq: 3, from_level: 21, to_level: 30, start_value: 55, per_level: 10, accel: 0 },
  { curve: "defense_max", seq: 4, from_level: 31, to_level: 40, start_value: 165, per_level: 30, accel: 0 },
  { curve: "defense_max", seq: 5, from_level: 41, to_level: 50, start_value: 495, per_level: 87, accel: 0 },
  { curve: "defense_max", seq: 6, from_level: 51, to_level: ROLE_MAX_LEVEL_SEED, start_value: 1_440, per_level: 258, accel: 0 },
];

/**
 * 一条曲线在某一级的值（**纯函数**，服务端与生成脚本共用）
 *
 * - `level > 最后一段 to_level` → 用最后一段外推（调大上限不用改曲线）；
 * - `level < 1` 或该曲线一条段都没有 → `null`（= 没配，调用方决定报错还是给 0）；
 * - 落在两段之间的空隙（运营把段配断了）→ 也走「最后一段外推」以外的就近逻辑：
 *   取 `from_level` 最接近且不超过该级的那一段，行为等价于「前一段继续延伸」。
 *
 * 用整段扫描而不是二分：段数是个位数（4 条 × 6 段），二分反而更难读。
 */
export function curveValueAt(segments: ReadonlyArray<RoleLevelCurveSegment>, level: number): number | null {
  const target = Math.trunc(Number(level));
  if (!Number.isFinite(target) || target < 1 || !segments.length) return null;
  let picked: RoleLevelCurveSegment | null = null;
  for (const segment of segments) {
    if (segment.from_level > target) continue;
    if (picked === null || segment.from_level > picked.from_level) picked = segment;
  }
  if (!picked) return null;
  const k = target - picked.from_level;
  const value = picked.start_value + picked.per_level * k + (picked.accel * k * (k - 1)) / 2;
  return Math.round(value);
}

/**
 * 4 条曲线在某一级的完整裸属性行（**不含覆盖行**，覆盖由调用方先查）
 *
 * 派生列在这里算：mp / 回血 / 三系攻防 min。返回 `RoleLevelRow` 而不是裸对象，
 * 是为了让「覆盖行」与「曲线行」在上层是同一种形状（管理端列表、快照、结算共用）。
 */
export function buildRoleLevelRow(
  curves: Partial<Record<string, ReadonlyArray<RoleLevelCurveSegment>>>,
  level: number,
): RoleLevelRow | null {
  const exp = curveValueAt(curves.exp ?? [], level);
  const hp = curveValueAt(curves.hp ?? [], level);
  const attackMax = curveValueAt(curves.attack_max ?? [], level);
  const defenseMax = curveValueAt(curves.defense_max ?? [], level);
  // 任一曲线缺了这级就不出整行：半截属性（比如有血没攻）比「没有这一级」更难排查
  if (exp === null || hp === null || attackMax === null || defenseMax === null) return null;
  const attackMin = Math.round(attackMax * ROLE_LEVEL_RATIOS.floorOfMax);
  const defenseMin = Math.round(defenseMax * ROLE_LEVEL_RATIOS.floorOfMax);
  return {
    level: Math.trunc(level),
    exp,
    max_hp: hp,
    max_mp: Math.round(hp * ROLE_LEVEL_RATIOS.mpOfHp),
    hp_recover: Math.round(hp * ROLE_LEVEL_RATIOS.hpRecoverOfHp),
    physical_attack_min: attackMin,
    physical_attack_max: attackMax,
    magic_attack_min: attackMin,
    magic_attack_max: attackMax,
    taoist_attack_min: attackMin,
    taoist_attack_max: attackMax,
    physical_defense_min: defenseMin,
    physical_defense_max: defenseMax,
    magic_defense_min: defenseMin,
    magic_defense_max: defenseMax,
    taoist_defense_min: defenseMin,
    taoist_defense_max: defenseMax,
    updated_at: 0,
  };
}

/** 曲线 key 是不是登记过的四条之一（写接口用来挡非法 key） */
export function isRoleLevelCurveKey(curve: string): curve is RoleLevelCurveKey {
  return (ROLE_LEVEL_CURVES as ReadonlyArray<string>).includes(curve);
}
