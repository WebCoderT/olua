/**
 * 状态数值的战斗修正（#822：角色侧状态参与结算）
 *
 * 为什么单独一个文件：**数值口径**要在三处用同一份 —— 服务端结算（出伤）、服务端受击
 * （格挡 / 防御倍率）、客户端 `BattleMath`（规格与单测向量）。放进 `modules/combat/`
 * 是因为它是纯函数库：不引 Nest、不引数据库、不持有状态（谁挂着什么在 `role_status`）。
 *
 * 随机数由调用方给：e2e 才能复现「这一次必定格挡 / 必定不格挡」——
 * 把 `Math.random()` 藏进函数里，就只能靠概率碰运气。
 */

/** 状态带来的战斗修正（与客户端 `StatusCombatModifiers` 同形状，多一项攻击倍率） */
export interface RoleStatusModifiers {
  /** 格挡触发概率（0-1） */
  blockChance: number;
  /** 格挡触发时伤害乘的系数（0.5 = 减半） */
  blockFactor: number;
  /** 防御乘法系数（1.5 = 防御 ×1.5） */
  defenseMultiplier: number;
  /** 攻击乘法系数（出伤时乘在技能伤害上） */
  attackMultiplier: number;
}

/** 无状态时的中性修正值（行为与没有状态层时完全一致） */
export const NO_STATUS_MODIFIERS: RoleStatusModifiers = {
  blockChance: 0,
  blockFactor: 1,
  defenseMultiplier: 1,
  attackMultiplier: 1,
};

/**
 * 受击结算的「格挡与减伤」（纯函数）
 *
 * 与客户端 `BattleMath.resolveIncomingDamage` 同公式：`roll < blockChance` 视为格挡，
 * 触发时伤害乘 `blockFactor` 并四舍五入，下限 0。
 */
export function resolveIncomingDamage(
  damage: number,
  modifiers: RoleStatusModifiers,
  roll: number,
): { blocked: boolean; damage: number } {
  const blocked = roll < modifiers.blockChance;
  return { blocked, damage: blocked ? Math.max(0, Math.round(damage * modifiers.blockFactor)) : damage };
}
