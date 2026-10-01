import { Vec2 } from "cc";

/**
 * 特效配置
 * 技能特效的资源路径与作用对象见 configs/skill 的 effect / effectIsOnSelf（每个技能各自配置），
 * 这里只放**统一的挂点口径**：特效节点与角色外观节点同一套规则（锚点居中、原始尺寸），
 * 因此特效与角色美术天然对齐，通常不需要偏移；需要整体上下/左右微调时改下面的偏移量。
 */
export const skillEffect = {
  /** 挂在释放者身上时的世界坐标偏移（角色节点锚点在脚底，正数向上/向右） */
  selfOffset: new Vec2(0, 0),
  /** 挂在目标（怪物）身上时的世界坐标偏移 */
  targetOffset: new Vec2(0, 0),
};

/**
 * 状态特效的统一口径（进行中的状态在角色身上循环播放的特效，见 core/StatusManager）
 * 各状态用哪张图集在 configs/status 的 effect 配置，这里只放共用的挂点偏移与播放帧率
 */
export const statusEffect = {
  /** 相对角色锚点（脚底）的世界坐标偏移 */
  offset: new Vec2(0, 0),
  /** 循环播放帧率（每秒帧数） */
  frameRate: 12,
};
