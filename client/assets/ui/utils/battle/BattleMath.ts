import { BoxCollider2D, Node, Vec2 } from "cc";
import { DIRECTION } from "../../../types/animation";
import { BattleAttributes } from "../../../types/common";
import { statuses } from "../../../configs/status";
import { StatusId } from "../../../types/status";

/**
 * 战斗数值与判定（纯函数模块）
 * 只负责「算」：攻击距离判定、朝向判定、伤害公式；
 * 扣血、飘字、死亡移除等流程由调用方（MonsterManager、技能实现）编排
 */

/** 攻击属性名（取自 BattleAttributes） */
type AttackAttribute = "physicalAttack" | "magicAttack" | "taoistAttack";
/** 防御属性名（与攻击属性一一对应） */
type DefenseAttribute = "physicalDefense" | "magicDefense" | "taoistDefense";

/** 攻击属性 -> 对应的防御属性 */
const defenseAttributeByAttack: Record<AttackAttribute, DefenseAttribute> = {
  physicalAttack: "physicalDefense",
  magicAttack: "magicDefense",
  taoistAttack: "taoistDefense",
};

/** 状态带来的防御修正（从进行中的状态汇总，见 collectStatusCombatModifiers） */
export interface StatusCombatModifiers {
  /** 格挡触发概率（0-1） */
  blockChance: number;
  /** 格挡触发时伤害乘的系数（0.5 = 减半） */
  blockFactor: number;
  /** 防御乘法系数（1.5 = 防御 ×1.5） */
  defenseMultiplier: number;
}

/** 无状态时的中性修正值（行为与没有状态系统时完全一致） */
export const NO_STATUS_MODIFIERS: StatusCombatModifiers = { blockChance: 0, blockFactor: 1, defenseMultiplier: 1 };

/**
 * 从进行中的状态汇总防御修正（纯函数；状态数值语义在 configs/status 的 combat 字段）
 * 叠加口径（详见 client/FAQ.md）：格挡概率取最大值（不叠概率）、格挡系数取最小值（取更保护的一个）、防御系数连乘
 */
export function collectStatusCombatModifiers(activeStatusIds: readonly string[]): StatusCombatModifiers {
  const modifiers: StatusCombatModifiers = { ...NO_STATUS_MODIFIERS };
  activeStatusIds.forEach((statusId) => {
    const combat = statuses.get(statusId as StatusId)?.combat;
    if (!combat) return;
    if (combat.blockChance !== undefined) modifiers.blockChance = Math.max(modifiers.blockChance, combat.blockChance);
    if (combat.blockFactor !== undefined) modifiers.blockFactor = Math.min(modifiers.blockFactor, combat.blockFactor);
    if (combat.defenseMultiplier !== undefined) modifiers.defenseMultiplier *= combat.defenseMultiplier;
  });
  return modifiers;
}

/**
 * 结算一次「格挡与减伤」（纯函数核心；随机数由调用方给，单测给定 roll 即可复现）
 * roll < blockChance 视为格挡，触发时伤害乘 blockFactor（四舍五入回整数，不为负）
 */
export function resolveIncomingDamage(damage: number, modifiers: StatusCombatModifiers, roll: number): { blocked: boolean; damage: number } {
  const blocked = roll < modifiers.blockChance;
  return { blocked, damage: blocked ? Math.max(0, Math.round(damage * modifiers.blockFactor)) : damage };
}

/** 八分象限 -> 八方向（索引 = atan2 角度 / 45°，0 为 +x 方向） */
const directionByOctant: DIRECTION[] = [DIRECTION.RIGHT, DIRECTION.RIGHT_UP, DIRECTION.UP, DIRECTION.LEFT_UP, DIRECTION.LEFT, DIRECTION.LEFT_DOWN, DIRECTION.DOWN, DIRECTION.RIGHT_DOWN];

/** 取节点碰撞盒的世界包围盒（无碰撞体返回 null） */
function getWorldBounds(node: Node) {
  return node.getComponent(BoxCollider2D)?.worldAABB ?? null;
}

/** 在属性区间内随机取整数（区间上下限颠倒时自动纠正） */
function rollAttributeRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * 判断 target 是否在 self 的攻击范围内
 * 按两个碰撞盒的边缘间距判定，attackRange 为允许的边缘间距，缺省 1 表示接触或重叠即可命中
 */
export function canAttackTarget(target: Node, self: Node, attackRange: number = 1): boolean {
  const targetBounds = getWorldBounds(target);
  const selfBounds = getWorldBounds(self);
  if (!targetBounds || !selfBounds) return false;

  const horizontalGap = Math.max(targetBounds.x - (selfBounds.x + selfBounds.width), selfBounds.x - (targetBounds.x + targetBounds.width), 0);
  const verticalGap = Math.max(targetBounds.y - (selfBounds.y + selfBounds.height), selfBounds.y - (targetBounds.y + targetBounds.height), 0);
  return Math.hypot(horizontalGap, verticalGap) <= Math.max(1, attackRange);
}

