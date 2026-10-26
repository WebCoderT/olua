import RealtimeClient from "./RealtimeClient";
import { RealtimeStatus } from "./RealtimeClient";

/**
 * 战斗指令通道（#34：伤害结算上移服务端，客户端改为发指令 / 收结果）
 *
 * ## 分工
 * - 这里只做「打包出手 → 发出去 → 把结果交给登记的处理者」：算伤害是**服务端**的事
 *   （按它自己的属性表与怪物数值表，见 server `CombatSettlementService`）；
 * - 调用方（技能实现）在出手时问一句 `active`：实时通道在线就走服务端，**不在线就退回
 *   本地结算**（这就是「关掉开关回到纯客户端」的回滚语义 —— 通道不可用等价于开关关闭）；
 * - 结算结果由 RealtimeClient 分发进来（`onSettle`），最终由 MonsterManager 落到目标身上
 *   （扣血 / 飘字 / 死亡），接线在组合根（ui/Game）。
 *
 * ## 双跑对账（可观测）
 * 两端公式都带随机数，逐次比较必然对不上 —— 能比的是**合法带**：服务端伤害必须落在
 * 客户端口径允许的区间内（`skillDamageBand`）。越界说明两端的表或公式漂了，
 * 以固定标签 `combat-parity` 记到 console —— 这就是「不一致时的记录位置」，
 * 在删掉客户端那套旧算法之前，靠它发现问题。
 *
 * ## 世界权威（#35）
 * 进图由这里发 `worldJoin`（地图 id + 刷怪计划），服务端持有怪物实例并以 `world` 帧
 * 下发权威快照（实例 id 服务端发牌）；`cast` 的 targetId 用的就是服务端的实例 id。
 * 最近一次 worldJoin 会被缓存 —— 断线重连成功后自动重发（服务端不记得重连的观看者，
 * 不重发就会错过重生广播与世界状态）。`world` 帧由 RealtimeClient 分发进来（`onWorld`），
 * 最终由 MonsterManager 与场上节点做差量合并。
 */

/**
 * 一次击杀的奖励（#316：经验与掉落的结算在服务端，形状见 realtime.protocol 的 RealtimeKillReward）
 * 经验入账在服务端已完成 —— level / expNow / revision 就是入账后的角色状态，客户端照着演。
 */
export interface CombatKillReward {
  exp: number;
  level: number;
  expNow: number;
  expNeed: number;
  leveledUp: boolean;
  revision: number;
  drops: Array<{ goodId: string; count: number }>;
}

/** 服务端结算结果里客户端关心的形状（协议见 realtime.protocol 的 RealtimeSettleOk） */
export interface CombatSettleOk {
  castId: number;
  ok: true;
  skillId: string;
  targetId: string;
  damage: number;
  hp: number;
  maxHp: number;
  killed: boolean;
  /** 击杀奖励（仅 killed 时携带；无此字段 = 旧服务端或本地口径回滚路径） */
  reward?: CombatKillReward;
  duplicate: boolean;
}

/** 服务端世界快照里的一只怪（协议见 realtime.protocol 的 RealtimeWorldMonster） */
export interface WorldMonsterSnapshot {
  /** 实例 id（**服务端发牌**，全服唯一、跨重启稳定；cast 的 targetId 用它） */
  instanceId: string;
  monsterKey: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 出生点（世界坐标；客户端在此落怪，游走是本地表现） */
  x: number;
  y: number;
  /** 距重生还剩多少毫秒（死亡中的怪才有） */
  respawnInMs?: number;
}

/** 服务端世界快照（协议见 realtime.protocol 的 RealtimeWorldMessage.data） */
export interface WorldSnapshot {
  mapId: string;
  monsters: WorldMonsterSnapshot[];
}

/** 怪物 AI 广播帧里的一只怪（#323：只发有变化的；位置 = 服务端模拟出的当前坐标） */
export interface MonsterAiEntry {
  instanceId: string;
  x: number;
  y: number;
  /** 是否在移动（客户端据此播走路 / 待机；方向由位移差量自算） */
  moving: boolean;
}

/** 怪物 AI 广播帧里的一次普攻命中（玩家受击的权威结果，服务端已落账） */
export interface MonsterHitEntry {
  instanceId: string;
  /** 受击账号（广播给全图观看者；#324 玩家互见之前客户端只演自己的） */
  accountId: string;
  damage: number;
  hp: number;
  maxHp: number;
}

/** 服务端怪物 AI 广播帧（协议见 realtime.protocol 的 RealtimeMonsterAiMessage.data） */
export interface MonsterAiFrame {
  mapId: string;
  monsters: MonsterAiEntry[];
  hits: MonsterHitEntry[];
  /** #372：这一拍怪物释放的技能（含状态型；旧服务端不带该字段时按空数组处理） */
  casts?: MonsterCastEntry[];
}

