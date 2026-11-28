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

/**
 * 掉落参数（手感那四个客户端消费；`bindChance` 与 `pickAcceptRadius` **服务端消费**）
 */
export interface DropRuntimeParams {
  /** 自动拾取半径（像素）：角色脚底与掉落物距离小于该值即拾取 */
  autoPickupRadius: number;
  /**
   * 服务端拾取距离闸（像素，#817 / #802）：玩家与掉落物**落点的距离**超过它，拾取请求直接拒。
   *
   * 与 `autoPickupRadius` 是**两把尺子**：那个是客户端「走到多近就自动发 pick」的手感，
   * 这个是服务端「认不认这一发 pick」的权威。故意不复用：手感可以调到 200 让大家图省事，
   * 但不能因此把「隔半张地图捡东西」变成合法操作。实际生效值取两者较大 —— 比自动拾取
   * 半径还小的闸只会把正常玩家拦在门外。
   *
   * 0 = 关闭校验（只用于排查问题，出货状态别设 0：等于把 #817 又打开）。
   */
  pickAcceptRadius: number;
  /** 背包已满时的提示 / 重试间隔（毫秒） */
  fullTipInterval: number;
  /** 多件掉落物的最小中心间距（像素）：同心环散落用 */
  scatterMinDistance: number;
  /** 服务端拾取应答的等待上限（毫秒）：超时视为本轮失败，允许重新拾取 */
  pickReplyTimeout: number;
  /**
   * 随机绑定概率（百分比 0~100，#789）
   *
   * 判定顺序见 `combat-settlement.service.rollDrops`：物品侧强制绑定、怪物侧强制绑定
   * 任一为真就直接绑；**两个都不为真**时才按这个概率掷一次。
   * 0 = 从不随机绑定（出厂值，等于「只有配置写死的那几件会绑」）。
   */
  bindChance: number;
  /**
   * 掉落物存活时长（毫秒，#802；默认 180000 = 3 分钟）
   *
   * 到点从地面消失并记一条 `expired` 流水。**末段零提示**（不闪、不变色、不显示秒数）：
   * 快消失的东西不该催玩家 —— 这是 2026-11-08 拍板的口径，所以没有 `warnMs` 这一列。
   */
  ttlMs: number;
  /** 归属保护期（毫秒，默认 30000）：这之前只有归属者与**掉落时**的同队队友能捡 */
  protectMs: number;
  /** 单图地面掉落上限（默认 200）：超出按 `createdAt` 挤掉最旧的（记 `overflow`） */
  maxGroundPerMap: number;
  /** boss 掉落是否发全服公告（默认 true；30 秒最多一条） */
  announceBoss: boolean;
}

