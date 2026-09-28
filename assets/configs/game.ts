import { Size, Vec2 } from "cc";
import { BattleAttributes, OECCUPATION, RELATION_SHIP, ACTION, DIRECTION, RoleOccupationInfo, SkillId } from "../types/common";

// 角色MAP
export const roles = new Map<OECCUPATION, RoleOccupationInfo>();

roles.set(OECCUPATION.ZHAN, { name: "战士", description: "create_role/tips_1", descriptionSize: new Size(245, 51) });
roles.set(OECCUPATION.FA, { name: "魔法师", description: "create_role/tips_2", descriptionSize: new Size(249, 69) });
roles.set(OECCUPATION.DAO, { name: "道士", description: "create_role/tips_3", descriptionSize: new Size(249, 69) });

// 性别MAP
export const sexMap = new Map<string, string>();

sexMap.set("1", "男");
sexMap.set("2", "女");

// 关系文字map
export const relationShipMap = new Map<RELATION_SHIP, string>();
relationShipMap.set(RELATION_SHIP.SELF, "自己");
relationShipMap.set(RELATION_SHIP.BROTHER, "兄弟");

// 关系的角色信息显示位置关系map
export const RoleInfoFramePositionsMap = new Map<RELATION_SHIP, Vec2>();
RoleInfoFramePositionsMap.set(RELATION_SHIP.SELF, new Vec2(-648, 324));
RoleInfoFramePositionsMap.set(RELATION_SHIP.BROTHER, new Vec2());

// 背包插槽行数和列数
export const bagRow = 7; // 10行
export const bagCol = 11; // 10列

// 获取角色动画名称,实现归一化
export function getAnimationName(action: ACTION, direction: DIRECTION) {
  return `${action}_${direction}`;
}

// 方向顺序
export const directions: DIRECTION[] = [DIRECTION.UP, DIRECTION.RIGHT_UP, DIRECTION.RIGHT, DIRECTION.RIGHT_DOWN, DIRECTION.DOWN, DIRECTION.LEFT_DOWN, DIRECTION.LEFT, DIRECTION.LEFT_UP];

// 角色动作顺序
export const roleActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN, ACTION.ATTACK];
// 动画长度（动作+方向）
export const roleSpriteFrameLength = new Map<ACTION, number>([
  [ACTION.STAND, 8],
  [ACTION.WALK, 8],
  [ACTION.RUN, 8],
  [ACTION.ATTACK, 2],
]);
// 角色拥有动画map
export const roleAnimationMap = new Map<string, number[]>();
// 角色动画map填入数据
roleActions.forEach((action, actionIndex) => {
  directions.forEach((direction, directionIndex) => {
    roleAnimationMap.set(
      getAnimationName(action, direction),
      Array.from({ length: roleSpriteFrameLength.get(action) }, (v, k) => {
        /** 按照每个动作，每个方向进行计数，并且截取正确的数据长度 */
        return actionIndex * directions.length * roleSpriteFrameLength + directionIndex * roleSpriteFrameLength + k;
      }),
    );
  });
});
/** 角色每个动作对应时长
 *  1 代表 1秒1个循环
 *  0.5 代表1秒2个循环
 * 可通过修改此表修改角色动作时长
 * 比如攻速：1，则1秒攻击1次，0.5，则表示1秒攻击两次
 * */
export const roleActionSpeed = new Map<ACTION, number>([
  [ACTION.STAND, 1],
  [ACTION.WALK, 1],
  [ACTION.RUN, 1],
  [ACTION.ATTACK, 1],
]);

/** 怪物动作顺序 */
export const monsterActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN];
/** 怪物动画帧长度 */
export const monsterSpriteFrameInterval = 10;
/** 怪物拥有动画映射 */
export const monsterAnimation = new Map<string, number[]>();
/** 怪物动画map填入数据 */
monsterActions.forEach((action, actionIndex) => {
  directions.forEach((direction, directionIndex) => {
    monsterAnimation.set(
      getAnimationName(action, direction),
      Array.from({ length: monsterSpriteFrameInterval }, (v, k) => {
        return actionIndex * directions.length * monsterSpriteFrameInterval + directionIndex * monsterSpriteFrameInterval + k;
      }),
    );
  });
});

// 战斗力计算参考
export const combatCalc = new Map<keyof BattleAttributes, number>();
combatCalc.set("magicAttack", 5);
combatCalc.set("physicalAttack", 5);
combatCalc.set("taoistAttack", 5);
combatCalc.set("magicDefense", 10);
combatCalc.set("physicalDefense", 10);
combatCalc.set("taoistDefense", 10);
combatCalc.set("maxHp", 15);

/** 职业技能映射 */
export const oeccupationSkills = new Map<OECCUPATION, SkillId[]>();
/** 战士技能映射 */
oeccupationSkills.set(OECCUPATION.ZHAN, ["1000", "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011"]);
/** 法师技能映射 */
oeccupationSkills.set(OECCUPATION.FA, []);
/** 道士技能映射 */
oeccupationSkills.set(OECCUPATION.DAO, []);