/** 怪物释放技能的演出指令（#372：协议见 realtime.protocol 的 RealtimeMonsterCast） */
export interface MonsterCastEntry {
  instanceId: string;
  skillId: string;
  /** 有值 = 这次释放给怪物自己挂了这个状态（客户端据此在怪物身上播状态特效） */
  statusId?: string;
}

/** 玩家互见广播帧里的一名玩家（#324：协议见 realtime.protocol 的 RealtimePlayerEntry） */
export interface PlayerEntry {
  accountId: string;
  /** 显示名（角色名优先，缺省回落账号名） */
  username: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moving: boolean;
}

/** 服务端玩家互见广播帧（协议见 realtime.protocol 的 RealtimePlayersMessage.data） */
export interface PlayersFrame {
  mapId: string;
  /** true = 全量快照（刚进图时拿到，客户端据此重建整个集合） */
  full: boolean;
  players: PlayerEntry[];
  /** 已离开的账号（增量帧用；full 帧里恒为空数组） */
  left: string[];
}

/** 拾取入包后实际写入的背包格子（#325：叠加进已有堆 = 那一格更新后的形状；装备 = 新占的格子） */
export interface PickPlacedCell {
  row: number;
  col: number;
  id: string;
  count: number;
}

/** 服务端拾取成功（协议见 realtime.protocol 的 RealtimePickedOk） */
export interface PickOk {
  castId: number;
  index: number;
  ok: true;
  /** 拾取后的角色修订号（入包推进了 revision，客户端照搬做新基线防乐观锁） */
  revision: number;
  placed: PickPlacedCell[];
  /** true = 该掉落此前已拾取过（幂等重放，placed 为空） */
  alreadyPicked: boolean;
}

/** 服务端拾取被拒（地面掉落物保留；bag_full 时客户端提示背包已满） */
export interface PickError {
  castId: number;
  index: number;
  ok: false;
  code: string;
  message: string;
}

/** 服务端拾取结果（协议见 realtime.protocol 的 RealtimePickedData） */
export type PickResult = PickOk | PickError;

export default class CombatChannel {
  /** 出手序号（会话内单调递增，服务端按它做幂等；断线重连服务端会清账，这里不回绕） */
  private static castSeq = 0;

  /** 最近一次进图登记（断线重连成功后自动重发；null = 本会话还没进过图） */
  /** 最近一次进图的地图 id（断线重连重发用；#295 起播种在服务端，客户端只报图 id） */
  private static lastJoin: { mapId: string } | null = null;

  /** 结算结果出口（组合根接线到 MonsterManager.applyServerSettle；不接时结果被丢弃并告警） */
  static onSettle: ((data: CombatSettleOk) => void) | null = null;

  /** 世界快照出口（组合根接线到 MonsterManager.applyWorldState；不接时快照被丢弃并告警） */
  static onWorld: ((data: WorldSnapshot) => void) | null = null;

  /** 怪物 AI 广播出口（#323；组合根接线到 MonsterManager.applyServerAi，不接时帧被丢弃） */
  static onMonsterAi: ((data: MonsterAiFrame) => void) | null = null;

  /** 玩家互见广播出口（#324；组合根接线到 OtherPlayerManager.applyPlayersFrame，不接时帧被丢弃） */
  static onPlayers: ((data: PlayersFrame) => void) | null = null;

  /** 拾取结果出口（#325；组合根接线到 DropManager.applyPickedFrame，不接时结果被丢弃并告警） */
  static onPicked: ((data: PickResult) => void) | null = null;

  /** 位置上报的最小间隔（毫秒）：AI 的目标检测不需要逐帧精度，4Hz 足够 */
  private static POSITION_INTERVAL = 250;
  private static lastPositionSentAt = 0;

  /** 是否走服务端结算（灰度开关 × 通道在线；false 时调用方退回本地结算） */
  static get active(): boolean {
    return RealtimeClient.status === RealtimeStatus.Connected;
  }

  /**
   * 发起一次出手（调用前先判 `active`）
   * @param skillId 技能 id（真实 id —— 多个技能共用实现时不能拿实现函数猜）
   * @param targetId 目标实例 id（**服务端发的牌**，来自 world 快照）
   * @param monsterKey 目标怪物 key（服务端据此查它的战斗数值表）
   */
  static sendCast(skillId: string, targetId: string, monsterKey: string): void {
    this.castSeq += 1;
    RealtimeClient.send({ type: "cast", data: { castId: this.castSeq, skillId, targetId, monsterKey } });
  }

  /**
   * 进图登记（播种 / 恢复 / 换图都走这里）：只带地图 id —— 刷怪区配置已归服务端
   * （#295，从 Tiled 导入一次），空图播种、实例身份 / 血量 / 存活全部以服务端为准，
   * 权威快照以 `world` 帧回来（onWorld）。
   */
  static sendWorldJoin(mapId: string): void {
    this.lastJoin = { mapId };
    RealtimeClient.send({ type: "worldJoin", data: { mapId } });
  }

