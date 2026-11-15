/**
 * 服务端时钟（#769：插值的时间基准）
 *
 * 插值要「按服务端时间回放快照」，客户端就得知道**此刻服务端是几点**。两端都是 unix 毫秒，
 * 但各自的系统时钟有偏差（家用机差几秒很正常，手机改过时间更离谱），不能直接拿 `Date.now()`
 * 去比帧里的 `t`。
 *
 * 偏差从两个已知口子校准（服务端本来就在发）：
 * - `welcome.serverTime`：连上就有一份，粗校准（没有 RTT 补偿，误差 ≤ 半个 RTT）；
 * - `pong.serverTime`：跟着心跳一直有，用 `发出时刻 + RTT/2` 补偿传输时延，细校准。
 *
 * ## 为什么不做平滑
 *
 * RTT 抖动是十几毫秒量级，而渲染延迟是 100ms 以上 —— 这点偏移对插值没有可见影响，
 * 反倒平滑会引入「时钟慢慢漂」的未知状态。所以每次校准**直接覆盖**，行为可预期、好排查。
 *
 * 未校准（`offset = 0`）时也能跑：两端都是 epoch 毫秒，偏差通常只有几秒，插值只是整体平移，
 * 不会崩（只是可能一直在「外插 / 夹到第一条」之间切换，校准后即恢复正常）。
 */
export default class ServerClock {
  /** 服务端时刻 - 本地时刻（毫秒） */
  private static offset = 0;

  /** 当前偏差（毫秒，诊断 / 单测用；未校准时是 0） */
  static get skew(): number {
    return this.offset;
  }

  /**
   * 校准一次
   *
   * @param serverTime 这一帧里服务端写的时刻（毫秒）
   * @param sentAtLocal 我方**发出请求**的本地时刻（心跳 ping 才有；welcome 时传 null）
   * @param receivedAtLocal 收到应答的本地时刻（缺省取当前）
   */
  static sync(serverTime: number, sentAtLocal: number | null = null, receivedAtLocal: number = Date.now()): void {
    if (!Number.isFinite(serverTime) || !Number.isFinite(receivedAtLocal)) return;
    // 应答里的服务端时刻是「服务端处理请求的那一刻」，它发生在我方发出后半程：加上 RTT/2 才是此刻
    const halfTrip = sentAtLocal !== null && Number.isFinite(sentAtLocal) ? Math.max(0, (receivedAtLocal - sentAtLocal) / 2) : 0;
    this.offset = serverTime + halfTrip - receivedAtLocal;
  }

  /** 服务端「此刻」（毫秒）；`localNow` 只为单测注入，业务代码不要传 */
  static now(localNow: number = Date.now()): number {
    return localNow + this.offset;
  }

  /**
   * 插值用的渲染时刻 = 服务端此刻 - 渲染延迟
   *
   * 往回拨一个渲染延迟，渲染时刻才**夹在两条已知快照之间**（而不是永远落在最新快照之后
   * 只能外插）。`delay` 取略大于广播间隔的值，见 `networkConfig.realtime.interpolation`。
   */
  static renderTime(delay: number, localNow: number = Date.now()): number {
    return this.now(localNow) - delay;
  }

  /** 归零（换账号 / 重连到另一台服务器时用；正常游玩不需要） */
  static reset(): void {
    this.offset = 0;
  }
}
