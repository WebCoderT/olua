/**
 * 客户端运行时参数的**形状**（值不在这里，#655）
 *
 * 三组参数（掉落手感 / 自动战斗 / 帮会门槛）住在 `runtime_params` 单行表的三列 JSON 里，
 * 出厂值在 `server/data/config-sync.sql`。这里只有类型 —— 因为 JSON 列没法用建表语句约束，
 * 消费方（`guild.service` 校验帮会名长度、快照下发）需要一个编译期形状。
 *
 * 键集也**不在代码里复制一份**：读出来是什么键，就用什么键；缺键由 `RuntimeParamsService`
 * 在启动时点名报错（见那边的 `missingKeys`）。这样「加一个参数」只需要改库 + 管理端页面，
 * 不必再同步一个 TS 常量。
 */

/** 掉落物手感参数（客户端消费；服务端只负责下发） */
export interface DropRuntimeParams {
  /** 自动拾取半径（像素）：角色脚底与掉落物距离小于该值即拾取 */
  autoPickupRadius: number;
  /** 背包已满时的提示 / 重试间隔（毫秒） */
  fullTipInterval: number;
  /** 多件掉落物的最小中心间距（像素）：同心环散落用 */
  scatterMinDistance: number;
  /** 服务端拾取应答的等待上限（毫秒）：超时视为本轮失败，允许重新拾取 */
  pickReplyTimeout: number;
}

/** 自动战斗 / 寻路参数（客户端消费；服务端只负责下发） */
export interface AutoBattleParams {
  /** 自动选目标的最大距离（像素，0 = 不限，全图取最近） */
  maxTargetDistance: number;
  /** 自动移动是否使用跑步速度 */
  moveByRun: boolean;
  /** A* 网格单元边长（像素）：越小越贴合障碍、搜索越慢 */
  cellSize: number;
  /** 通行余量（像素）：障碍矩形向外扩张这么多再烙进网格 */
  clearance: number;
  /** 重新寻路间隔（毫秒） */
  repathInterval: number;
  /** 到达路点的判定半径（像素） */
  waypointTolerance: number;
  /** 卡住检测间隔（毫秒） */
  stuckInterval: number;
  /** 卡住判定：该间隔内位移小于此值视为卡住（像素） */
  stuckDistance: number;
  /** 连续卡住多少次后放弃当前目标 */
  stuckRetryLimit: number;
  /** 被放弃目标的拉黑时长（毫秒） */
  targetBanDuration: number;
  /** 场上没目标时，隔多久再找一次（毫秒） */
  targetSearchInterval: number;
  /** 点击寻路的到达判定半径（像素） */
  arriveTolerance: number;
  /** 传送落点吸附半径（格） */
  teleportSnapRadius: number;
  /** 突进类技能的落点吸附半径（像素） */
  dashSnapRadius: number;
}

/** 帮会规则门槛（**服务端校验读它**：帮会名 / 公告 / 申请留言长度） */
export interface GuildRuleParams {
  /** 帮会名最短字数 */
  nameMin: number;
  /** 帮会名最长字数 */
  nameMax: number;
  /** 帮会公告最长字数 */
  noticeMax: number;
  /** 入帮申请留言最长字数 */
  applicationMessageMax: number;
}

/** 三组一起下发（快照 `runtimeParams` 段就是它的形状） */
export interface RuntimeParams {
  drop: DropRuntimeParams;
  autoBattle: AutoBattleParams;
  guild: GuildRuleParams;
}

/** 三组的键清单（**启动自检用**：库里少了哪个键就点名报错，不静默补默认值） */
export const RUNTIME_PARAM_KEYS: Record<keyof RuntimeParams, string[]> = {
  drop: ["autoPickupRadius", "fullTipInterval", "scatterMinDistance", "pickReplyTimeout"],
  autoBattle: [
    "maxTargetDistance",
    "moveByRun",
    "cellSize",
    "clearance",
    "repathInterval",
    "waypointTolerance",
    "stuckInterval",
    "stuckDistance",
    "stuckRetryLimit",
    "targetBanDuration",
    "targetSearchInterval",
    "arriveTolerance",
    "teleportSnapRadius",
    "dashSnapRadius",
  ],
  guild: ["nameMin", "nameMax", "noticeMax", "applicationMessageMax"],
};
