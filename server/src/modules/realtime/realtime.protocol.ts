/**
 * 实时通道：协议与常量（**唯一来源**）
 *
 * 这一层刻意做得极薄 —— 它要解决的是「有一条随时能说话的管子」，不是「说话的内容」。
 * 协议由三段组成：
 *
 * 1. 通道本身：连上先给一句 `welcome`（带上账号与心跳间隔，客户端据此配自己的定时器，
 *    而不是把间隔写死在客户端）；客户端发 `ping`，服务端回 `pong` —— **应用层**心跳。
 *    浏览器拿不到协议层的 ping/pong 帧（那是 `ws` 自己处理的），客户端要量往返、
 *    要判断「多久没响应算掉线」，只能靠自己发；
 * 2. 战斗指令（#34）：客户端发 `cast`（我放了什么技能、打向谁），服务端按**自己的属性表**
 *    算出结算结果回 `settle` —— 客户端从此只是表现层，不再自己决定伤害；
 *    `targetsReset` 清空该账号的幂等账（旧结果不该在新会话里继续重发）；
 * 3. 世界权威（#35）：客户端发 `worldJoin`（进图播种：地图 id + 刷怪计划），服务端持有
 *    怪物实例（hp / 存活 / 出生点，tick 驱动重生）并以 `world` 帧下发权威状态；
 *    实例 id 由服务端发牌，cast 的 targetId 用的就是它；
 * 4. 其余一律回 `error` 帧，**不断开连接** —— 一条不认识的消息不该让玩家的通道断掉。
 */

/** 实时通道的路径段；HTTP 的取票据接口与 WS 的升级路径共用它（写在一处就不会两边对不上） */
export const REALTIME_PATH = "realtime";

/**
 * 一条连接代表的身份
 *
 * 由 HTTP 那侧（`POST /realtime/ticket`）填进来 —— 也就是 **AuthGuard 的结论**。
 * 实时通道自己不产生身份，只是把它带过握手这一段。
 */
export interface RealtimeIdentity {
  /** 账号 id */
  id: string;
  /** 账号名 */
  username: string;
}

/** 服务端 → 客户端：连接就绪 */
export interface RealtimeWelcomeMessage {
  type: "welcome";
  data: RealtimeWelcome;
}

export interface RealtimeWelcome {
  /** 连接代表的账号 id */
  userId: string;
  /** 账号名（客户端展示用） */
  username: string;
  /** 服务端存活探测间隔（毫秒），客户端据此决定自己的空闲判定 */
  heartbeatMs: number;
  /** 服务端当前时间（毫秒）—— 客户端可据此算一次性的时钟偏移 */
  serverTime: number;
}

/** 客户端 → 服务端：应用层心跳 */
export interface RealtimePingMessage {
  type: "ping";
}

/** 服务端 → 客户端：心跳应答 */
export interface RealtimePongMessage {
  type: "pong";
  data: {
    serverTime: number;
  };
}

/** 服务端 → 客户端：这条消息处理不了（连接照旧） */
export interface RealtimeErrorMessage {
  type: "error";
  data: {
    message: string;
  };
}

//#region 战斗指令（#34：伤害结算上移服务端）

/** 客户端 → 服务端：出手（我放了什么技能、打向谁） */
export interface RealtimeCastMessage {
  type: "cast";
  data: {
    /**
     * 出手序号（**幂等键**）：同一次会话内单调递增。
     * 网络层重传 / 客户端重复投递同一序号时，服务端不重复结算，原样回上一次的结果。
     */
    castId: number;
    /** 技能 id（configs/skill，如 "1000" 基础剑术） */
    skillId: string;
    /**
     * 目标实例 id：客户端给场上每只怪生成的**会话内唯一**标识（世界权威前，怪还在客户端刷，
     * 实例身份只能它给；怪物的**数值**一律来自服务端的 MONSTER_COMBAT，不信任客户端）
     */
    targetId: string;
    /** 目标怪物 key（configs/monster 的关联键，如 "1"；服务端据此查战斗数值表） */
    monsterKey: string;
  };
}

/** 客户端 → 服务端：本账号记着的目标全部作废（换图时发；旧图的目标不该再结算） */
export interface RealtimeTargetsResetMessage {
  type: "targetsReset";
}