/** 自动战斗 / 寻路参数（客户端消费；服务端只负责下发） */
export interface AutoBattleParams {
  /** 自动选目标的最大距离（像素，0 = 不限，全图取最近） */
  maxTargetDistance: number;
  /** 自动移动是否使用跑步速度 */
  moveByRun: boolean;
  /**
   * 经典走路模式（#1334，默认 false = 现状连续移动）。
   *
   * 开启后移动为**一格一步**的传奇式格子走动：寻路结果不做视线拉直（路点 = 逐格格心），
   * 角色必须走完当前这一格（落点钉在格心）才会开始下一步；步长恒为格子对角连线
   * （直格 cellSize / 斜格 cellSize×√2），不再补「精确目标点」——停在目标格心。
   * 客户端与 #811 服务端权威路径消费**同一个开关**，两端口径必须一致。
   */
  classicWalkMode: boolean;
  /** 经典走路模式每一步的距离（像素） */
  classicStepLength: number;
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

/** 帮会规则门槛（**服务端校验读它**：帮会名 / 公告 / 申请留言长度 + 建帮门槛） */
export interface GuildRuleParams {
  /** 帮会名最短字数 */
  nameMin: number;
  /** 帮会名最长字数 */
  nameMax: number;
  /** 帮会公告最长字数 */
  noticeMax: number;
  /** 入帮申请留言最长字数 */
  applicationMessageMax: number;
  /**
   * 建帮所需最低角色等级（#872）：小于它直接拒。
   *
   * 建帮是一次性、不可逆的社交行为，门槛的意义是「让第一天的新号先玩明白游戏」；
   * 0 = 不限等级（只用于临时放开，别当出货值）。
   */
  createLevelMin: number;
  /** 建帮消耗绑定元宝（#872）：0 = 免费。扣款与建帮同一事务，扣了必然建成 */
  createCostBindGold: number;
}

/** 三组一起下发（快照 `runtimeParams` 段就是它的形状） */
export interface RuntimeParams {
  drop: DropRuntimeParams;
  autoBattle: AutoBattleParams;
  guild: GuildRuleParams;
}

/**
 * 怪物 AI 参数（`runtime_params.monster_ai` 列）
 *
 * **服务端消费，不进客户端快照**：客户端一个字节都用不上（它只演服务端发下来的坐标与动作），
 * 所以这一组刻意不放进 `RuntimeParams` —— 混进去等于让「快照多一段」跟着一起变，
 * 而快照加段要动四处（DTO / snapshot / 客户端 `game-config` / `configs-sandbox`）。
 *
 * 出厂值在 `config-sync.sql`；代码里的 `FALLBACK_AI`（monster-ai.service）只是**读不出来时
 * 兜住进程**的最小可用值，不是第二份出厂值。
 */
export interface MonsterAiRuntimeParams {
  /** 普攻间隔（毫秒） */
  attackInterval: number;
  /** 普攻距离（像素） */
  attackRange: number;
  /** 施法硬直兜底（毫秒）：技能没配 `cast_lock_ms` 时用它 */
  attackActionTime: number;
  /** 击退时长（毫秒）：技能只配距离时用它换算击退速度 */
  pushDuration: number;
  /** 待机游走的间隔区间（毫秒，[min, max]） */
  idleMoveInterval: [number, number];
  /** 待机游走每次走多久（毫秒，[min, max]） */
  idleMoveDuration: [number, number];
  /** 游走速度倍率（乘在怪物 `moveSpeed` 上） */
  idleMoveSpeedScale: number;
  /** 游走活动半径（像素，围绕出生点） */
  wanderRadius: number;
  /** 牵引半径（像素）：目标跑出这个距离就脱战回家（#853） */
  leashRange: number;
  /** 回家速度倍率（乘在 `moveSpeed` 上；比追击快，免得玩家拖着怪遛） */
  returnSpeedRate: number;
  /** 回家超时（毫秒）：到点还没走回去就吸附到出生点 */
  returnTimeoutMs: number;
}

/** 怪物 AI 参数的键清单（管理端「保存后回读」与启动自检用） */
export const MONSTER_AI_PARAM_KEYS: Array<keyof MonsterAiRuntimeParams> = [
  "attackInterval",
  "attackRange",
  "attackActionTime",
  "pushDuration",
  "idleMoveInterval",
  "idleMoveDuration",
  "idleMoveSpeedScale",
  "wanderRadius",
  "leashRange",
  "returnSpeedRate",
  "returnTimeoutMs",
];

/**
 * 位移校验参数（`runtime_params.movement` 列，#811）
 *
 * **服务端消费，不进客户端快照**：客户端不需要知道闸门开在哪一档 ——
 * 它只认 `posCorrect` 帧（被拉回时照做）。知道档位等于告诉作弊者「现在关着」。
 *
 * 出厂值在 `config-sync.sql`；代码里的 `FALLBACK_MOVEMENT`（`movement-guard.service`）
 * 只是**读不出来时兜住进程**的最小可用值，不是第二份出厂值 —— 两处刻意不同：
 * 兜底档位是 `off`（读不到配置就别拦人），出厂档位是 `log`（记账但放行）。
 */
export interface MovementGuardParams {
  /**
   * 档位（#811 拍板「配置化 + 可热切」）
   *
   * - `off`：完全不校验，行为与 #811 之前一模一样（回滚用）；
   * - `log`：**出厂值**。照常校验、照常采纳，只记流水与计数 —— 上线先跑一周看误伤率；
   * - `enforce`：校验失败即丢弃该帧 + 立刻回一帧 `posCorrect` 把客户端拉回权威位置。
   *
   * 认不出的值按 `log` 处理（拼错不该让全服的人突然被拉回）。
   */
  mode: "off" | "log" | "enforce";
  /**
   * 速度上限（像素 / 秒，出厂 400）
   *
   * 服务端**没有**角色移速属性（移速只存在于客户端刚体与怪物 `move_speed`），
   * 所以这里是一把**全局尺子**而不是「角色移速 × 1.5」：400 已接近实测跑步速度
   * （约 128px/s）的 3 倍，正常移动含卡顿追帧都碰不到，瞬移一跨就是几倍。
   */
  maxSpeed: number;
  /** 容差倍率（乘在上限上，出厂 1.35）：留给物理刚体的加减速与插值 */
  tolerance: number;
  /** 抖动余量（像素，出厂 24）：抵掉坐标取整与 4Hz 上报的相位差 */
  jitterPx: number;
  /**
   * 穿墙校验开关（出厂 true）
   *
   * 与档位分开：碰撞盒数据出问题（某个图漏配 / 多配）时能先关这一项止血，
   * 不必连速度校验一起关掉。
   */
  wallCheck: boolean;
  /**
   * 同一连接两次 `posCorrect` 的最小间隔（毫秒，出厂 500）
   *
   * 4Hz 上报、每帧都可能是拒绝帧 —— 不节流的话一个作弊客户端每秒收 4 帧拉回，
   * 而他要的正是「刷帧」。500ms 足够让正常玩家立刻对齐，又不给刷帧留余地。
   */
  correctIntervalMs: number;
}

/** 位移校验参数的键清单（启动自检 + 管理端回读用） */
export const MOVEMENT_GUARD_KEYS: Array<keyof MovementGuardParams> = [
  "mode",
  "maxSpeed",
  "tolerance",
  "jitterPx",
  "wallCheck",
  "correctIntervalMs",
];

/**
 * 出手距离闸参数（`runtime_params.cast_range` 列，#1030）
 *
 * **服务端消费，不进客户端快照**：客户端本地已经按 `canAttackTarget` 判过一遍距离，
 * 不需要知道服务端闸门开在哪一档 —— 知道档位等于告诉作弊者「现在关着」
 * （与 `MovementGuardParams` 同一取向）。
 *
 * 为什么单独一列而不是并进 `movement`：两者要能**分别**回滚。距离闸误伤时只关它
 * 一档即可，不必把速度 / 穿墙校验一起关掉。
 *
 * 出厂值在 `config-sync.sql`（`log`）；代码里的 `FALLBACK_CAST_RANGE` 只是读不出来时
 * 兜住进程的最小可用值（`off`）—— 两处刻意不同：一个运营口径，一个进程兜底。
 */
export interface CastRangeParams {
  /**
   * 档位（与位移校验同名同义）
   *
   * - `off`：完全不判，行为与 #1030 之前一样（回滚用）；
   * - `log`：**出厂**。照判、照放行，只记流水与计数 —— 先跑一周看误伤率；
   * - `enforce`：超距即拒该次出手（`rejected: "range"`）。
   *
   * 认不出的值按 `log` 处理（拼错不该让全服突然打不出技能）。
   */
  mode: "off" | "log" | "enforce";
  /**
   * 抖动余量（像素，出厂 24）
   *
   * 抵掉两端位置的时间差：客户端 10Hz 上报的相位差（移速约 128px/s ⇒ 一拍约 13px）
   * 与怪物插值滞后（100ms ⇒ 一拍）。取值与 `movement.jitterPx` 同源 —— 都是
   * 「同一份坐标在不同时刻被读到」的误差，没有理由用两个数。
   */
  jitterPx: number;
}

/** 出手距离闸的键清单（启动自检 + 管理端回读用） */
export const CAST_RANGE_KEYS: Array<keyof CastRangeParams> = ["mode", "jitterPx"];

/**
 * AOI 推送口径（`runtime_params.aoi` 列，#1170）
 *
 * **服务端消费，不进客户端快照**：视野裁剪是推送架构的事，客户端只管收帧，
 * 知道格子边长对它没有任何用处。
 *
 * 与 monster_ai / movement / cast_range 同性质（一进程一份、运营可调、服务端独占），
 * 所以进 `runtime_params` 单行表而不是另开一张表。**生效时机是重启**：格子边长变了
 * 等于把所有已成形的索引作废（实体在旧格里的位置全错），运行中热切会出现
 * 「一半房间按 512 建、一半按新值建」的时段 —— 所以四个参数统一启动时读一次，
 * 管理端改完提示「重启后生效」。
 *
 * 出厂值在 `config-sync.sql`（512 / 200 / 1000 / 10）；代码里的 `AOI_CELL` 等常量
 * （aoi-math.ts）只是**读不出来时兜住进程**的最小可用值，兼作纯函数的缺省参，
 * 不是第二份出厂值。
 */
export interface AoiRuntimeParams {
  /** 格子边长（像素，出厂 512）：8192² 的图 → 16×16 = 256 格；一格视野 = 3×3 共 ±768px */
  cellSize: number;
  /** 单帧实体上限（出厂 200）：超出只留离格心最近的 N 个，防「怪围上来」把帧顶爆 */
  maxEntities: number;
  /** 离开视野延迟（毫秒，出厂 1000）：边界来回走不闪（期内又看见就取消离开） */
  leaveDelayMs: number;
  /** 互见广播节拍（Hz，出厂 10）：格子索引与进出差量每拍跑一次 */
  broadcastHz: number;
}

/** AOI 参数的键清单（管理端「保存后回读」与启动自检用） */
export const AOI_PARAM_KEYS: Array<keyof AoiRuntimeParams> = [
  "cellSize",
  "maxEntities",
  "leaveDelayMs",
  "broadcastHz",
];

/** 三组的键清单（**启动自检用**：库里少了哪个键就点名报错，不静默补默认值） */
export const RUNTIME_PARAM_KEYS: Record<keyof RuntimeParams, string[]> = {
  drop: [
    "autoPickupRadius",
    "pickAcceptRadius",
    "fullTipInterval",
    "scatterMinDistance",
    "pickReplyTimeout",
    "bindChance",
    // #802：地面实体的存活 / 保护期 / 容量 / 公告（距离闸沿用上面的 pickAcceptRadius）
    "ttlMs",
    "protectMs",
    "maxGroundPerMap",
    "announceBoss",
  ],
  autoBattle: [
    "maxTargetDistance",
    "moveByRun",
    "classicWalkMode",
    "classicStepLength",
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
  guild: ["nameMin", "nameMax", "noticeMax", "applicationMessageMax", "createLevelMin", "createCostBindGold"],
};
