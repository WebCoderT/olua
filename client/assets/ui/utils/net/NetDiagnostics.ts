import { Color, Label, Node, UITransform, Vec2 } from "cc";
import { networkConfig } from "../../../configs/network";
import { designResolution } from "../layout/ScreenLayout";

/**
 * 网络诊断层（#767：同步延迟测量基线 —— 先有数字，再决定砍哪一段）
 *
 * 量四个客户端侧数字，服务端每轮广播的收件数 / 字节数 / stringify 耗时在
 * realtime.service 的「广播统计」日志里（`REALTIME_STATS_INTERVAL_MS`）：
 *
 * - **RTT**：应用层 `ping` → `pong` 的本地往返（RealtimeClient 接线，见 pingSentAt）；
 * - **players 帧龄**：距最近一次收到互见帧过了多久（长时间不动 = 广播停了）；
 * - **monsterAi 帧龄**：距最近一次收到怪物帧过了多久；
 * - **插值剩余**：OtherPlayerManager 里离广播目标最远的那个人还有多少像素没追上
 *   （正常 < 半个广播周期的位移；一直很大 = 插值系数与节拍不匹配）。
 *
 * ## 边界（issue 的硬边界）
 *
 * - **默认关**（`networkConfig.diagnostics.enabled`，configs 常量，不走服务端快照）：
 *   关 = 不建节点、不起定时器、所有 `note*` 是空操作 —— 零开销；
 * - 开着也**不改任何同步行为**：只读「帧到没到、追没追上」，不碰上报节拍与插值系数；
 * - 诊断文本是排查工具，**不进正式 HUD** —— 发布前必须确认开关是 false
 *   （client 单测有断言守着默认值）。
 */
export default class NetDiagnostics {
  /** 总开关（configs/network.diagnostics.enabled；只读一次，运行期不改） */
  static readonly enabled: boolean = networkConfig.diagnostics.enabled === true;

  /** RTT 采样窗口：取最近 10 次的平均（单次抖动没有意义） */
  private static readonly RTT_SAMPLES = 10;
  private static readonly rttSamples: number[] = [];
  /** 最近一帧到达的本地时刻（0 = 还没收到过；帧龄按 Date.now() - 它算） */
  private static playersFrameAt = 0;
  private static monsterAiFrameAt = 0;
  /** 互见插值的最大剩余距离（px；OtherPlayerManager.tick 每帧报一次全场最大值） */
  private static interpolationPx = 0;

  /** 诊断文本节点（mount 建一次；enabled=false 时恒 null，不占任何内存） */
  private static hudNode: Node | null = null;
  private static hudLabel: Label | null = null;
  /** 文本刷新节流（每 0.5s 重写一次，不必每帧） */
  private static hudTimer = 0;

  /** 记一次 RTT 采样（RealtimeClient 在收到 pong 时调；关着时是空操作） */
  static noteRtt(ms: number): void {
    if (!this.enabled) return;
    this.rttSamples.push(ms);
    if (this.rttSamples.length > this.RTT_SAMPLES) this.rttSamples.shift();
  }

  /** 记一次帧到达（kind = 帧类型；CombatChannel 的分发口调） */
  static noteFrame(kind: "players" | "monster-ai"): void {
    if (!this.enabled) return;
    if (kind === "players") this.playersFrameAt = Date.now();
    else this.monsterAiFrameAt = Date.now();
  }

  /** 记一次插值剩余距离（px；OtherPlayerManager.tick 每帧报全场最大值） */
  static noteInterpolation(px: number): void {
    if (!this.enabled) return;
    this.interpolationPx = px;
  }

  /** 一行诊断文本（诊断关着时返回空串） */
  static summary(): string {
    if (!this.enabled) return "";
    const now = Date.now();
    const rtt = this.rttSamples.length
      ? `${Math.round(this.rttSamples.reduce((sum, item) => sum + item, 0) / this.rttSamples.length)}ms`
      : "—";
    const age = (at: number) => (at === 0 ? "—" : `${now - at}ms`);
    return `RTT ${rtt} | players 帧龄 ${age(this.playersFrameAt)} | monsterAi 帧龄 ${age(this.monsterAiFrameAt)} | 插值剩余 ${Math.round(this.interpolationPx)}px`;
  }

  /**
   * 挂诊断文本（Game.start 调一次；关着时**什么都不建** —— 这就是「默认零开销」的守门）
   *
   * 位置：屏幕左上角，只读小字，不挡操作（不拦点击 —— 诊断不该改变交互）。
   */
  static mount(parent: Node): void {
    if (!this.enabled || this.hudNode) return;
    const node = new Node("net_diagnostics");
    const screen = designResolution;
    const at = this.hudPosition(screen.width, screen.height);
    node.setPosition(at.x, at.y, 0);
    node.addComponent(UITransform);
    const label = node.addComponent(Label);
    label.fontSize = 18;
    label.lineHeight = 22;
    label.color = new Color(120, 200, 255, 230);
    label.string = this.summary();
    parent.addChild(node);
    this.hudNode = node;
    this.hudLabel = label;
  }

  /** 每帧驱动（Game.update 调；内部按 0.5s 节流重写文本；关着时第一行就返回） */
  static tick(deltaTime: number): void {
    if (!this.enabled || !this.hudLabel) return;
    this.hudTimer += deltaTime;
    if (this.hudTimer < 0.5) return;
    this.hudTimer = 0;
    this.hudLabel.string = this.summary();
  }

  /** 场景销毁时摘掉节点引用（Game.onDestroy 调；节点本身随场景走） */
  static unmount(): void {
    this.hudNode = null;
    this.hudLabel = null;
    this.hudTimer = 0;
  }

  /** 左上角坐标（UI 层以屏幕中心为原点） */
  private static hudPosition(width: number, height: number): Vec2 {
    return new Vec2(-width / 2 + 12, height / 2 - 16);
  }
}
