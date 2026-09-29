import { Size, Vec2 } from "cc";
import { BattleAttributes, OECCUPATION, RELATION_SHIP, ACTION, DIRECTION, RoleOccupationInfo, SkillId, AnimationLength, AnimationSpritesName, ActionNeedWeapon } from "../types/common";

/** 角色移动速度-全局 */
export const ROLE_WALK_SPEED = 2;
/** 角色跑动速度-全局 */
export const ROLE_RUN_SPEED = 4;

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
export function getAnimationName(action: ACTION, direction: DIRECTION): keyof AnimationSpritesName {
  return `${action}_${direction}`;
}

// 方向顺序
export const directions: DIRECTION[] = [DIRECTION.UP, DIRECTION.RIGHT_UP, DIRECTION.RIGHT, DIRECTION.RIGHT_DOWN, DIRECTION.DOWN, DIRECTION.LEFT_DOWN, DIRECTION.LEFT, DIRECTION.LEFT_UP];

// 角色动作顺序
export const roleActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN, ACTION.TEST1, ACTION.ATTACK_NEAR, ACTION.TEST2, ACTION.TEST3, ACTION.ATTACK_FAR, ACTION.INJURED, ACTION.A1, ACTION.DIE];
// 动画长度（动作+方向）
export const roleSpriteFrameLength: AnimationLength = {
  [ACTION.STAND]: 8,
  [ACTION.WALK]: 8,
  [ACTION.RUN]: 8,
  [ACTION.ATTACK_NEAR]: 8,
  [ACTION.TEST2]: 8,
  [ACTION.TEST3]: 8,
  [ACTION.ATTACK_FAR]: 8,
  [ACTION.INJURED]: 2,
  [ACTION.A1]: 8,
  [ACTION.DIE]: 8,
  [ACTION.TEST1]: 1,
};

function fillAnimationMap(animationMap: Map<string, number[]>, actions: ACTION[], getFrameLength: (action: ACTION) => number) {
  animationMap.clear();
  let actionStartIndex = 0;

  actions.forEach((action) => {
    const frameLength = getFrameLength(action);
    directions.forEach((direction, directionIndex) => {
      const directionStartIndex = actionStartIndex + directionIndex * frameLength;
      animationMap.set(
        getAnimationName(action, direction),
        Array.from({ length: frameLength }, (_, frameIndex) => directionStartIndex + frameIndex),
      );
    });
    actionStartIndex += directions.length * frameLength;
  });
}

// 角色拥有动画map
export const roleAnimationMap = new Map<string, number[]>();
fillAnimationMap(roleAnimationMap, roleActions, (action) => roleSpriteFrameLength[action] ?? 0);

/** 怪物动作顺序 */
export const monsterActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN];
/** 怪物动画帧长度 */
export const monsterSpriteFrameInterval = 10;
/** 怪物拥有动画映射 */
export const monsterAnimation = new Map<string, number[]>();
fillAnimationMap(monsterAnimation, monsterActions, () => monsterSpriteFrameInterval);

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

/** 动作是否需要武器 */
export const actionNeedWeapon: ActionNeedWeapon = {
  [ACTION.STAND]: false,
  [ACTION.WALK]: false,
  [ACTION.RUN]: false,
  [ACTION.ATTACK_NEAR]: true,
  [ACTION.TEST2]: false,
  [ACTION.TEST3]: false,
  [ACTION.ATTACK_FAR]: true,
  [ACTION.INJURED]: false,
  [ACTION.A1]: false,
  [ACTION.DIE]: false,
  [ACTION.TEST1]: false,
};
