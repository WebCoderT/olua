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
