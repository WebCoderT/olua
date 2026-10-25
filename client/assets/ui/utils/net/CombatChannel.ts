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

  /** 换图前清掉旧图的幂等账（怪物管理器清场时调用；旧图的世界状态不受影响） */
  static resetTargets(): void {
    RealtimeClient.send({ type: "targetsReset" });
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
}

/** 服务端拒绝一次结算的形状（协议见 realtime.protocol 的 RealtimeSettleError） */
export interface CombatSettleError {
  castId: number;
  ok: false;
  code: string;
  message: string;
}
