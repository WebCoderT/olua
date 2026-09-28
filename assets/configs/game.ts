import { Size, Vec2 } from "cc";
import { BattleAttributes, OECCUPATION, RELATION_SHIP, ROLE_ACTION, ROLE_DIRECTION, RoleOccupationInfo, SkillId } from "../types/common";

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

// 角色动作顺序
export const roleActions: ROLE_ACTION[] = [ROLE_ACTION.STAND, ROLE_ACTION.WALK, ROLE_ACTION.RUN];

// 角色方向顺序
export const roleDirections: ROLE_DIRECTION[] = [
  ROLE_DIRECTION.UP,
  ROLE_DIRECTION.RIGHT_UP,
  ROLE_DIRECTION.RIGHT,
  ROLE_DIRECTION.RIGHT_DOWN,
  ROLE_DIRECTION.DOWN,
  ROLE_DIRECTION.LEFT_DOWN,
  ROLE_DIRECTION.LEFT,
  ROLE_DIRECTION.LEFT_UP,
];

// 获取角色动画名称,实现归一化
export function getRoleAnimationName(action: ROLE_ACTION, direction: ROLE_DIRECTION) {
  return `${action}_${direction}`;
}

// 角色裸模动画长度（动作+方向）
export const roleBasicSpriteFrameInterval = 8;

// 角色拥有动画map
export const roleAnimationMap = new Map<string, number[]>();
// 角色动画map填入数据
roleActions.forEach((action, actionIndex) => {
  roleDirections.forEach((direction, directionIndex) => {
    roleAnimationMap.set(
      getRoleAnimationName(action, direction),
      Array.from({ length: roleBasicSpriteFrameInterval }, (v, k) => {
        return actionIndex * roleDirections.length * roleBasicSpriteFrameInterval + directionIndex * roleBasicSpriteFrameInterval + k;
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
