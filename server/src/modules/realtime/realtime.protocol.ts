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
 *    进图门槛（#606）也在这一段：客户端先发 `mapEnter` 问一句（回 `mapEnterResult`），
 *    落地时 `worldJoin` 再判一次 —— 判据只有服务端一处（`MapService.enterRejectOf`）；
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
    /**
     * 业务码（#399 起带上）
     *
     * 只有需要客户端分辨「哪一种拒绝」的帧才带（队伍：满员 50122 / 只有队长能踢 50124…）——
     * 客户端拿码决定提示语，拿不到就只用 message。老客户端忽略这个字段即可。
     */
    code?: number;
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
    /**
     * 区域 / 群体技能的作用点（世界坐标；#824）
     *
     * 只有 `target_type` 不是单体（0 区域 / 2 群体）时才有意义 —— 这类技能的「目标」
     * 是一块地，不是一只怪。**服务端不信这个坐标**：会先按施法者位置把它夹到
     * `skills.distance` 半径内再算命中集合（与客户端 `skill_1008` 的 `Math.min(travel, distance)`
     * 同一口径），所以改包报一个远处落点也打不到半径外的东西。
     */
    x?: number;
    y?: number;
  };
}

/** 客户端 → 服务端：本账号记着的目标全部作废（换图时发；旧图的目标不该再结算） */
export interface RealtimeTargetsResetMessage {
  type: "targetsReset";
}

/**
 * 生效中的一个状态（#822）：客户端图标栏的权威数据
 *
 * 整份快照下发（不是增量）：客户端 `StatusManager` 按它**整表重建**，不做加加减减 ——
 * 增量协议里「漏了一条」的后果是图标永远不消失，而整表重建最多错一次。
 */
export interface RealtimeStatusEntry {
  /** 状态 id（statuses.id，客户端据此查图标 / 特效 / 名称） */
  id: string;
  /** 层数（本轮恒为 1；叠层规则随 docs/22 §2.3 一起做） */
  stacks: number;
  /** 还剩多少毫秒（客户端按它本地倒计时，不必服务端再推一次到期帧） */
  remainingMs: number;
}

/**
 * 群体 / 区域技能命中的一只（#824）
 *
 * 一次施放可能打中多只，每一只的伤害都是独立掷的（各自的攻击区间随机、各自吃自己的防御），
 * 所以这里必须逐只给结果 —— 拿一次掷骰的结果套到 N 只身上会让「同一刀打死五只」变得可预测。
 * 击杀奖励也逐只算（经验各自按击杀者与那只怪的等级差算，掉落各自抽），所以 `reward` 在这个
 * 层级而不是顶层。
 */
export interface RealtimeSettleHit {
  targetId: string;
  monsterKey: string;
  damage: number;
  hp: number;
  maxHp: number;
  killed: boolean;
  /** 这一只被击杀时的奖励（只有 killed 才带） */
  reward?: RealtimeKillReward;
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
  /**
   * 群体 / 区域技能命中的每一只（#824）
   *
   * **单体技能不带这个字段**（继续读顶层 `targetId` / `damage` / `killed`）。
   * 区域技能一定带：打空时是空数组 —— 客户端据此区分「没打中」与「这是单体技能」。
   * 顶层那几个字段在区域技能里等于 `hits[0]`（最近的一只），只为旧客户端不炸而保留。
   */
  hits?: RealtimeSettleHit[];
  /**
   * true = 这一发**不掷伤害**（#824：自身技能 / 位移技能 / 没配伤害系数的区域技能）
   *
   * 此时 `damage` / `hp` / `maxHp` 是 0 占位，`hits` 为空数组。客户端**不要**拿它去改血条。
   * 与 `statusOnly` 的分工：那个是「挂了状态」（#822），这个是「这一发本来就没有伤害」——
   * 十步一杀（1008）就是纯位移，配置里 `damage_coefficients` 是空数组。
   */
  noDamage?: true;
  /**
   * true = 这一发是**状态型技能**（`skills.category = "2"`，护体神盾 / 金刚护体）
   *
   * 此时 `damage` / `hp` / `maxHp` 是 0 占位、`targetId` 可能为空 —— 客户端**不要**
   * 按这帧去改怪的血条，只按 `statuses` 刷新自己的图标（#822）。
   */
  statusOnly?: true;
  /** 这一发施加的状态 id（`statusOnly` 时给；客户端可用来播一次身上的特效） */
  appliedStatus?: string;
  /**
   * 本账号此刻**全部**生效中的状态（#822；整份快照，缺省 = 没变 / 老服务端）
   *
   * 出伤与状态型技能都带：客户端只有这一个通道能拿到权威状态，漏了就退回本地硬撑。
   */
  statuses?: RealtimeStatusEntry[];
}

