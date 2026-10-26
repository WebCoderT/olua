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
 * 掉落拾取（#325）同走这条管子：客户端发 `pick`（拾哪一次击杀的第几件掉落），
 * 服务端按账本原子入包并以 `picked` 帧回结果。
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
     * 实例身份只能它给；怪物的**数值**一律来自服务端的 monsters 表，不信任客户端）
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
  /** 击杀奖励（#316 起由服务端结算；仅 killed 时携带——经验入账与掉落内容都以此为准） */
  reward?: RealtimeKillReward;
  /** true = 同一 castId 的重复投递，结果原样重发、未重复结算 */
  duplicate: boolean;
}

/**
 * 一次击杀的奖励（#316：经验与掉落的结算都在服务端）
 *
 * - 经验：服务端按自己的成长标量（growth_scalars）与等级经验表（level_exps）算出入账，
 *   **落账在先**——`level / expNow / revision` 就是入账后的角色状态，客户端照着演即可；
 * - 掉落：读 monster_drops / drop_tables 表（管理端改值即时生效）按权重/概率/数量抽取，
 *   客户端只负责把列表铺到地面演拾取，「掉什么、掉多少」不再是客户端的决定。
 */
export interface RealtimeKillReward {
  /** 本次入账的经验（等级差过大无经验时为 0） */
  exp: number;
  /** 入账后的角色等级 */
  level: number;
  /** 入账后的当前经验（本级进度） */
  expNow: number;
  /** 升到下一级所需经验（已满级为 0） */
  expNeed: number;
  /** 本次是否升了级（可能连升多级，客户端据此播升级表现） */
  leveledUp: boolean;
  /** 经验入账后的角色修订号（exp = 0 时与入账前相同） */
  revision: number;
  /** 掉落结果（同一物品已合并数量；可为空数组——这次什么都没掉） */
  drops: Array<{ goodId: string; count: number }>;
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
 * 客户端 → 服务端：进图登记（#295 阶段一：刷怪区归服务端，客户端只报图 id）
 *
 * 刷怪区域配置已从 Tiled 导入服务端（map_spawn_areas 表），播种完全由服务端完成 ——
 * 客户端不再解析 Tiled 刷怪组、不再上报计划。播种只发生在**空图**上：该图已有实例
 * （其他账号先进过 / 上次重启留下的）就整份沿用 —— 权威状态（instanceId / hp / 存活）
 * 永远以下发的 `world` 帧为准。
 *
 * 换图也走这条消息：同一连接发新的 `worldJoin`，旧图的观看者身份随之移除。
 */
export interface RealtimeWorldJoinMessage {
  type: "worldJoin";
  data: {
    /** 地图 id（configs/map 的 key） */
    mapId: string;
  };
}

/** 世界快照里的一只怪（权威状态；坐标 = 出生点，游走等表现层移动不在此列） */
export interface RealtimeWorldMonster {
  /** 实例 id（**服务端发牌**，全服唯一、跨重启稳定；cast 的 targetId 用它） */
  instanceId: string;
  monsterKey: string;
  /** 当前血量与上限（来自服务端 monsters 表） */
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

//#region 怪物 AI（#323：目标选择 / 移动 / 普攻与玩家受击的权威都在服务端）

/**
 * 客户端 → 服务端：位置上报（节流发送；服务端 AI 用它做目标检测与追击）
 *
 * 服务端**不持有玩家位置的权威**（移动预测仍在客户端），但 AI 的检测范围 / 普攻距离
 * 都要拿「玩家在哪」做输入 —— 这条帧就是那个输入。hp 一并带上：服务端用「上报时刻的
 * 血量」判断目标是否已死（权威血量以 applyMonsterHit 落账与后续 hit 帧为准）。
 * 超过 `MONSTER_AI_POS_STALE_MS` 没上报的玩家视作离场，怪物不再追击。
 */
export interface RealtimePositionMessage {
  type: "pos";
  data: {
    /** 当前所在地图（AI 按 zone:map 分域找目标候选） */
    mapId: string;
    /** 玩家世界坐标 */
    x: number;
    y: number;
    /** 上报时刻的玩家血量（<= 0 视作死亡，不再被选为目标） */
    hp: number;
    /**
     * 上报时刻是否在移动（#324：客户端自报，互见广播的「走路 / 待机」演出依据）。
     * 服务端没有玩家移动的权威，只有客户端自己知道 —— 缺省按未移动处理（旧客户端兼容）。
     */
    moving?: boolean;
  };
}

/** 怪物 AI 广播帧里的一只怪（只发有变化的：位置变了或移动标记变了） */
export interface RealtimeMonsterAiEntry {
  instanceId: string;
  /** 服务端模拟出的当前坐标（世界坐标；与 world 帧的出生点同一坐标系） */
  x: number;
  y: number;
  /** 是否在移动（客户端据此播走路 / 待机；方向由客户端按位移差量自算） */
  moving: boolean;
}

/** 怪物 AI 广播帧里的一次普攻命中（玩家受击的权威结果） */
export interface RealtimeMonsterHit {
  instanceId: string;
  /** 受击账号（广播给全图观看者；#324 玩家互见之前客户端只演自己的） */
  accountId: string;
  damage: number;
  /** 受击后玩家剩余血量（服务端已落账，客户端照搬） */
  hp: number;
  maxHp: number;
}

/**
 * 怪物释放技能（#372）：纯演出指令
 *
 * 与 `hits` 分开的原因：状态型技能**不产生伤害**（只给自己挂 buff），
 * 而伤害型技能的「动作 + 特效」要靠技能配置里的 action / effect 播 ——
 * 两者都只需要「谁放了什么」，伤害数值仍走 hits（客户端不重算）。
 *
 * `statusId` 有值 = 这次释放给怪物自己挂了这个状态（客户端据此在怪物身上播状态特效）；
 * 服务端已经按状态修正过后续伤害，客户端只演。
 */
export interface RealtimeMonsterCast {
  instanceId: string;
  skillId: string;
  statusId?: string;
}

/** 服务端 → 客户端：怪物 AI 广播（位置增量 + 普攻/技能命中事件 + 技能释放，按地图分发给观看者） */
export interface RealtimeMonsterAiMessage {
  type: "monster-ai";
  data: {
    mapId: string;
    monsters: RealtimeMonsterAiEntry[];
    hits: RealtimeMonsterHit[];
    /** #372：这一拍释放的技能（含状态型；没有技能释放时是空数组，不是 undefined） */
    casts: RealtimeMonsterCast[];
  };
}

//#endregion

//#region 玩家互见（#324：同图玩家的位置 / 血量 / 移动标记互见，纯演出无权威）

/**
 * 玩家互见广播帧里的一名玩家
 *
 * 只发「别人眼里的你」需要的东西：位置（客户端自报的最近一次上报）、血量（血条演出）、
 * 移动标记（走路 / 待机演出）。账号名在连接建连时就有（RealtimeIdentity.username），
 * 顺手带上省得客户端再查一次。
 */
export interface RealtimePlayerEntry {
  accountId: string;
  /** 显示名（角色名优先，缺省回落账号名；服务端首见时查一次缓存住） */
  username: string;
  /**
   * 角色 id（#389）
   *
   * 客户端拿它跟自己的社交快照（好友 / 敌人里的 roleId）比对，算出「这个人是好友还是敌人」。
   * 只发账号 id 是不够的：社交关系是按**角色**记的，一个账号可能有多个角色。
   * 没角色（未选角 / 存档被删）时为空串 —— 那时连名字都只有账号名，不存在关系。
   */
  roleId: string;
  /**
   * 所属帮会 id（#389；空串 = 无帮会）
   *
   * 同帮的人名字是蓝的 —— 判定要「我的 guildId」与「他的 guildId」相等，
   * 所以两边都得带。帮会名一并下发，社交面板与悬浮提示直接用，不必再查一次。
   */
  guildId: string;
  /** 所属帮会名（#389；空串 = 无帮会） */
  guildName: string;
  x: number;
  y: number;
  hp: number;
  /** 资源上限（血条分母；服务端在首次见到该玩家时查一次在线角色缓存住） */
  maxHp: number;
  /** 是否在移动（客户端自报；方向由位移差量自算） */
  moving: boolean;
  /** 外观（#383：对方穿什么、拿什么、有没有时装） */
  appearance: RealtimePlayerAppearance;
}

/**
 * 一名远端玩家的外观（#383）
 *
 * 只带「拼出这个人长什么样」的最小集合 —— 与客户端 `entities/Role` 的对应字段同名，
 * 客户端拿去填一个轻量对象就能直接复用 `RoleAppearance` 的装配逻辑（帧目录取源、
 * 时装 > 装备衣服 > 性别默认身体的优先级都在那一处）。
 *
 * **不含几何**（outPositions / outScale）：那是装备表里的常量，客户端自己查得到，
 * 不必每人每帧带一份。
 */
export interface RealtimePlayerAppearance {
  /**
   * 性别（`"1"` 男 / `"2"` 女，与客户端 SEX 枚举同形）：没穿衣服时用它选默认身体。
   * 历史存档里也可能是数字 1/2，服务端读的时候统一转成字符串
   */
  sex: string;
  /** 衣服装备 id（`""` = 没穿，客户端按性别回落默认身体） */
  cloth: string;
  /** 武器装备 id（`""` = 没拿，客户端隐藏武器节点） */
  weapon: string;
  /** 时装 id（`""` = 没穿时装；与 fashions 表主键同形，如 cloth_2） */
  fashion: string;
}

/**
 * 服务端 → 客户端：玩家互见广播（按地图分发给观看者）
 *
 * `full = true` 是快照兜底：worldJoin 应答之后立刻发给**刚进图的连接自己**一份全量
 * （别人的位置它一无所知，增量帮不上忙）。其余都是增量：只带「有变化的玩家」与
 * 「刚离开的账号」—— 超时没上报 / 断线 / 换图都会以 left 的形式广播。
 */
export interface RealtimePlayersMessage {
  type: "players";
  data: {
    mapId: string;
    /** true = 全量快照（观看者刚进图，或服务端认为它需要重建集合） */
    full: boolean;
    players: RealtimePlayerEntry[];
    /** 已离开的账号（增量帧用；full 帧里恒为空数组） */
    left: string[];
  };
}

//#endregion

//#region 掉落拾取（#325：地面掉落物归属击杀者，拾取入包的权威在服务端）

/**
 * 客户端 → 服务端：拾取一次击杀的掉落
 *
 * 掉落内容在 settle 帧的 `reward.drops` 里（只发给击杀者本人 —— 归属天然成立，别
 * 的账号既看不到也没有账可查），这里用「击杀那次的 castId + drops 数组下标」定位。
 * 服务端按账本里的那一条做**格子级入包**（药品/材料可叠加、装备占一格），背包放不下
 * 整份就拒拾（地面掉落物保留）；成功后该下标标记已拾，重复拾取幂等应答、不重复入包。
 *
 * 为什么走帧不走 HTTP：settle 的幂等账（掉落账本随之）在**实时进程**的内存里，
 * HTTP 进程拿不到 —— 跨进程要么落库一张表要么把账本挪走，都比一条帧贵。
 */
export interface RealtimePickMessage {
  type: "pick";
  data: {
    /** 击杀那次的出手序号（settle 帧 reward 所在的那条 castId） */
    castId: number;
    /** reward.drops 的数组下标 */
    index: number;
  };
}

/** 拾取入包后实际写入的背包格子（叠加进已有堆 = 那一格更新后的形状；装备 = 新占的格子） */
export interface RealtimePlacedCell {
  row: number;
  col: number;
  id: string;
  count: number;
}

/** 拾取成功（含幂等重放：该掉落此前已拾取过，placed 为空、revision 原样） */
export interface RealtimePickedOk {
  castId: number;
  index: number;
  ok: true;
  /**
   * 拾取后的角色修订号：入包推进了 revision，客户端照搬做新基线，
   * 否则下一次防抖存档就会撞乐观锁。幂等重放时与当前值一致。
   */
  revision: number;
  /** 本次实际写入的格子（幂等重放为空数组） */
  placed: RealtimePlacedCell[];
  /** true = 该掉落此前已拾取过（重复拾取的幂等应答，未重复入包） */
  alreadyPicked: boolean;
}

/** 拾取被拒（地面掉落物保留，背包满时可稍后再试） */
export interface RealtimePickedError {
  castId: number;
  index: number;
  ok: false;
  /** 机器可读的拒绝原因（bad_request / unknown_drop / bag_full / no_role / role_kicked / pick_failed） */
  code: string;
  message: string;
}

export type RealtimePickedData = RealtimePickedOk | RealtimePickedError;

/** 服务端 → 客户端：一次拾取的结果 */
export interface RealtimePickedMessage {
  type: "picked";
  data: RealtimePickedData;
}

//#endregion

/** 服务端会发出的全部消息 */
export type RealtimeServerMessage =
  | RealtimeWelcomeMessage
  | RealtimePongMessage
  | RealtimeErrorMessage
  | RealtimeSettleMessage
  | RealtimeWorldMessage
  | RealtimeMonsterAiMessage
  | RealtimePlayersMessage
  | RealtimePickedMessage;

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
