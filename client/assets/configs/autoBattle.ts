import { Color, Size } from "cc";

/**
 * 自动战斗配置（快速攻击与自动挂机共用）
 * 快速攻击：释放 canAuto 技能时没有可打目标/目标超出距离，自动选最近怪物走位到范围内连续出手
 * 自动挂机：开关打开后持续自动选目标攻击，目标死亡换下一个，无限重复
 *
 * **#605 起行为数值由运营配置**：`server/data/config-sync.sql` 是唯一书写处，
 * 管理端「运行时参数」页可改，随 `GET /game-config` 的 `runtimeParams.autoBattle` 段下发，
 * `applyAutoBattleParams` 逐键覆写下面这份出厂值。
 *
 * **样式与几何不在下发范围**（`routeLine` 的颜色 / 半径 / 间距都没有运营含义，
 * 属于表现层常量）：它们既不该进 JSON 配置，也不该让运营在后台改出「看不见的路线」。
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
  /** 突进类技能（十步一杀）的落点吸附半径（像素）：突进距离远，允许在更大范围找回可站立位置 */
  dashSnapRadius: 60,
  /**
   * 路线指示线（自动寻路期间在大地图地面上画出的路线：起点角色 → A* 路点 → 目标）
   * 样式为白色点状线：沿路线等距铺一串白色圆点，终点一个更大的白色圆点表示目的地；
   * 几何单位是世界像素，画在地图层的独立绘制节点上（贴地、在角色与怪物之下）；
   * 小地图上的同一路线由 configs/smallMap 的 route* 控制、小地图弹窗由 configs/layout/dialogs
   * 的 mapPreviewDialogLayout.route 控制（均为像素单位，与各自绘制层同口径）
   */
  routeLine: {
    /** 点与终点圆点的颜色（白色半透明，压在地面上不遮挡地形） */
    color: new Color(255, 255, 255, 220),
    /** 单个点半径（世界像素） */
    dotRadius: 3,
    /** 相邻点间距（世界像素）：点状线的疏密 */
    dotGap: 22,
    /** 终点圆点半径（世界像素）：比途中的点大一圈，一眼看出目的地 */
    endDotRadius: 14,
    /** 重绘间隔（毫秒）：起点随角色移动，走位期间无需更高频率 */
    refreshInterval: 33,
  },
};

/** 可被运营覆写的字段（快照 `runtimeParams.autoBattle` 段就是这些键） */
export interface AutoBattleTuning {
  maxTargetDistance: number;
  moveByRun: boolean;
  cellSize: number;
  clearance: number;
  repathInterval: number;
  waypointTolerance: number;
  stuckInterval: number;
  stuckDistance: number;
  stuckRetryLimit: number;
  targetBanDuration: number;
  targetSearchInterval: number;
  arriveTolerance: number;
  teleportSnapRadius: number;
  dashSnapRadius: number;
}

/**
 * 覆写自动战斗参数（#605；快照 `runtimeParams.autoBattle` 段到达时调一次）
 *
 * 逐键显式赋值而不是遍历：`autoBattle` 里混着 `Size` / `Color` / 嵌套对象，
 * 遍历写法要么把它们带上（覆写成 NaN 就整条路线消失），要么得靠类型断言绕过去 ——
 * 显式列出来反而是最不容易出错的一份清单，加参数时编译期就能提醒。
 *
 * 非法值（非数字 / 负数）保持当前值：宁可沿用旧手感，也不要让一次坏配置把
 * 网格边长变成 0（A* 会直接搜不动）。
 */
export function applyAutoBattleParams(params: Partial<AutoBattleTuning> | undefined): void {
  if (!params) return;
  const num = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
  };
  const rate = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback;
  };
  autoBattle.maxTargetDistance = num(params.maxTargetDistance, autoBattle.maxTargetDistance);
  if (typeof params.moveByRun === "boolean") autoBattle.moveByRun = params.moveByRun;
  // 网格边长与重试次数必须 ≥ 1（0 会让寻路 / 放弃逻辑失去意义）
  autoBattle.cellSize = rate(params.cellSize, autoBattle.cellSize);
  autoBattle.clearance = num(params.clearance, autoBattle.clearance);
  autoBattle.repathInterval = num(params.repathInterval, autoBattle.repathInterval);
  autoBattle.waypointTolerance = num(params.waypointTolerance, autoBattle.waypointTolerance);
  autoBattle.stuckInterval = num(params.stuckInterval, autoBattle.stuckInterval);
  autoBattle.stuckDistance = num(params.stuckDistance, autoBattle.stuckDistance);
  autoBattle.stuckRetryLimit = rate(params.stuckRetryLimit, autoBattle.stuckRetryLimit);
  autoBattle.targetBanDuration = num(params.targetBanDuration, autoBattle.targetBanDuration);
  autoBattle.targetSearchInterval = num(params.targetSearchInterval, autoBattle.targetSearchInterval);
  autoBattle.arriveTolerance = num(params.arriveTolerance, autoBattle.arriveTolerance);
  autoBattle.teleportSnapRadius = num(params.teleportSnapRadius, autoBattle.teleportSnapRadius);
  autoBattle.dashSnapRadius = num(params.dashSnapRadius, autoBattle.dashSnapRadius);
}
