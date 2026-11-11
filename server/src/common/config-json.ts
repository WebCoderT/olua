/**
 * 配置表里「JSON 列」的读写口径（落库形状，不是某个模块的私有格式）
 *
 * 为什么放在 common：`skills.damage_coefficients` 与 `statuses.combat` 两列，
 * 写它们的是管理端（`modules/game-config`），读它们的还有**实时进程的怪物 AI**
 * （#372：放技能要倍率、算伤害要状态修正）。把解析函数放在任何一个 `modules/` 里，
 * 都会逼出一条跨域 import 白名单边；而这里只是「字符串 ↔ 结构」的纯函数，
 * 与业务规则无关，放基础层最合适。
 *
 * 兜底口径与 DTO 一致：**脏数据不炸调用方**（解析失败按空值），因为下一次写入
 * 会把坏值纠正回来 —— 配置表被手工改坏时，宁可「这个状态没有修正」，
 * 也不要让整条 AI tick 抛错。
 */

/** 一条伤害系数（下标即技能等级 - 1） */
export interface CoefficientValue {
  /** 收益基数：physicalAttack / magicAttack / ... （合法集合见 constants/game-config） */
  baseType: string;
  baseTypeRate: number;
}

/** 状态的战斗数值修正（全部可选，缺省 = 该维度不参与） */
export interface CombatValue {
  blockChance?: number;
  blockFactor?: number;
  defenseMultiplier?: number;
  attackMultiplier?: number;
}

/**
 * combat 列认可的键（顺序 = `serializeCombat` 的写出顺序）
 *
 * 加新的修正维度要同时改：这里、`StatusCombatDto` 的字段、以及两个消费方
 * （客户端 `BattleMath` / 服务端 `MonsterAiService`）—— 否则存了也不生效。
 */
export const COMBAT_KEYS = ["blockChance", "blockFactor", "defenseMultiplier", "attackMultiplier"] as const;

/** 把落库的 JSON 读成系数数组（非数组 / 坏 JSON / 元素不是对象都按空值兜底） */
export function parseCoefficientsJson(raw: string): CoefficientValue[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return { baseType: String(entry.baseType ?? ""), baseTypeRate: Number(entry.baseTypeRate) || 0 };
    });
  } catch {
    return [];
  }
}

/** 把落库的 JSON 读成修正对象（只认 COMBAT_KEYS 里的数值键，其余忽略） */
export function parseCombatJson(raw: string): CombatValue {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const value: CombatValue = {};
    for (const key of COMBAT_KEYS) {
      const entry = source[key];
      if (typeof entry === "number" && Number.isFinite(entry)) value[key] = entry;
    }
    return value;
  } catch {
    return {};
  }
}

//#region 周期效果与控制标记（#826 第三批）

/** 周期效果的四个键（顺序 = 写出顺序） */
export const TICK_EFFECT_KEYS = ["hp", "mp", "hpPercent", "mpPercent"] as const;

/** 控制标记的三个键（顺序 = 写出顺序） */
export const CONTROL_FLAG_KEYS = ["stun", "root", "silence"] as const;

/** 周期效果（全部可选，缺省 = 这一项不生效） */
export interface TickEffectValue {
  hp?: number;
  mp?: number;
  hpPercent?: number;
  mpPercent?: number;
}

/** 控制标记（stun 既禁移动也禁出手；root 只禁移动；silence 只禁出手） */
export interface ControlFlagValue {
  stun: boolean;
  root: boolean;
  silence: boolean;
}

/**
 * 把 `statuses.tick_effect` 读成对象（只认四个数值键）
 *
 * 全 0 / 坏 JSON 都返回空对象 —— 「没有周期效果」与「配错了」在行为上是同一件事：
 * 这一拍什么都不做。真正的配置错误由运营在管理端看见（字段在那里摆着）。
 */
export function parseTickEffectJson(raw: string): TickEffectValue {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const value: TickEffectValue = {};
    for (const key of TICK_EFFECT_KEYS) {
      const entry = source[key];
      if (typeof entry === "number" && Number.isFinite(entry) && entry !== 0) value[key] = entry;
    }
    return value;
  } catch {
    return {};
  }
}

/**
 * 把 `statuses.control_flags` 读成三个布尔
 *
 * 认 `1` 与 `true` 两种写法（管理端表单存 1，手写 SQL 常写 true）；其余一律 false。
 * **恒返回三个键**：消费方写 `if (control.stun)` 时不必判 undefined。
 */
export function parseControlFlagsJson(raw: string): ControlFlagValue {
  const value: ControlFlagValue = { stun: false, root: false, silence: false };
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    const source = parsed as Record<string, unknown>;
    for (const key of CONTROL_FLAG_KEYS) {
      const entry = source[key];
      value[key] = entry === true || entry === 1 || entry === "1";
    }
    return value;
  } catch {
    return value;
  }
}

//#endregion
