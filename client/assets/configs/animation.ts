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
export interface MonsterActionSpec {
  action: ACTION;
  /** 该动作段的起始帧号 */
  start: number;
  /** 每方向帧数 */
  frames: number;
  /** 方向之间的帧号间隔 */
  spacing: number;
}

export const monsterActionSpecs: MonsterActionSpec[] = [
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

/**
 * 帧号基准（按目录）
 *
 * 素材导出时若与另一套**全局连续编号**（如 role/2 的帧号整体是 role/1 的 +600，
 * 且两套的空帧位置一一对称），就在这里声明基准值；切割片段时先把帧号减去基准再匹配动作区间
 * —— roleAnimationMap / monsterAnimation 恒按 **0 起**划分，不减基准则该目录一个片段都切不出来
 * （外观整片空白，且是静默失效）。
 *
 * 未登记的目录基准为 0（帧号从 0 起的常规素材无需登记）；取用统一走 getAnimationFrameBase。
 */
export const animationFrameBases = new Map<string, number>();

animationFrameBases.set("role/2", 600);

/** 取目录的帧号基准（未登记为 0） */
export function getAnimationFrameBase(dirSrc: string): number {
  return animationFrameBases.get(dirSrc) ?? 0;
}

/**
 * 外观图集根目录：按动作分 plist 的图集树（<树>/atlas/out/<id>/<动作>/<动作>.plist），
 * 与散帧目录 <树>/out/<id> 并存——打包器按「暂存区相对路径镜像输出」落盘，
 * 暂存区结构见 client/tools/stage-action-frames.py
 */

/** 取散帧外观目录对应的按动作图集目录（monster/out/1 → monster/atlas/out/1，clothes/out/001 → clothes/atlas/out/001，
 * role/1 → role/atlas/1、role/2 → role/atlas/2）。不在这几类形态里的目录返回空串（不试图集，走散帧路径） */
export function getAtlasSrc(outSrc: string): string {
  const matched = /^(\w+)\/out\/(.+)$/.exec(outSrc);
  if (matched) return `${matched[1]}/atlas/out/${matched[2]}`;
  const roleMatched = /^role\/(\d+)$/.exec(outSrc);
  return roleMatched ? `role/atlas/${roleMatched[1]}` : "";
}

/** 取单循环目录动画（整目录一串循环帧，如 NPC 外观 / 装备详情背景）对应的单 plist 图集目录
 * （npc/npc_2108 → npc/atlas/npc_2108，backgrounds/sfx_16000 → backgrounds/atlas/sfx_16000）；
 * 图集内 plist 与目录同名（<id>/<id>.plist）。不匹配返回空串（走散帧目录路径） */
export function getLoopAtlasDir(dirSrc: string): string {
  const matched = /^(npc|backgrounds)\/(\w+)$/.exec(dirSrc);
  return matched ? `${matched[1]}/atlas/${matched[2]}` : "";
}

/** 图集按动作切片的动作规格（动作名 + 每方向帧数；打包与加载共用同一张表） */
export interface ActionAtlasSpec {
  action: ACTION;
  /** 每方向帧数 */
  frames: number;
}

/** 怪物：帧号表切出动作（帧号 = start + 方向下标 × spacing + 帧内下标，帧号表在 monsterActionSpecs） */
export const monsterActionAtlas: ActionAtlasSpec[] = monsterActionSpecs.map((spec) => ({ action: spec.action, frames: spec.frames }));

/**
 * 角色（衣服/武器外观）：顺序布局的动作段（fillAnimationMap：动作段首尾相接，段长 = 8 方向 × 每方向帧数），
 * 与 client/tools/stage-action-frames.py 的 ROLE_ACTION_SPECS 同源（测试盯住两侧一致）
 */
export const roleActionAtlas: ActionAtlasSpec[] = roleActions
  .map((action) => ({ action, frames: roleSpriteFrameLength[action] ?? 0 }))
  .filter((spec) => spec.frames > 0);

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
