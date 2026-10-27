import { Graphics, Label, Node, Size, UITransform, Vec2 } from "cc";
import { chatDialogLayout as layout } from "../../configs/hudLayout";
import type { ChatEntry } from "../utils/net/CombatChannel";
import LayerManager from "./LayerManager";
import UiHelper from "../helpers/UiHelper";

/**
 * 聊天气泡（#395：弹窗关着时，新消息在屏幕左上角冒一下）
 *
 * ## 存在的理由
 * 聊天面板不可能一直开着（盖住半屏），但「世界有人说话」得让玩家知道——
 * 气泡就是那个「知道」：最近一条消息的文字在左上角停几秒，自己消失。
 * 玩家想细看再点聊天按钮开面板。
 *
 * ## 生命周期
 * 静态类管理一列气泡节点（最多 `maxCount` 条，新的挤掉最旧的），
 * 每条一个 `setTimeout` 自毁——**不依赖弹窗存在**，所以订阅的是 `ChatStore.onChange`
 * 而不是弹窗的任何回调。弹窗打开时挂起（suppress）:面板里正在看全文，
 * 同一条消息再冒一个气泡是纯干扰。
 *
 * 与其他管理器（OtherPlayerManager 等）同款纪律：`reset()` 由组合根在切场景时调用。
 */
export default class ChatBubbles {
  /** 当前的气泡节点（新的在数组头，旧的往后挪；超 maxCount 的直接销毁） */
  private static nodes: Node[] = [];
  /** 节点 → 自毁计时器（成对销毁，不留孤儿计时器） */
  private static timers = new Map<Node, ReturnType<typeof setTimeout>>();
  /** 弹窗打开期间挂起（打开时置 true；消息只上屏、不冒泡） */
  private static suppressed = false;

  /** 弹窗开合时由 ChatDialog 调用（打开 = 挂起，关闭 = 恢复） */
  static setSuppressed(value: boolean): void {
    this.suppressed = value;
  }

  /** 接收一条消息（Game 组合根把 ChatStore.onChange 接进来） */
  static show(entry: ChatEntry): void {
    if (this.suppressed) return;
    this.clearOldest(this.layout().maxCount - 1);
    const node = this.createNode(entry);
    this.nodes.unshift(node);
    this.restack();
    this.timers.set(
      node,
      setTimeout(() => this.remove(node), this.layout().lifetimeMs),
    );
  }

  /** 切场景清场（Game.destroy 调用） */
  static reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const node of this.nodes) if (node.isValid) node.destroy();
    this.nodes = [];
    this.suppressed = false;
  }

  //#region 内部

  private static layout() {
    return layout.bubbles;
  }

  /** 一条气泡：圆角底 + 「名字：正文」（名字行带帮会前缀与私聊箭头，与面板行同口径） */
  private static createNode(entry: ChatEntry): Node {
    const bubble = this.layout();
    const node = new Node(`chat_bubble_${Date.now()}`);
    node.addComponent(UITransform).setContentSize(bubble.size.width, bubble.size.height);
    node.getComponent(UITransform)?.setAnchorPoint(0, 1); // 左上锚点：往下堆
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = bubble.fill;
    graphics.roundRect(0, -bubble.size.height, bubble.size.width, bubble.size.height, bubble.radius);
    graphics.fill();
    graphics.lineWidth = 1;
    graphics.strokeColor = bubble.border;
    graphics.roundRect(0, -bubble.size.height, bubble.size.width, bubble.size.height, bubble.radius);
    graphics.stroke();
    const labelNode = UiHelper.createNode(
      `${layout.name}_bubble_text`,
      new Vec2(8, -bubble.size.height / 2),
      new Size(bubble.size.width - 16, bubble.size.height - 8),
    );
    const label = labelNode.addComponent(Label);
    label.fontSize = bubble.fontSize;
    label.lineHeight = bubble.size.height - 8;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.string = this.caption(entry);
    labelNode.setPosition(8, -bubble.size.height / 2);
    node.addChild(labelNode);
    node.setPosition(this.layout().position.x, this.layout().position.y);
    LayerManager.addToGameLayer(node);
    return node;
  }

  /** 气泡文案：与面板行同口径（帮会前缀 / 私聊箭头），正文截断 */
  private static caption(entry: ChatEntry): string {
    const texts = layout.texts;
    let name = entry.from.username;
    if (entry.from.guildName) name = texts.guildPrefix.split("{guild}").join(entry.from.guildName) + name;
    if (entry.channel === "private" && entry.to) name += texts.privateTo.split("{name}").join(entry.to.username);
    const max = this.layout().textMaxLength;
    const text = entry.text.length > max ? `${entry.text.slice(0, max)}…` : entry.text;
    return `${name}：${text}`;
  }

  /** 让存量气泡逐条下移（spacing 一格）；超量的直接销毁 */
  private static restack(): void {
    const bubble = this.layout();
    this.nodes.forEach((node, index) => {
      if (node.isValid) node.setPosition(bubble.position.x, bubble.position.y - index * bubble.spacing);
    });
  }

  /** 挤掉最旧的 n 条（含它们的计时器） */
  private static clearOldest(keep: number): void {
    while (this.nodes.length > keep) {
      const node = this.nodes.pop();
      if (node) this.remove(node);
    }
  }

  private static remove(node: Node): void {
    this.nodes = this.nodes.filter((item) => item !== node);
    const timer = this.timers.get(node);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(node);
    }
    if (node.isValid) node.destroy();
  }

  //#endregion
}
