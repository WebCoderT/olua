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
  /**
   * 攻击（怪物素材段，#1247 由 run 改名）
   * 怪物没有奔跑：原 run 段的画面就是攻击，目录/动作名现改为 attack 与画面一致；
   * `RUN` 保留给角色（role 素材真有跑动段）
   */
  ATTACK = "attack",
  /** 攻击_近 */
  ATTACK_NEAR = "attack_near",
  /** 攻击1 */
  ATTACK_SKILL_1 = "attack_skill_1",
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

/** 速度倍率接口 */
export type SpeedRate = Record<ACTION, number>;

/** 动画长度 */
export type AnimationLength = Record<ACTION, number>;

/** 动作是否需要武器 */
export type ActionNeedWeapon = Record<ACTION, boolean>;

/** 动画对应帧名称列表 */
export type AnimationSpritesName = Record<`${ACTION}_${DIRECTION}`, number>;

/**
 * 动画种类：决定按哪张动画表切割整包帧动画
 * role = 角色（衣服/武器，见 configs/animation 的 roleAnimationMap）
 * monster = 怪物（见 configs/animation 的 monsterAnimation）
 * frames = 不切割，只需要帧序列（整包循环播放的动画，如 NPC 外观）
 */
export type AnimationKind = "role" | "monster" | "frames";
