import { BoxCollider2D, Node } from "cc";
import { BattleAttributes, DIRECTION } from "../../types/common";

type AttackAttribute = "physicalAttack" | "magicAttack" | "taoistAttack";
type DefenseAttribute = "physicalDefense" | "magicDefense" | "taoistDefense";

const defenseAttributeByAttack: Record<AttackAttribute, DefenseAttribute> = {
  physicalAttack: "physicalDefense",
  magicAttack: "magicDefense",
  taoistAttack: "taoistDefense",
};

function rollAttributeRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

const directionByOctant: DIRECTION[] = [DIRECTION.RIGHT, DIRECTION.RIGHT_UP, DIRECTION.UP, DIRECTION.LEFT_UP, DIRECTION.LEFT, DIRECTION.LEFT_DOWN, DIRECTION.DOWN, DIRECTION.RIGHT_DOWN];

function getWorldBounds(node: Node) {
  return node.getComponent(BoxCollider2D)?.worldAABB ?? null;
}

/** 打架助手 */
const BattleHelper = {
  /**
   * 判断两个矩形之间的距离是否在攻击范围内
   * attackRange 为矩形边缘间距，默认 0 表示接触或重叠
   */
  checkTargetCanAttack(target: Node, self: Node, attackRange: number = 0): boolean {
    const targetBounds = getWorldBounds(target);
    const selfBounds = getWorldBounds(self);
    if (!targetBounds || !selfBounds) return false;

    const horizontalGap = Math.max(targetBounds.x - (selfBounds.x + selfBounds.width), selfBounds.x - (targetBounds.x + targetBounds.width), 0);
    const verticalGap = Math.max(targetBounds.y - (selfBounds.y + selfBounds.height), selfBounds.y - (targetBounds.y + targetBounds.height), 0);
    return Math.hypot(horizontalGap, verticalGap) <= Math.max(0, attackRange);
  },

  /** 根据两个矩形中心的相对位置，取得 self 朝向 target 的八方向 */
  checkSelfDirection(target: Node, self: Node): DIRECTION {
    const targetBounds = getWorldBounds(target);
    const selfBounds = getWorldBounds(self);
    if (!targetBounds || !selfBounds) return DIRECTION.DOWN;

    const deltaX = targetBounds.x + targetBounds.width / 2 - (selfBounds.x + selfBounds.width / 2);
    const deltaY = targetBounds.y + targetBounds.height / 2 - (selfBounds.y + selfBounds.height / 2);
    if (deltaX === 0 && deltaY === 0) return DIRECTION.DOWN;

    const octant = (Math.round(Math.atan2(deltaY, deltaX) / (Math.PI / 4)) + 8) % 8;
    return directionByOctant[octant];
  },

  /** 结算一次受击，返回实际扣除的血量 */
  attributeCalcAfterAttacked(self: BattleAttributes & { hp: number }, enemy: BattleAttributes, attackAttribute: AttackAttribute = "physicalAttack"): number {
    const attack = rollAttributeRange(enemy[attackAttribute]);
    const defense = rollAttributeRange(self[defenseAttributeByAttack[attackAttribute]]);
    const damage = Math.max(0, attack - defense);
    const previousHp = Math.max(0, self.hp);

    self.hp = Math.max(0, previousHp - damage);
    return previousHp - self.hp;
  },
};

export default BattleHelper;
