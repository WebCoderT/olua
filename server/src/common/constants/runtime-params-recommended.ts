/**
 * 运行时参数的**默认推荐配置**（#1185）
 *
 * 七组的权威推荐值都在这一个常量里 —— 「一键还原」的落点、`config-sync.sql` 的出厂行、
 * 管理端 hint 里标的推荐值，三处都以它为准（e2e 里有断言锁死 seed 行与常量一致）。
 *
 * 为什么现在代码里可以有值了（#655 说过「值不在这里」）：#655 反对的是**读的时候静默回落**
 * —— 那会让「配漏了」看起来像「配了」。推荐配置是**显式动作**（管理端点「还原」/ 首启灌 seed），
 * 不是读路径的隐式兜底；读路径仍然是「库里有什么就是什么」，缺键照旧启动自检点名。
 *
 * 数值口径（用户 2026-11-23 拍板）：以运营在库里的现值为底（scatterMin 30 / ttlMs 10 秒 /
 * maxGround 1000 等手工调过的值），缺失的键按文档口径补齐（guild 10 级 / 10 万绑定元宝、
 * AI 牵引 600 / 1.5 倍速 / 20 秒超时、两道闸按 #811 / #1030 的出厂档位 log）。
 */

/** 掉落手感与绑定（`runtime_params.drop_params` 列；部分键服务端消费） */
export const RECOMMENDED_DROP_PARAMS = {
  autoPickupRadius: 40,
  /** 距离闸出厂开 120px（#817 的缺键默认）：推荐配置把两道机制都带上，关闸是运营的临时动作（0），不是出厂态 */
  pickAcceptRadius: 120,
  fullTipInterval: 1500,
  scatterMinDistance: 30,
  pickReplyTimeout: 5000,
  bindChance: 10,
  /**
   * 存活期出厂 3 分钟（#802 文档口径）：dev 库现值 10 秒是运营临时值（掉落测试不想等），
   * 不进推荐 —— 存活期压到 10 秒后，保护期无论取多少都会被钳满或盖不住拾取时序
   * （30 秒保护期是按 3 分钟存活期设计的，两者要一起回文档口径）。
   */
  ttlMs: 180000,
  /** 保护期出厂 30 秒（#802 文档口径，与 3 分钟存活期配套；0 是运营临时关闸，不进推荐） */
  protectMs: 30000,
  maxGroundPerMap: 1000,
  announceBoss: true,
  /** 全屏自动拾取出厂关闭（#1380）：与加键前行为完全一致，开启是运营的临时动作 */
  fullScreenPickup: false,
} as const;

/** 自动战斗与寻路（`runtime_params.auto_battle` 列；客户端消费） */
export const RECOMMENDED_AUTO_BATTLE_PARAMS = {
  maxTargetDistance: 0,
  moveByRun: true,
  classicWalkMode: false,
  classicStepLength: 100,
  cellSize: 40,
  clearance: 20,
  repathInterval: 1000,
  waypointTolerance: 14,
  stuckInterval: 500,
  stuckDistance: 8,
  stuckRetryLimit: 3,
  targetBanDuration: 5000,
  targetSearchInterval: 500,
  arriveTolerance: 20,
  teleportSnapRadius: 12,
  dashSnapRadius: 60,
} as const;

/** 帮会规则门槛（`runtime_params.guild_rules` 列；服务端校验消费） */
export const RECOMMENDED_GUILD_RULE_PARAMS = {
  nameMin: 2,
  nameMax: 12,
  noticeMax: 200,
  applicationMessageMax: 50,
  createLevelMin: 10,
  createCostBindGold: 100000,
} as const;

/** 怪物 AI 与脱战（`runtime_params.monster_ai` 列；服务端消费） */
export const RECOMMENDED_MONSTER_AI_PARAMS = {
  attackInterval: 2000,
  attackRange: 60,
  attackActionTime: 1000, // #1263：对齐攻击动画时长（1s），否则走位群战每刀都被追击切断
  pushDuration: 200,
  idleMoveInterval: [4000, 9000],
  idleMoveDuration: [300, 800],
  idleMoveSpeedScale: 0.5,
  wanderRadius: 60,
  leashRange: 600,
  returnSpeedRate: 1.5,
  returnTimeoutMs: 20000,
} as const;

/** 位移校验闸（`runtime_params.movement` 列；服务端消费，不下发客户端） */
export const RECOMMENDED_MOVEMENT_GUARD_PARAMS = {
  mode: "log",
  maxSpeed: 400,
  tolerance: 1.35,
  jitterPx: 24,
  wallCheck: true,
  correctIntervalMs: 500,
} as const;

/** 出手距离闸（`runtime_params.cast_range` 列；服务端消费，不下发客户端） */
export const RECOMMENDED_CAST_RANGE_PARAMS = {
  mode: "log",
  jitterPx: 24,
} as const;

/** AOI 推送口径（`runtime_params.aoi` 列，#1170；服务端消费，重启生效） */
export const RECOMMENDED_AOI_PARAMS = {
  cellSize: 512,
  maxEntities: 200,
  leaveDelayMs: 1000,
  broadcastHz: 10,
} as const;

/** 六组推荐值打包（`GET admin/runtime-params/recommended` 的形状） */
export const RECOMMENDED_RUNTIME_PARAMS = {
  drop: RECOMMENDED_DROP_PARAMS,
  autoBattle: RECOMMENDED_AUTO_BATTLE_PARAMS,
  guild: RECOMMENDED_GUILD_RULE_PARAMS,
  monsterAi: RECOMMENDED_MONSTER_AI_PARAMS,
  movement: RECOMMENDED_MOVEMENT_GUARD_PARAMS,
  castRange: RECOMMENDED_CAST_RANGE_PARAMS,
  aoi: RECOMMENDED_AOI_PARAMS,
} as const;

export type RecommendedRuntimeParams = typeof RECOMMENDED_RUNTIME_PARAMS;

/** 可单独还原的模块名（reset 路由与 switch 的判据；顺序即管理端页面顺序） */
export const RUNTIME_PARAM_MODULE_NAMES = [
  "drop",
  "autoBattle",
  "guild",
  "monsterAi",
  "movement",
  "castRange",
  "aoi",
] as const;

export type RuntimeParamModuleName = (typeof RUNTIME_PARAM_MODULE_NAMES)[number];