  /** 断线重连成功后重发最近一次进图登记（没有就不发；RealtimeClient 在 welcome 后调用） */
  static resendWorldJoin(): void {
    if (!this.lastJoin) return;
    RealtimeClient.send({ type: "worldJoin", data: { mapId: this.lastJoin.mapId } });
  }

  /**
   * 上报自身位置（#323 AI 目标检测输入 + #324 玩家互见数据源；内部按 4Hz 节流，调用方可以每帧调）
   * @param mapId 当前地图 id
   * @param x 玩家世界坐标
   * @param y 玩家世界坐标
   * @param hp 当前血量（服务端用它判断目标是否已死）
   * @param moving 上报时刻是否在移动（互见的走路/待机演出依据；移动是玩家自己的事，客户端自报）
   */
  static sendPosition(mapId: string, x: number, y: number, hp: number, moving = false): void {
    const now = Date.now();
    if (now - this.lastPositionSentAt < this.POSITION_INTERVAL) return;
    this.lastPositionSentAt = now;
    RealtimeClient.send({ type: "pos", data: { mapId, x, y, hp, moving } });
  }

  /** 换图重置位置上报节流（新图的第一帧位置要立刻送上去） */
  static resetPositionThrottle(): void {
    this.lastPositionSentAt = 0;
  }

  /** 换图前清掉旧图的幂等账（怪物管理器清场时调用；旧图的世界状态不受影响） */
  static resetTargets(): void {
    RealtimeClient.send({ type: "targetsReset" });
  }

  /**
   * 拾取一次击杀的掉落（#325）：castId + drops 下标定位，服务端格子级入包，
   * 结果以 picked 帧回来（onPicked）。发送失败（连接不在 OPEN 态）返回 false ——
   * 调用方据此保留地面掉落物，等通道恢复后再试。
   */
  static sendPick(castId: number, index: number): boolean {
    return RealtimeClient.send({ type: "pick", data: { castId, index } });
  }

  /** RealtimeClient 收到 settle 帧后走这里（ok 与拒绝都在内） */
  static dispatchSettle(data: unknown): void {
    const settle = data as CombatSettleOk | CombatSettleError | null;
    if (!settle || typeof settle !== "object") return;
    if (settle.ok === false) {
      // 被拒的出手等于没打出去：记下来（幂等重发 / 未学习技能这类不该悄悄消失）
      console.warn(`[combat] 出手被拒（castId=${settle.castId} code=${settle.code}）：${settle.message}`);
      return;
    }
    if (!this.onSettle) {
      console.warn("[combat] 收到结算但没有处理者（onSettle 未接线），结果被丢弃");
      return;
    }
    this.onSettle(settle);
  }

  /** RealtimeClient 收到 world 帧后走这里（进图应答与重生广播同形） */
  static dispatchWorld(data: unknown): void {
    const snapshot = data as WorldSnapshot | null;
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.monsters)) return;
    if (!this.onWorld) {
      console.warn("[world] 收到世界快照但没有处理者（onWorld 未接线），快照被丢弃");
      return;
    }
    this.onWorld(snapshot);
  }

  /** RealtimeClient 收到 monster-ai 帧后走这里（#323：位置增量 + 普攻命中事件） */
  static dispatchMonsterAi(data: unknown): void {
    const frame = data as MonsterAiFrame | null;
    if (!frame || typeof frame !== "object" || !Array.isArray(frame.monsters) || !Array.isArray(frame.hits)) return;
    if (!this.onMonsterAi) {
      console.warn("[monster-ai] 收到 AI 广播但没有处理者（onMonsterAi 未接线），帧被丢弃");
      return;
    }
    this.onMonsterAi(frame);
  }

  /** RealtimeClient 收到 players 帧后走这里（#324：互见增量 + 快照兜底 + 离开事件） */
  static dispatchPlayers(data: unknown): void {
    const frame = data as PlayersFrame | null;
    if (!frame || typeof frame !== "object" || !Array.isArray(frame.players) || !Array.isArray(frame.left)) return;
    if (!this.onPlayers) {
      // 没接线不告警：旧客户端构建（没接 OtherPlayerManager）收到 players 帧是正常现象
      return;
    }
    this.onPlayers(frame);
  }

  /** RealtimeClient 收到 picked 帧后走这里（#325：成功与拒绝都在内） */
  static dispatchPicked(data: unknown): void {
    const result = data as PickResult | null;
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") return;
    if (!this.onPicked) {
      console.warn("[drop] 收到拾取结果但没有处理者（onPicked 未接线），结果被丢弃");
      return;
    }
    this.onPicked(result);
  }
}

/** 服务端拒绝一次结算的形状（协议见 realtime.protocol 的 RealtimeSettleError） */
export interface CombatSettleError {
  castId: number;
  ok: false;
  code: string;
  message: string;
}