/** 结算结果（ok = 服务端真的算了一次） */
export interface RealtimeSettleOk {
  castId: number;
  ok: true;
  skillId: string;
  targetId: string;
  /** 本次伤害（服务端按自己的属性表算出，overkill 不截断 —— 血量才截断） */
  damage: number;
  /** 结算后目标剩余血量（0 = 死亡） */
  hp: number;
  maxHp: number;
  /** 目标是否死亡（由服务端判，客户端据此走死亡表现与掉落） */
  killed: boolean;
  /** true = 同一 castId 的重复投递，结果原样重发、未重复结算 */
  duplicate: boolean;
}

/** 结算被拒（ok = false；网络层连接不受影响） */
export interface RealtimeSettleError {
  castId: number;
  ok: false;
  /** 机器可读的拒绝原因（unknown_skill / skill_not_learned / unknown_target / target_dead / no_role / bad_request …） */
  code: string;
  message: string;
}

export type RealtimeSettleData = RealtimeSettleOk | RealtimeSettleError;

/** 服务端 → 客户端：一次出手的结算结果 */
export interface RealtimeSettleMessage {
  type: "settle";
  data: RealtimeSettleData;
}

//#endregion

//#region 世界权威（#35：地图实例 / 怪物状态 / tick 循环）

/**
 * 客户端 → 服务端：进图登记（播种）
 *
 * 刷怪**区域**配置住在客户端的 Tiled 地图文件里（服务端拿不到，素材也不入库），
 * 所以进图时由客户端把解析出的刷怪计划（每只怪的 monsterKey 与出生点）报上来。
 * 播种只发生在**空图**上：该图已有实例（其他账号先播种过 / 上次重启留下的）就整份沿用，
 * plan 被忽略 —— 权威状态（instanceId / hp / 存活）永远以下发的 `world` 帧为准。
 *
 * 换图也走这条消息：同一连接发新的 `worldJoin`，旧图的观看者身份随之移除。
 */
export interface RealtimeWorldJoinMessage {
  type: "worldJoin";
  data: {
    /** 地图 id（configs/map 的 key） */
    mapId: string;
    /** 刷怪计划：每只怪一条（数量 = 区域 max，位置为区域内随机落点） */
    spawnPlan: Array<{
      /** 怪物 key（configs/monster 的关联键；服务端据此查 MONSTER_COMBAT） */
      monsterKey: string;
      /** 出生点（世界坐标） */
      x: number;
      y: number;
    }>;
  };
}

/** 世界快照里的一只怪（权威状态；坐标 = 出生点，游走等表现层移动不在此列） */
export interface RealtimeWorldMonster {
  /** 实例 id（**服务端发牌**，全服唯一、跨重启稳定；cast 的 targetId 用它） */
  instanceId: string;
  monsterKey: string;
  /** 当前血量与上限（来自服务端 MONSTER_COMBAT） */
  hp: number;
  maxHp: number;
  /** 是否存活（false = 死亡等重生，客户端不生成这只怪） */
  alive: boolean;
  /** 出生点（世界坐标；客户端在此落怪，游走是本地表现） */
  x: number;
  y: number;
  /** 距重生还剩多少毫秒（死亡中的怪才有；客户端可据此显示重生倒计时之类） */
  respawnInMs?: number;
}

/** 服务端 → 客户端：一张地图的权威怪物状态（进图应答 + 重生等变化的广播） */
export interface RealtimeWorldMessage {
  type: "world";
  data: {
    mapId: string;
    /** 全量列表（规模 = 单图怪物数，最多几百只，全量比增量简单且不易漂移） */
    monsters: RealtimeWorldMonster[];
  };
}

//#endregion

/** 客户端会发出的全部消息 */
export type RealtimeClientMessage =
  | RealtimePingMessage
  | RealtimeCastMessage
  | RealtimeTargetsResetMessage
  | RealtimeWorldJoinMessage;

/** 服务端会发出的全部消息 */
export type RealtimeServerMessage =
  | RealtimeWelcomeMessage
  | RealtimePongMessage
  | RealtimeErrorMessage
  | RealtimeSettleMessage
  | RealtimeWorldMessage;

/**
 * 关闭码
 *
 * `1001` 是标准码（对端要走）；`4000` 起是应用自定义段 —— 用来区分「服务端要关了」
 * 与「你这个账号在别处又连了一条」。客户端据此决定要不要立刻重连：
 * 被替换掉的那条连接**不该**马上抢回来（否则两条连接会互相踢，来回刷）。
 */
export const REALTIME_CLOSE = {
  /** 服务端正在关闭（优雅关闭时发这个） */
  GOING_AWAY: 1001,
  /** 同一账号的新连接上线，本条被替换 */
  REPLACED: 4000,
} as const;