/** 取向量对应的八方向（按 45° 分八瓣，零向量返回朝下） */
export function getDirectionByVector(vector: Vec2): DIRECTION {
  if (vector.x === 0 && vector.y === 0) return DIRECTION.DOWN;
  const octant = (Math.round(Math.atan2(vector.y, vector.x) / (Math.PI / 4)) + 8) % 8;
  return directionByOctant[octant];
}

/** 取八方向对应的单位向量（getDirectionByVector 的反函数；斜向与键盘斜按的归一化向量一致） */
export function getVectorByDirection(direction: DIRECTION): Vec2 {
  const angle = directionByOctant.indexOf(direction) * (Math.PI / 4);
  return new Vec2(Math.cos(angle), Math.sin(angle));
}

/** 取得 self 朝向 target 的八方向（按两个碰撞盒中心的相对位置，取不到碰撞盒时返回朝下） */
export function getDirectionToTarget(target: Node, self: Node): DIRECTION {
  const targetBounds = getWorldBounds(target);
  const selfBounds = getWorldBounds(self);
  if (!targetBounds || !selfBounds) return DIRECTION.DOWN;

  const deltaX = targetBounds.x + targetBounds.width / 2 - (selfBounds.x + selfBounds.width / 2);
  const deltaY = targetBounds.y + targetBounds.height / 2 - (selfBounds.y + selfBounds.height / 2);
  return getDirectionByVector(new Vec2(deltaX, deltaY));
}

/**
 * 结算一次受击：按「攻击区间随机值 - 防御区间随机值」扣减 self 的血量
 * @param modifiers 状态带来的防御修正（无状态传缺省值，行为与旧口径完全一致）
 * @returns 本次实际扣除的血量（血量不会被扣成负数）与是否触发了格挡
 */
export function applyHitDamage(
  self: BattleAttributes & { hp: number },
  enemy: BattleAttributes,
  attackAttribute: AttackAttribute = "physicalAttack",
  modifiers: StatusCombatModifiers = NO_STATUS_MODIFIERS,
): { damage: number; blocked: boolean } {
  const attack = rollAttributeRange(enemy[attackAttribute]);
  // 防御乘法系数生效于防御项（乘法口径）：先出区间随机值再放大，四舍五入回整数
  const defense = Math.round(rollAttributeRange(self[defenseAttributeByAttack[attackAttribute]]) * modifiers.defenseMultiplier);
  const damage = Math.max(0, attack - defense);
  // 格挡判定走纯函数核心（单测给定 roll 可复现）
  const { damage: finalDamage, blocked } = resolveIncomingDamage(damage, modifiers, Math.random());
  const previousHp = Math.max(0, self.hp);

  self.hp = Math.max(0, previousHp - finalDamage);
  return { damage: previousHp - self.hp, blocked };
}

/**
 * 计算一次技能伤害（只算不扣血，扣血统一交给 hurt 流程，避免重复扣血）
 * 公式：攻击区间随机值 × 技能倍率 − 防御区间随机值
 */
export function calcSkillDamage(attacker: BattleAttributes, victim: BattleAttributes, attackAttribute: AttackAttribute = "physicalAttack", rate: number = 1): number {
  const attack = rollAttributeRange(attacker[attackAttribute]) * rate;
  const defense = rollAttributeRange(victim[defenseAttributeByAttack[attackAttribute]]);
  return Math.max(0, Math.round(attack - defense));
}

/**
 * 一次技能伤害的**合法区间**（#34 双跑对账用）
 *
 * 伤害上移服务端后，两端各掷各的随机数 —— 逐次比较必然对不上（这不是 bug，是公式带随机）。
 * 能比的是「服务端算的值是否落在客户端口径允许的带内」：
 *   下限 = round(min攻 × rate − max防)，上限 = round(max攻 × rate − min防)，下限截到 0。
 * 服务端伤害越界说明两端的表或公式漂了，调用方要把它当**可观测的异常**记下来（见 CombatChannel）。
 */
export function skillDamageBand(attacker: BattleAttributes, victim: BattleAttributes, attackAttribute: AttackAttribute = "physicalAttack", rate: number = 1): [number, number] {
  const attack = attacker[attackAttribute];
  const defense = victim[defenseAttributeByAttack[attackAttribute]];
  const lowestAttack = Math.min(attack[0], attack[1]);
  const highestAttack = Math.max(attack[0], attack[1]);
  const lowestDefense = Math.min(defense[0], defense[1]);
  const highestDefense = Math.max(defense[0], defense[1]);
  const low = Math.max(0, Math.round(lowestAttack * rate - highestDefense));
  const high = Math.max(0, Math.round(highestAttack * rate - lowestDefense));
  return [low, high];
}
