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
 * ## 已知边界（世界权威 #35 会收编）
 * - 目标实例 id 由客户端生成（`MonsterManager` 发牌），服务端只认「这个 id 被我扣到多少血」；
 * - 断线重连后服务端的目标登记簿被清空，下一次出手按满血重新登记 —— 客户端展示的
 *   已扣血量与服务端记的会出现暂时不一致，世界权威落地后随「世界状态恢复」一起解决；
 * - 结算迟到（目标已换图消失）由 MonsterManager 忽略，表现为这次出手打空。
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

export default class CombatChannel {
  /** 出手序号（会话内单调递增，服务端按它做幂等；断线重连服务端会清账，这里不回绕） */
  private static castSeq = 0;

  /** 结算结果出口（组合根接线到 MonsterManager.applyServerSettle；不接时结果被丢弃并告警） */
  static onSettle: ((data: CombatSettleOk) => void) | null = null;

  /** 是否走服务端结算（灰度开关 × 通道在线；false 时调用方退回本地结算） */
  static get active(): boolean {
    return RealtimeClient.status === RealtimeStatus.Connected;
  }

  /**
   * 发起一次出手（调用前先判 `active`）
   * @param skillId 技能 id（真实 id —— 多个技能共用实现时不能拿实现函数猜）
   * @param targetId 目标实例 id（MonsterManager 发的牌）
   * @param monsterKey 目标怪物 key（服务端据此查它的战斗数值表）
   */
  static sendCast(skillId: string, targetId: string, monsterKey: string): void {
    this.castSeq += 1;
    RealtimeClient.send({ type: "cast", data: { castId: this.castSeq, skillId, targetId, monsterKey } });
  }

  /** 换图：让服务端把本账号记着的目标全部作废（怪物管理器清场时调用） */
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
}

/** 服务端拒绝一次结算的形状（协议见 realtime.protocol 的 RealtimeSettleError） */
export interface CombatSettleError {
  castId: number;
  ok: false;
  code: string;
  message: string;
}