/**
 * 一次击杀的奖励（#316：经验与掉落的结算都在服务端）
 *
 * - 经验：服务端按自己的成长标量（growth_scalars）与等级表（role_levels.exp）算出入账，
 *   **落账在先**——`level / expNow / revision` 就是入账后的角色状态，客户端照着演即可；
 * - 掉落：读 monster_drops / drop_tables 表（管理端改值即时生效）按权重/概率/数量抽取，
 *   客户端只负责把列表铺到地面演拾取，「掉什么、掉多少」不再是客户端的决定。
 */
/**
 * 一次击杀掉落里的一件（#789 起带绑定）
 *
 * `bound` 由服务端在抽取时判定（物品强制 / 怪物强制 / 随机三选一），客户端只用来
 * 在飘落与地面上做展示；真正的绑定写在背包格子上，拾取时随 `picked` 帧回来。
 */
export interface RealtimeDropEntry {
  goodId: string;
  count: number;
  /** 是否绑定角色（不可交易） */
  bound: boolean;
}

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
  drops: RealtimeDropEntry[];
}

/** 结算被拒（ok = false；网络层连接不受影响） */
export interface RealtimeSettleError {
  castId: number;
  ok: false;
  /** 机器可读的拒绝原因（unknown_skill / skill_not_learned / unknown_target / target_dead / no_role / bad_request …） */
  code: string;
  message: string;
  /**
   * 判定链的六道闸拒绝原因（#813 / A3）：`dead` / `cross_map` / `range` / `cooldown` / `mp` / `rate`
   *
   * 与 `code` 的关系：`code` 是老字段、什么都可能是（协议错、未知目标、闸拒绝）；
   * `rejected` 只在**闸拒绝**时出现，取值为上面六个之一 —— 客户端按它决定表现
   * （`cooldown` 可转圈，其余当作这一发没打出去）。闸拒绝时两者同值，不新增帧类型。
   */
  rejected?: "dead" | "cross_map" | "range" | "cooldown" | "mp" | "rate";
  /** 冷却闸专用：还要等多少毫秒（`rejected: "cooldown"` 时给） */
  remainMs?: number;
  /** 耗蓝闸专用：这一发需要多少法力（`rejected: "mp"` 时给，客户端可飘「蓝不足 40/12」） */
  need?: number;
  /** 耗蓝闸专用：当前法力（与 `need` 一起给） */
  have?: number;
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

/**
 * 客户端 → 服务端：换图**意图**（#606）
 *
 * 与 `worldJoin` 的分工：这条只问「能不能去」，**不动世界状态**（不播种、不登记观看者、
 * 不改位置）。客户端拿到 `mapEnterResult.ok` 才切场景，切完照旧发 `worldJoin` 落地。
 *
 * 为什么要多一条消息而不是直接看 `worldJoin` 的应答：切图会先卸掉旧场景再加载新图，
 * 等 world 帧回来时人已经在「新图的空场景」里了 —— 被拒的话就是一屏没怪的空图。
 * 先问一句，被拒就原地提示，什么都不用回滚。
 */
export interface RealtimeMapEnterMessage {
  type: "mapEnter";
  data: {
    /** 目标地图 id */
    mapId: string;
  };
}

/**
 * 服务端 → 客户端：换图判定结果（#606）
 *
 * `ok = false` 时带 `field` / `need` / `mapLabel` 三件套，客户端按 `field` 取自己的文案
 * （`reject_map_level` / `reject_map_combat` / `reject_map_soul`）拼提示 ——
 * 服务端不生产面向玩家的句子。
 *
 * 同一帧也用于**拒绝一次 worldJoin**（改包绕过 mapEnter 直发的情况）：客户端收到
 * `ok = false` 且地图对得上时，说明自己不该在那张图里，提示 + 退回原图即可。
 */
export interface RealtimeMapEnterResultMessage {
  type: "mapEnterResult";
  data: {
    mapId: string;
    ok: boolean;
    /** 缺哪一项（`ok = true` 时没有） */
    field?: "level" | "combat" | "soul";
    /** 这张图要求的值（`ok = true` 时没有） */
    need?: number;
    /** 图名（提示里要用；`ok = true` 时没有） */
    mapLabel?: string;
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
  /**
   * 坐标（世界坐标）。世界层给的是**出生点**，通道发出去之前按怪物 AI 的实时位置覆盖
   * （#670，见 RealtimeService.withLiveMonsterPositions）—— 客户端拿到的就是「它现在在哪」
   */
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

/** 怪物 AI 广播帧里的一只怪（只发有变化的：位置变了、移动标记变了或血量变了） */
export interface RealtimeMonsterAiEntry {
  instanceId: string;
  /** 服务端模拟出的当前坐标（世界坐标；与 world 帧的出生点同一坐标系） */
  x: number;
  y: number;
  /** 是否在移动（客户端据此播走路 / 待机；方向由客户端按位移差量自算） */
  moving: boolean;
  /**
   * 当前血量与上限（#670）
   *
   * 血量权威是世界层的（玩家打怪走 settle 帧，只发给出手的那个人），同图**其他人**原本
   * 收不到这只怪掉的血 —— 别人打怪时他看到的血条不动。这里把「这只怪现在多少血」跟着
   * 位置一起广播出去：观看者据此刷血条，与谁在打无关。改了血量会让这只怪在本拍必发
   * （见 MonsterAiService.broadcast），所以站着被打的怪也会立刻出现。
   */
  hp: number;
  maxHp: number;
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
  /**
   * 这一下被格挡了（#822：护体神盾 `blockChance` / `blockFactor` 在服务端掷骰）
   *
   * `damage` 已经是格挡后的值，这个标记只给表现用（飘字 / 音效走既有那些口子，
   * 本轮不做专门的格挡演出 —— 见 docs/37 B5 的验收）。
   */
  blocked?: boolean;
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

/** 服务端 → 客户端：怪物 AI 广播（位置/血量增量 + 普攻/技能命中事件 + 技能释放 + 玩家击杀，按地图分发给观看者） */
export interface RealtimeMonsterAiMessage {
  type: "monster-ai";
  data: {
    mapId: string;
    monsters: RealtimeMonsterAiEntry[];
    hits: RealtimeMonsterHit[];
    /** #372：这一拍释放的技能（含状态型；没有技能释放时是空数组，不是 undefined） */
    casts: RealtimeMonsterCast[];
    /** #689：这一拍发生的玩家击杀（死亡清场 + 掉落铺场的跨端演出；没有击杀时是空数组） */
    kills: RealtimeMonsterKill[];
  };
}

/**
 * 怪物 AI 广播帧里的一次玩家击杀（#689）
 *
 * `settle` 帧的 `reward.drops` 只发击杀者本人（归属与账本都在他名下），同图其他观看者
 * 对「这只怪死了、地上掉了什么」一无所知 —— 这条事件把**演出所需的最小集合**广播给全图：
 * 死的是哪只（观看者据此清场）、谁打的（击杀者自己跳过 —— 那份已由 settle 演过）、
 * 死在哪、掉了什么（铺到地面，纯演出不可拾取 —— 账本定位 pick 帧只认击杀者的 castId）。
 */
export interface RealtimeMonsterKill {
  instanceId: string;
  /** 击杀者账号（客户端据此跳过自己的击杀，避免与 settle 路径重复演出） */
  accountId: string;
  /** 死亡点（世界坐标；AI 运行时被清前取的模拟坐标，取不到退回出生点） */
  x: number;
  y: number;
  /** 掉落结果（同一物品已合并数量；可为空数组 —— 这次什么都没掉，但死亡清场仍要走） */
  drops: RealtimeDropEntry[];
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
  /**
   * 所属队伍 id（#399；空串 = 没队伍）
   *
   * 客户端拿它跟自己的 `partyId` 比对，算出「这个人是队友」——队友的名字是金色的，
   * 与敌人 / 同帮 / 好友同一套关系判定（优先级里队伍高于帮会、低于敌人）。
   * 队伍 id 是**随机串**，不泄露任何「这队有几个人 / 队长是谁」的信息。
   */
  partyId: string;
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
    /** #693：这一拍发生的玩家动作（攻击/技能动画的跨端演出；没有动作时是空数组） */
    actions: RealtimePlayerAction[];
  };
}

/**
 * 玩家互见广播帧里的一条动作事件（#693）
 *
 * `settle` 只回给出手者本人（#34 的权威设计），同图观看者对「他出了一次手」一无所知 ——
 * 这条事件把**演出所需的最小集合**广播给全图：谁（accountId）、用的什么技能（skillId，
 * 普攻也是技能，如 "1000"）、打向哪只怪（targetId，客户端据此定朝向与特效落点；
 * 取不到目标时特效退回释放者身上）。出手者自己也会收到同一帧 —— 客户端按 accountId
 * 跳过（自己的动作在 settle 路径上已经演过，这里再来一次会重复）。
 */
export interface RealtimePlayerAction {
  accountId: string;
  skillId: string;
  targetId?: string;
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
  /** 绑定角色（#789）：客户端照搬进本地背包，详情弹窗据此显示「已绑定」 */
  bound?: boolean;
  /** 掉落溯源（#789，只有装备会有）：谁杀的 / 哪个怪 / 什么时候 */
  from?: { role?: string; monster?: string; at?: number };
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

//#region 聊天（#395：世界 / 帮会 / 私聊，权威在服务端的转发与限流）

/** 聊天频道（协议里的取值就这三个；客户端 configs/chat 的频道口径与这里同形） */
export const CHAT_CHANNELS = ["world", "guild", "private"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/**
 * 客户端 → 服务端：发一条聊天消息
 *
 * 三种频道共用一条消息：
 * - `world`：广播给**同图观看者**（复用互见的观看者集合，见 #395 issue 里的口径决定）；
 * - `guild`：转发给帮会全部**在线**成员（帮会成员身份以库为准，不信任客户端自称）；
 * - `private`：定向发给 `toRoleId` 对应账号（**仅在线可达**，不落库——离线转 mail 是后续刀）。
 *
 * 限频 / 长度上限 / 敏感词过滤都在服务端做（见 ChatService），客户端的校验只是省一次往返。
 */
export interface RealtimeChatMessage {
  type: "chat";
  data: {
    channel: ChatChannel;
    /** 消息正文（服务端 trim 后判空与上限） */
    text: string;
    /** 私聊收件人的角色 id（仅 private 频道需要；其余频道忽略） */
    toRoleId?: string;
  };
}

/** 广播帧里的一条聊天消息 */
export interface RealtimeChatEntry {
  channel: ChatChannel;
  text: string;
  /** 服务端转发时刻（毫秒）；客户端只做展示排序，不做时钟校准 */
  ts: number;
  /** 发送者（客户端拿 roleId 与社交快照比对可给名字上色，与互见帧同一套关系判定） */
  from: {
    accountId: string;
    /** 角色 id（未进图/无角色时聊天本来就发不出去，这里恒非空） */
    roleId: string;
    /** 显示名（角色名） */
    username: string;
    /** 帮会名（空串 = 无帮会；世界频道顺手带上有用，客户端不必再查） */
    guildName: string;
  };
  /** 私聊才有：收件人（发送者与收件人收到的是同一条帧） */
  to?: {
    accountId: string;
    roleId: string;
    username: string;
  };
}

/** 服务端 → 客户端：一条聊天消息（世界 / 帮会 / 私聊同形；发送者自己也会收到回显） */
export interface RealtimeChatBroadcast {
  type: "chat";
  data: RealtimeChatEntry;
}

//#endregion

//#region 任务（#396）

/**
 * 服务端 → 客户端：任务进度变化（**只推给本人连接**）
 *
 * 击杀结算推进度后立刻推（这是唯一发生在 HTTP 之外的进度变化 —— 对话 / 接取 / 交付
 * 都走 HTTP，响应自带最新快照，不需要帧）。客户端拿它刷新追踪栏与 NPC 标记；
 * 接取 / 交付后的全量对账走 `GET /quests/me`。
 */
export interface RealtimeQuestMessage {
  type: "quest";
  data: {
    questId: string;
    /** accepted 进行中 / ready 可交付 */
    status: string;
    progress: number;
    /** 目标数量（客户端免查快照比对） */
    target: number;
  };
}

//#endregion

//#region 队伍（#399：队伍态落库，交互走帧）

/**
 * 客户端 → 服务端：一次队伍操作
 *
 * 为什么队伍不做 HTTP 接口：**邀请必须即时送达**，而 HTTP 走存档进程、WS 在实时进程，
 * 存档进程推不到别人的通道；队伍快照本来也要跟互见帧一起变（队标、队友名字配色）。
 *
 * `action` 的合法值见 `common/constants/social.ts` 的 `PARTY_ACTION`；`roleId` 只有
 * invite / kick / transfer 需要（**邀请靠 roleId 不靠名字**：名字不唯一，而同屏可见的人
 * 在附近列表里本来就有 roleId —— 少一条「同名怎么办」的分支）。
 */
export interface RealtimePartyMessage {
  type: "party";
  data: {
    action: string;
    /** invite / kick / transfer 的目标角色 id */
    roleId?: string;
  };
}

/** 队伍快照里的一名成员（快照只在变化时发，所以字段可以给全） */
export interface RealtimePartyMember {
  roleId: string;
  /** 显示名（角色名；角色被删则为 id 的兜底见 settle 侧） */
  name: string;
  level: number;
  /** 是否在线（有连接 = 在线；离线队友仍在队里，只是收不到帧） */
  online: boolean;
  /** 是否与我同图（不同图的队友拿不到击杀经验，面板上要能看出来） */
  sameMap: boolean;
  /** 是否队长 */
  leader: boolean;
}

/**
 * 服务端 → 客户端：我的队伍现状（**只在变化时发**）
 *
 * `partyId` 为空串 = 我不在任何队伍（离队 / 被踢 / 解散都会收到这一份空快照）——
 * 客户端据此关面板、清掉队友标记，不需要第二条「你被踢了」的帧。
 */
export interface RealtimePartySnapshot {
  partyId: string;
  /** 队长角色 id（空串 = 没有队伍） */
  leaderRoleId: string;
  /** 队伍上限（客户端显示「3 / 4」；上限在服务端配置里） */
  limit: number;
  members: RealtimePartyMember[];
  /** 我是不是队长（客户端据此显示踢人 / 转让 / 解散） */
  isLeader: boolean;
}

export interface RealtimePartySnapshotMessage {
  type: "party";
  data: RealtimePartySnapshot;
}

/**
 * 服务端 → 客户端：有人邀请我组队
 *
 * 只发给**被邀请人**。邀请本身存内存（30 秒过期），所以这条帧丢了不会留下悬空状态 ——
 * 客户端不弹窗，邀请人看到「邀请已发出」但没人进队，再拉一次即可。
 */
export interface RealtimePartyInviteMessage {
  type: "partyInvite";
  data: {
    partyId: string;
    fromRoleId: string;
    fromName: string;
    fromLevel: number;
    /** 邀请时队伍已有几人 / 上限（被邀请人据此判断还有没有位置） */
    memberCount: number;
    limit: number;
    /** 过期时刻（毫秒，服务端时钟） */
    expiresAt: number;
  };
}

/**
 * 服务端 → 客户端：**队友**击杀怪物后我分到的经验
 *
 * 为什么需要这条帧：`settle` 只回给击杀者（掉落与经验归属都只认他），可队友那一份是
 * 服务端直接入账的 —— 不推这一条，队友的经验条不涨、`revision` 也停在上一次存档的基线，
 * 下一次防抖存档就会撞乐观锁（20006）。
 */
export interface RealtimeExpGainMessage {
  type: "expGain";
  data: {
    /** 本次入账的经验（服务端已落库；0 表示等级差过大没有经验，此时不会发这条帧） */
    exp: number;
    level: number;
    expNow: number;
    expNeed: number;
    leveledUp: boolean;
    /** 入账后的角色修订号（客户端照搬做新基线） */
    revision: number;
    /** 谁打死的（客户端飘一句「队友击杀 +经验」用） */
    from: { roleId: string; username: string };
  };
}

/**
 * 服务端 → 客户端：**本账号角色的权威快照**（战斗属性 / 战斗力 / 货币 / 等级）
 *
 * #541 起角色「有多强、有多少钱」由服务端说了算：客户端不再自己算（`combatCalc` 已退位），
 * 这里把服务端重算的结果推过去，客户端照搬刷新血条 / 属性面板 / 货币栏。
 *
 * 为什么是「轮询 + 变更才推」而不是每个写点各推一次：改角色的写点分散在**两个进程**
 * （存档进程的任务 / 邮件 / 商城 / 后台，实时进程的升级 / 拾取），进程内事件总线跨不过
 * 进程边界 —— 与「踢下线感知」同一难题，同一答案：实时进程轮询在线角色的行，
 * `revision / updated_at` 变了才组帧推一次。建连时也推一次，给客户端一个权威基线。
 */
export interface RealtimeRoleUpdateMessage {
  type: "roleUpdate";
  data: {
    level: number;
    /** 当前经验与升到下一级所需（经验条用） */
    exp: number;
    expNeed: number;
    /** 当前血量与蓝量（服务端落库值；升级补血 / 用药后的权威值从这里来） */
    hp: number;
    mp: number;
    /** 金币 / 绑定金币 / 银币（任务 / 邮件 / 后台改完这里都能看到） */
    gold: number;
    bindGold: number;
    silver: number;
    /** 战斗力（服务端按权重表现算） */
    combat: number;
    /**
     * 成长线阶位（#551）：称号 / 战魂 / 军衔
     *
     * 运营在后台改了某人的阶位，以前要等到「重新选角 / 重连」才看得见（#548 之前更糟：
     * 会被玩家下一次存档**直接覆盖掉**）。三件套都归服务端（`role-authority.ts` 的清单里），
     * 帧不带它们就等于「改了但看不出来改了」。
     *
     * 可选：老服务端 / 老客户端互认时不至于把字段读成 undefined 而崩。
     */
    title?: number;
    soulOfWar?: number;
    rank?: number;
    /**
     * 体验状态（#596 换设备云同步）：快捷键 / 引导进度 / 战魂外显勾选
     *
     * 这些字段归**客户端书写**（玩家自己的偏好与进度，服务端不产生它们），但存档以服务端
     * 为准 —— 帧把它们带回来，另一台设备 / 后台改动不用重新选角就能看到。可选（老端互认）。
     */
    shortcutKeys?: Array<{ label: string; key: number; skillId: string | null }>;
    guide?: { step: number; done: boolean; skipped: boolean };
    soulShow?: boolean;
    /** 时装（#596）：穿着态与拥有清单 —— 购买 / 后台发放后不重进也看得见 */
    fashionCloth?: string | null;
    fashionsOwned?: string[];
    /** 八项战斗属性（区间属性 = [下限, 上限]）；等级不在成长曲线里时省略 */
    maxHp?: number;
    hpRecover?: number;
    maxMp?: number;
    physicalAttack?: [number, number];
    magicAttack?: [number, number];
    taoistAttack?: [number, number];
    physicalDefense?: [number, number];
    magicDefense?: [number, number];
    taoistDefense?: [number, number];
    /** 角色修订号（客户端照搬做存档基线，防下一次推档撞乐观锁） */
    revision: number;
  };
}

//#endregion

/** 服务端会发出的全部消息 */
export type RealtimeServerMessage =
  | RealtimeWelcomeMessage
  | RealtimePongMessage
  | RealtimeErrorMessage
  | RealtimeSettleMessage
  | RealtimeWorldMessage
  | RealtimeMapEnterResultMessage
  | RealtimeMonsterAiMessage
  | RealtimePlayersMessage
  | RealtimePickedMessage
  | RealtimeChatBroadcast
  | RealtimeQuestMessage
  | RealtimePartySnapshotMessage
  | RealtimePartyInviteMessage
  | RealtimeExpGainMessage
  | RealtimeRoleUpdateMessage;

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
