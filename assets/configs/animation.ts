import { ACTION, ActionNeedWeapon, AnimationLength, AnimationSpritesName, DIRECTION } from "../types/animation";

// 方向顺序
const directions: DIRECTION[] = [DIRECTION.UP, DIRECTION.RIGHT_UP, DIRECTION.RIGHT, DIRECTION.RIGHT_DOWN, DIRECTION.DOWN, DIRECTION.LEFT_DOWN, DIRECTION.LEFT, DIRECTION.LEFT_UP];

// 角色动作顺序
const roleActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN, ACTION.TEST1, ACTION.ATTACK_NEAR, ACTION.TEST2, ACTION.TEST3, ACTION.ATTACK_FAR, ACTION.INJURED, ACTION.A1, ACTION.DIE];

// 动画长度（动作+方向）
const roleSpriteFrameLength: AnimationLength = {
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

/** 怪物动作顺序 */
const monsterActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN];

/** 怪物动画帧长度 */
const monsterSpriteFrameInterval = 10;

/** 获取角色动画名称,实现归一化 */
export function getAnimationName(action: ACTION, direction: DIRECTION): keyof AnimationSpritesName {
  return `${action}_${direction}`;
}

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

/** 角色拥有动画map */
export const roleAnimationMap = new Map<string, number[]>();
fillAnimationMap(roleAnimationMap, roleActions, (action) => roleSpriteFrameLength[action] ?? 0);

/** 怪物拥有动画映射 */
export const monsterAnimation = new Map<string, number[]>();
fillAnimationMap(monsterAnimation, monsterActions, () => monsterSpriteFrameInterval);

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
