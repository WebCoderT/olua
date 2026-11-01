import { ACTION, SpeedRate } from "../types/animation";

/**
 * 怪物全局行为常量（configs/monster 的全部内容 —— **没有怪物条目，#588 数据归属收口**）
 *
 * 怪物的数据客户端一份都不存：
 * - **数值**（label / level / tier / maxHp / 六项攻防）唯一来源 = 服务端 `monsters` 表
 *   （出厂 = `server/src/shared/monster-seed.ts` 按曲线展开，管理端可改），随 `GET /game-config`
 *   快照的 `monsters` 段下发，进 `configs/monsterRuntime` 的运行时表；
 * - **资源与表现**（icon / out / 几何 / 移动 / AI 参数）唯一来源 = 服务端
 *   `monster-presentation.generated.ts`（生成器从图集实测），随同一份快照的
 *   `monsterPresentations` 段下发，进同一张运行时表；
 * - 怪物的「有没有数据」由快照决定：快照失败时场上**没有怪**（生成需要资源行），
 *   不像旧口径那样回落本地出厂值演 —— 断网时服务端也不发怪，两边一致。
 *
 * 这里剩下的两个常量是**全局行为**（不是每只怪的数据）：客户端动画与本地 AI 回滚路径的
 * 手感参数。服务端权威 AI 的节奏在 game-data.generated 的 MONSTER_AI（#323 起两端同源，
 * 改手感要两边同步：服务端算命中与移动，客户端只演）。
 */

export const monsterAI = {
  /** 普攻间隔（毫秒）——怪物只会普攻，没有技能，技能以后再考虑 */
  attackInterval: 2000,
  /** 普攻距离（像素）：追到这个距离就停下出手 */
  attackRange: 60,
  /** 普攻动作时长（毫秒）：出手期间站定不移动，动作播完才结算伤害 */
  attackActionTime: 600,
  /** 待机时可随机切换的动作池（想加动作往这里加，例如 ACTION.RUN / ACTION.A1） */
  idleActions: [ACTION.STAND, ACTION.WALK] as ACTION[],
  /** 待机时更换动作的随机间隔（毫秒） */
  idleAnimationInterval: [2000, 5000] as [number, number],
  /** 待机时触发一次随机走动的随机间隔（毫秒） */
  idleMoveInterval: [4000, 9000] as [number, number],
  /** 每次随机走动的持续时间（毫秒） */
  idleMoveDuration: [300, 800] as [number, number],
  /** 随机走动的速度倍率（相对怪物自身 moveSpeed，比追击慢一点） */
  idleMoveSpeedScale: 0.5,
  /** 随机走动的活动半径（像素）：离停留点超过这个距离就往回走，避免越走越远 */
  wanderRadius: 60,
  /**
   * 击退默认时长（毫秒）：技能击退是场上唯一能推动位置的途径，
   * 技能配置里只写距离时用这个时长换算击退速度（距离 / 时长），改这里可统一调整击退手感
   */
  pushDuration: 200,
};

/**
 * 怪物默认动作速度（**每秒循环数**，片段总时长 = 1 / 该值，见 AnimationHelper.createClip）
 * 怪物素材是统一帧规格（见 configs/animation 的 monsterActionSpecs：stand 4 帧 / walk·run 6 帧 /
 * injured 2 帧 / die 10 帧，没有攻击帧——播攻击动作时回退待机），所以全怪共用一套默认即可；
 * 个别怪要调速 → 服务端 monster-presentation.generated.ts 那行的 speedRate 覆盖（随快照下发）
 */
export const monsterDefaultSpeedRate: SpeedRate = {
  [ACTION.STAND]: 1, // 4 帧 / 1 秒：缓慢的呼吸循环
  [ACTION.WALK]: 1, // 6 帧 / 1 秒，与角色步行循环同速
  [ACTION.RUN]: 1, // 6 帧 / 1 秒
  [ACTION.ATTACK_NEAR]: 2, // 素材暂无攻击帧（回退待机），留 0.5 秒一击的默认
  [ACTION.ATTACK_SKILL_1]: 2,
  [ACTION.TEST3]: 1,
  [ACTION.ATTACK_FAR]: 2,
  [ACTION.INJURED]: 2, // 受击只有 2 帧，0.5 秒抖一下
  [ACTION.A1]: 1,
  [ACTION.DIE]: 1, // 10 帧 / 1 秒：一秒倒地
  [ACTION.TEST1]: 1,
};
