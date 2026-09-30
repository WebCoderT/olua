import { BoxCollider2D, Node } from "cc";
import { DIRECTION } from "../../../types/animation";
import { BattleAttributes } from "../../../types/common";

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

/** 取得 self 朝向 target 的八方向（按两个碰撞盒中心的相对位置，取不到碰撞盒时返回朝下） */
export function getDirectionToTarget(target: Node, self: Node): DIRECTION {
  const targetBounds = getWorldBounds(target);
  const selfBounds = getWorldBounds(self);
  if (!targetBounds || !selfBounds) return DIRECTION.DOWN;

  const deltaX = targetBounds.x + targetBounds.width / 2 - (selfBounds.x + selfBounds.width / 2);
  const deltaY = targetBounds.y + targetBounds.height / 2 - (selfBounds.y + selfBounds.height / 2);
  if (deltaX === 0 && deltaY === 0) return DIRECTION.DOWN;

  const octant = (Math.round(Math.atan2(deltaY, deltaX) / (Math.PI / 4)) + 8) % 8;
  return directionByOctant[octant];
}

/**
 * 结算一次受击：按「攻击区间随机值 - 防御区间随机值」扣减 self 的血量
 * @returns 本次实际扣除的血量（血量不会被扣成负数）
 */
export function applyHitDamage(self: BattleAttributes & { hp: number }, enemy: BattleAttributes, attackAttribute: AttackAttribute = "physicalAttack"): number {
  const attack = rollAttributeRange(enemy[attackAttribute]);
  const defense = rollAttributeRange(self[defenseAttributeByAttack[attackAttribute]]);
  const damage = Math.max(0, attack - defense);
  const previousHp = Math.max(0, self.hp);

  self.hp = Math.max(0, previousHp - damage);
  return previousHp - self.hp;
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
