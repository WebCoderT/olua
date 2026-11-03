/**
 * 客户端运行时参数（#605）—— **唯一书写处**
 *
 * 这批数值原来只写在客户端 `configs/drop.ts` / `configs/autoBattle.ts` 与服务端
 * `common/constants/social.ts` 里：运营想调「捡东西的手感」「自动战斗的黏人程度」
 * 「帮会名能起多长」都得改代码发版。收权后它们统一是配置：
 *
 *   `shared/runtime-seed.ts`（本文件，出厂值）→ 启动 seed 进 `runtime_params` 单行表
 *   → 管理端「运行时参数」页可改 → 快照 `runtimeParams` 段下发 → 客户端覆写本地参数
 *
 * ## 什么该进这里、什么不该
 * - **进**：影响玩法手感 / 判定门槛的**数值与开关**（拾取半径、寻路网格、重试上限、
 *   帮会名长度…）。这类值运营会调，且调完不需要客户端发版。
 * - **不进**：纯表现（颜色 / 间距 / 圆点半径 / 文案）。`configs/autoBattle.routeLine`
 *   的 `Color`、`Size` 就属于这一类 —— 它们连序列化成 JSON 都别扭，留在客户端。
 * - **不进**：客户端资源路径（`icon` / `out`），那是素材约定，不是运营参数。
 *
 * ## 为什么服务端也要这份
 * `guild.*` 三个值是**校验门槛**：建帮 / 改公告的合法性由服务端判（#388 起客户端
 * 提示只是提前反馈），所以服务端必须能读到同一份数字 —— 客户端改配置只能让提示更宽松
 * 或更严格，改不了能不能过。同理，`drop.*` / `autoBattle.*` 服务端不消费，只负责下发。
 *
 * 改这里的值 = 改出厂值（只对新库 / 没被运营改过的键生效，`INSERT OR IGNORE` 幂等）。
 */
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

/** 三个分组一起下发（快照 `runtimeParams` 段就是它的形状） */
export interface RuntimeParams {
  drop: DropRuntimeParams;
  autoBattle: AutoBattleParams;
  guild: GuildRuleParams;
}

/**
 * 出厂值
 *
 * `drop.*` / `autoBattle.*` 逐值照搬收权前客户端 `configs/drop.ts` /
 * `configs/autoBattle.ts` 的字面量 —— **收权当天玩法一点都不能变**，
 * 改数值是后续的运营动作，不是这次重构的副作用。
 * `guild.*` 来自原本写死在 `common/constants/social.ts` 的四个常量。
 */
export const RUNTIME_PARAMS: RuntimeParams = {
  drop: {
    // 取值 = 图标半宽 20 + 脚部容差 20
    autoPickupRadius: 40,
    fullTipInterval: 1500,
    // 取值 = 图标 40 + 12 留白
    scatterMinDistance: 52,
    pickReplyTimeout: 5000,
  },
  autoBattle: {
    maxTargetDistance: 0,
    moveByRun: true,
    cellSize: 40,
    clearance: 20,
    repathInterval: 400,
    waypointTolerance: 14,
    stuckInterval: 500,
    stuckDistance: 8,
    stuckRetryLimit: 3,
    targetBanDuration: 5000,
    targetSearchInterval: 500,
    arriveTolerance: 20,
    teleportSnapRadius: 12,
    dashSnapRadius: 60,
  },
  guild: {
    nameMin: 2,
    nameMax: 12,
    noticeMax: 200,
    applicationMessageMax: 50,
  },
};
