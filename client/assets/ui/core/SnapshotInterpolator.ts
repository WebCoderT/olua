/**
 * 远端位置插值器（#769：快照缓冲 + 按服务端时间回放）
 *
 * ## 为什么不再「每帧朝目标走一半」
 *
 * 旧做法（`OtherPlayerManager.tick` 的 `factor`）是**指数逼近**：每帧走剩余距离的一半。
 * 两个毛病：
 * 1. **永远到不了**。数学上渐近，最后几像素只能靠「差量 > 1 才转向」收尾 —— 停下时会蠕动一小段；
 * 2. **延迟不可控**。走多快取决于帧率与丢帧：网络抖一下目标点跳很远，那一段就快进；连续丢两帧
 *    人物就站着不动。玩家感受到的是「忽快忽慢」，比稳定的滞后更难受。
 *
 * ## 现在：攒快照，按服务端时间线性回放
 *
 * 服务端给每帧打 `t`（`players` / `monster-ai` 帧级时间戳），客户端把每个远端实体的坐标
 * 压进一个**小环形缓冲**（默认 4 条），渲染时取
 *
 * ```
 * 渲染时刻 = 服务端时钟 - 渲染延迟（renderDelay，略大于广播间隔）
 * ```
 *
 * 在缓冲里找夹住这个时刻的两条快照，按 `t` 线性插值 —— 位置是**匀速**推进的，不再受帧率、
 * 丢帧影响；停下时正好落在那条「站着」的快照上，不会蠕动。
 *
 * ## 边界（刻意不做）
 *
 * - **不预测**：只沿最后一段的速度**外插最多 `maxExtrapolate` 毫秒**（丢帧时别让人物站住），
 *   推到头就停住、绝不瞬移到新位置；
 * - **不改上报节拍**、不改服务端模拟：本类只消费时间戳，是纯函数式的数据变换；
 * - **不依赖 cc**：只用数字（`t` / `x` / `y` / `moving`），于是能在 node 沙箱里跑真实单测
 *   （喂固定时间序列断言中间点位置）。
 */
export interface PositionSnapshot {
  /** 服务端时刻（毫秒；来自帧级 `t`，不是本地收帧时刻） */
  t: number;
  x: number;
  y: number;
  /** 这一帧的移动标记（快照之间做布尔插值没有意义，取「后一帧」的口径） */
  moving: boolean;
}

/** 采样结果（渲染位置 + 这一时刻该播的走 / 站） */
export interface SampledPosition {
  x: number;
  y: number;
  moving: boolean;
}

export default class SnapshotInterpolator {
  /** 快照缓冲（旧的在前；长度不超过 size） */
  private readonly buffer: PositionSnapshot[] = [];

  /**
   * @param size 保留几条快照（2 = 只够插一段，抖动就没余量；4 = 广播 10Hz 下约 400ms 记忆）
   * @param maxExtrapolate 缓冲「追不上」渲染时刻时，最多沿最后一段速度往前推多少毫秒
   */
  constructor(
    private readonly size = 4,
    private readonly maxExtrapolate = 100,
  ) {}

  /** 清了重来（换图 / 重新进视野：旧位置对新图毫无意义，接着插值会看到人物从上一张图滑进来） */
  reset(): void {
    this.buffer.length = 0;
  }

  /** 当前缓冲里最新的快照（诊断用：渲染位置与新快照的差距就是这个「滞后」） */
  get newest(): PositionSnapshot | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
  }

  /**
   * 压入一条快照
   *
   * - 同一个 `t` 覆盖（一拍里同一实体被写两次 / 重连补帧）：不覆盖会让缓冲里出现零长度的段，
   *   速度算出来是 Infinity；
   * - 比最后一条还旧的**丢弃**（乱序帧 / 系统时钟回拨）：缓冲必须按 t 单调，否则找区间的
   *   逻辑会跳段；
   * - 超出容量从最旧的丢：只有最近的几段对插值有用，留多了反而「记住」早已过期的位置。
   */
  push(t: number, x: number, y: number, moving: boolean): void {
    const last = this.newest;
    if (last && t < last.t) return;
    if (last && t === last.t) {
      last.x = x;
      last.y = y;
      last.moving = moving;
      return;
    }
    this.buffer.push({ t, x, y, moving });
    while (this.buffer.length > Math.max(2, this.size)) this.buffer.shift();
  }

  /**
   * 按渲染时刻取位置
   *
   * - 缓冲空 → `null`（调用方跳过：还没收到过任何位置，原地站着等第一帧）；
   * - 比第一条还早 → 第一条（刚进视野时渲染时刻必然落后，别把新来的人画在原点）；
   * - 夹在两帧之间 → 线性插值（本类的主路径）；
   * - 比最后一条还新 → 沿最后一段速度外插，最多 `maxExtrapolate` 毫秒。
   */
  sample(renderTime: number): SampledPosition | null {
    const buffer = this.buffer;
    if (buffer.length === 0) return null;
    const first = buffer[0];
    if (buffer.length === 1 || renderTime <= first.t) return { x: first.x, y: first.y, moving: first.moving };
    // 找「不晚于 renderTime 的最后一帧」（缓冲最多 4 条，线性扫比二分清楚）
    let index = -1;
    for (let i = 0; i < buffer.length - 1; i += 1) {
      if (buffer[i].t <= renderTime) index = i;
    }
    if (index >= 0 && renderTime <= buffer[index + 1].t) {
      const from = buffer[index];
      const to = buffer[index + 1];
      const span = to.t - from.t;
      const ratio = span > 0 ? (renderTime - from.t) / span : 1;
      return {
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
        moving: to.moving,
      };
    }
    // 渲染时刻已经在最后一帧之后（正常情况不会：渲染延迟 > 广播间隔；只有丢帧才会到这里）
    const from = buffer[buffer.length - 2];
    const to = buffer[buffer.length - 1];
    const span = to.t - from.t;
    if (span <= 0) return { x: to.x, y: to.y, moving: to.moving };
    const ahead = Math.min(this.maxExtrapolate, renderTime - to.t);
    const ratio = ahead / span;
    return { x: to.x + (to.x - from.x) * ratio, y: to.y + (to.y - from.y) * ratio, moving: to.moving };
  }
}
