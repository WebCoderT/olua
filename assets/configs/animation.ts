import { ACTION, ActionNeedWeapon, AnimationLength, AnimationSpritesName, DIRECTION } from "../types/animation";

// 方向顺序（outPositions 等按方向配置的数组以下标顺序为准）
export const directions: DIRECTION[] = [DIRECTION.UP, DIRECTION.RIGHT_UP, DIRECTION.RIGHT, DIRECTION.RIGHT_DOWN, DIRECTION.DOWN, DIRECTION.LEFT_DOWN, DIRECTION.LEFT, DIRECTION.LEFT_UP];

/** 获取方向在按方向配置数组（如 Equipment.outPositions）中的下标 */
export function getDirectionIndex(direction: DIRECTION): number {
  return directions.indexOf(direction);
}

// 角色动作顺序
const roleActions: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN, ACTION.TEST1, ACTION.ATTACK_NEAR, ACTION.ATTACK_SKILL_1, ACTION.TEST3, ACTION.ATTACK_FAR, ACTION.INJURED, ACTION.A1, ACTION.DIE];

// 动画长度（动作+方向）
const roleSpriteFrameLength: AnimationLength = {
  [ACTION.STAND]: 8,
  [ACTION.WALK]: 8,
  [ACTION.RUN]: 8,
  [ACTION.ATTACK_NEAR]: 8,
  [ACTION.ATTACK_SKILL_1]: 8,
  [ACTION.TEST3]: 8,
  [ACTION.ATTACK_FAR]: 8,
  [ACTION.INJURED]: 2,
  [ACTION.A1]: 8,
  [ACTION.DIE]: 8,
  [ACTION.TEST1]: 1,
};

/**
 * 怪物动作帧规格（resources/monster/out/<id> 素材包实测布局，各包统一）：
 * 帧号公式 = start + 方向下标 × spacing + 帧内下标（方向内连续、方向之间按 spacing 跳开）
 * - stand: 每方向 4 帧，方向间隔 10（0-79 段，如 0-3 / 10-13 / ...）
 * - walk / run: 每方向 6 帧，方向间隔 10（80-155 / 160-235 段）
 * - injured: 每方向 2 帧，方向间隔 2（240-255 段连续排布）
 * - die: 每方向 10 帧，方向间隔 10（260-339 段）
 * 素材包没有攻击动作（attack_near 等）与 test/a1 动作的帧，不进映射表——
 * 播放这些动作时引擎侧没有对应片段，MonsterAI.playAction 会回退成待机；
 * 个别包缺段（如怪物 27 没有走路段）时该动作同样自动回退
 */
interface MonsterActionSpec {
  action: ACTION;
  /** 该动作段的起始帧号 */
  start: number;
  /** 每方向帧数 */
  frames: number;
  /** 方向之间的帧号间隔 */
  spacing: number;
}

const monsterActionSpecs: MonsterActionSpec[] = [
  { action: ACTION.STAND, start: 0, frames: 4, spacing: 10 },
  { action: ACTION.WALK, start: 80, frames: 6, spacing: 10 },
  { action: ACTION.RUN, start: 160, frames: 6, spacing: 10 },
  { action: ACTION.INJURED, start: 240, frames: 2, spacing: 2 },
  { action: ACTION.DIE, start: 260, frames: 10, spacing: 10 },
];

/**
 * 攻击/施法动画的兜底解锁余量（秒）
 * 动画 FINISHED 事件没触发时，按「本动作时长（speedRate 即每秒循环数）+ 本余量」强制解锁，
 * 免得角色一直卡在攻击态（见 ui/components/role/RoleDisplay.startAttack）
 */
export const actionFinishTimeoutMarginSeconds = 1;

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

/** 怪物拥有动画映射（按实测帧规格切割，见 monsterActionSpecs） */
export const monsterAnimation = new Map<string, number[]>();
monsterActionSpecs.forEach((spec) => {
  directions.forEach((direction, directionIndex) => {
    const directionStart = spec.start + directionIndex * spec.spacing;
    monsterAnimation.set(
      getAnimationName(spec.action, direction),
      Array.from({ length: spec.frames }, (_, frameIndex) => directionStart + frameIndex),
    );
  });
});

/** 动作是否需要武器 */
export const actionNeedWeapon: ActionNeedWeapon = {
  [ACTION.STAND]: false,
  [ACTION.WALK]: false,
  [ACTION.RUN]: false,
  [ACTION.ATTACK_NEAR]: true,
  [ACTION.ATTACK_SKILL_1]: false,
  [ACTION.TEST3]: false,
  [ACTION.ATTACK_FAR]: true,
  [ACTION.INJURED]: false,
  [ACTION.A1]: false,
  [ACTION.DIE]: false,
  [ACTION.TEST1]: false,
};
