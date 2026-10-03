import { Size } from "cc";

/**
 * 自动战斗配置（快速攻击与自动挂机共用）
 * 快速攻击：释放 canAuto 技能时没有可打目标/目标超出距离，自动选最近怪物走位到范围内连续出手
 * 自动挂机：开关打开后持续自动选目标攻击，目标死亡换下一个，无限重复
 */
export const autoBattle = {
  /** 自动选目标的最大距离（像素，0 = 不限，全图取最近） */
  maxTargetDistance: 0,
  /** 自动移动是否使用跑步速度 */
  moveByRun: true,
  /** A* 网格单元边长（像素），越小越贴合障碍、搜索越慢 */
  cellSize: 40,
  /** 通行余量（像素）：障碍矩形向外扩张这么多再烙进网格，避免自动走位贴墙卡住 */
  clearance: 20,
  /** NPC 在寻路网格中的占位尺寸（Tiled 点位没有宽高，只能按典型 NPC 体型估算） */
  npcObstacleSize: new Size(60, 90),
  /** 重新寻路间隔（毫秒）：目标会移动（游走/被击退），路径要定期重算 */
  repathInterval: 400,
  /** 到达路点的判定半径（像素），进入半径即走向下一个路点 */
  waypointTolerance: 14,
  /** 卡住检测间隔（毫秒）与该间隔内的最小位移（像素），低于视为卡住 */
  stuckInterval: 500,
  stuckDistance: 8,
  /** 连续卡住多少次（每次都强制重寻路）后放弃当前目标 */
  stuckRetryLimit: 3,
  /** 被放弃的目标拉黑时长（毫秒），期间自动选目标跳过它 */
  targetBanDuration: 5000,
  /** 场上没有目标时，隔多久再找一次（毫秒），避免每帧全图扫描 */
  targetSearchInterval: 500,
  /** 点击寻路（小地图弹窗）的到达判定半径（像素），距目标点进入半径即视为到达 */
  arriveTolerance: 20,
  /** 传送落点吸附：落点周围多大范围（格）内找最近可站立位置，避免直接飞进墙里/怪堆里 */
  teleportSnapRadius: 12,
};

