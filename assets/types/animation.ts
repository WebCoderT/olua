// 8方向：地图或角色朝向的八个离散方向编码
export enum DIRECTION {
  // 上
  UP = "up",
  // 右上
  RIGHT_UP = "right_up",
  // 右
  RIGHT = "right",
  // 右下
  RIGHT_DOWN = "right_down",
  // 下
  DOWN = "down",
  // 左下
  LEFT_DOWN = "left_down",
  // 左
  LEFT = "left",
  // 左上
  LEFT_UP = "left_up",
}

// 动作：角色或NPC可能的动作状态，用以控制动画与移动逻辑
export enum ACTION {
  // 站立
  STAND = "stand",
  // 走路
  WALK = "walk",
  // 跑动
  RUN = "run",
  /** 攻击_近 */
  ATTACK_NEAR = "attack_near",
  /** 攻击1 */
  TEST2 = "test2",
  /** 攻击2 */
  TEST3 = "test3",
  /** 释放技能，法师攻击，道士攻击使用这个动作 */
  ATTACK_FAR = "attack_far",
  /** 受伤 */
  INJURED = "injured",
  /** A1 */
  A1 = "a1",
  /** 死亡 */
  DIE = "die",
  /** 测试1 */
  TEST1 = "test1",
}

/** 速度倍率接口
 *  1 代表 1秒1个循环
 *  0.5 代表1秒2个循环
 * 可通过修改此表修改角色动作时长
 * 比如攻速：1，则1秒攻击1次，0.5，则表示1秒攻击两次
 */
export type SpeedRate = Record<ACTION, number>;

/** 动画长度 */
export type AnimationLength = Record<ACTION, number>;

/** 动作是否需要武器 */
export type ActionNeedWeapon = Record<ACTION, boolean>;

/** 动画对应帧名称列表 */
export type AnimationSpritesName = Record<`${ACTION}_${DIRECTION}`, number>;
