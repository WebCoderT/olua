import { EventTouch, Graphics, Layout, Node, ScrollView, UITransform, Vec2, isValid } from "cc";
import CombatChannel, { ChangeChannelResult } from "../../utils/net/CombatChannel";
import { channelSelectLayout as layout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import { blockClickThrough } from "../../utils/input/UiHit";
import { designResolution } from "../../utils/layout/ScreenLayout";
import { clearChildren } from "../../utils/node/NodeTree";
import { createRoundedPanel } from "./tab-kit";
import LayerManager from "../../core/LayerManager";

/**
 * 选线弹窗（全屏模态，#1016）
 *
 * ## 在哪打开、什么时候
 * 小地图下方那颗「N 线」标签（`maxChannels > 1` 的图才是可点的，见 SmallMap）。
 * 单线图连入口都不渲染 —— 点了也是它，没有可换的东西。
 *
 * ## 数据是纯本地的
 * 线数读配置快照的 `maps`（#812 已下发 `maxChannels`），当前线读 `world` 帧带回的
 * `channel`（#1000）—— 开弹窗不拉接口，行就是「1 线、2 线…」。当前线由 SmallMap
 * 打开时传入，弹窗期间服务端把它换走了也不追（成功应答里带的是权威线号）。
 *
 * ## 失败留在弹窗里
 * 换线失败（目标线满 / 线号不存在 / 区维护中）时弹窗**不关**：玩家要换线的意图还在，
 * 关掉等于替他放弃。按 `field` 提示一句，他可以挑别的线再点。成功才关窗飘字。
 */
export default class ChannelSelectDialog {
  /** 弹窗根（未打开时为 null） */
  private dialog: Node | null = null;
  /** 打开时的当前线（行的「当前」角标与高亮） */
  private currentChannel = 0;

  /** 打开（已开着就先关再按最新数据重开 —— 线号是会变的，重建比逐行刷新省心） */
  open(maxChannels: number, currentChannel: number) {
    this.close();
    this.currentChannel = currentChannel;
    this.dialog = this.create(Math.max(1, Math.trunc(maxChannels)));
    LayerManager.addDialogToUILayer(this.dialog);
  }

  /** 关闭并销毁 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
  }

  isOpen(): boolean {
    return !!this.dialog && isValid(this.dialog) && this.dialog.active;
  }

  /** 组装弹窗（几何、配色全部来自 configs/layout/dialogs.channelSelectLayout） */
  private create(maxChannels: number): Node {
    const dialog = new Node(layout.name);
    // 全屏尺寸 = 设计分辨率（与选服弹窗同一口径）：遮罩正好盖满屏幕
    const screenSize = designResolution;
    dialog.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    // 遮罩：黑色半透明 + 兼作下层点击的拦截层
    const mask = new Node(`${layout.name}_mask`);
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    dialog.addChild(mask);
    // 居中面板
    const panel = GameUiHelper.createDialogPanel(layout.panel.name, layout.panel.size);
    // 眉题（全弹窗统一副标题口径，见 createEyebrow）
    panel.addChild(GameUiHelper.createEyebrow(`${layout.panel.name}_eyebrow`, layout.panel.size, layout.eyebrow));
    dialog.addChild(panel);
    const title = layout.titleLabel;
    panel.addChild(UiHelper.createLabel(title.name, getText("channel_select_title"), title.color, title.fontSize, title.position, title.size));
    const hint = layout.hint;
    panel.addChild(UiHelper.createLabel("channel_select_hint", getText("channel_select_hint"), hint.color, hint.fontSize, hint.position, hint.size));
    // 线列表（纵向滚动；0..maxChannels-1 → 玩家视角的 1..N 线）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    const content = list.getComponent(ScrollView)?.content;
    if (content) {
      content.getComponent(Layout)!.spacingY = layout.row.gap;
      clearChildren(content);
      for (let channel = 0; channel < maxChannels; channel += 1) {
        content.addChild(this.createRow(channel, channel === this.currentChannel));
      }
    }
    panel.addChild(list);
    // 取消：打开选线窗不等于必须换
    const closeButton = GameUiHelper.createMiddleButton(layout.closeButton.name, layout.closeButton.text, layout.closeButton.position);
    closeButton.on(Node.EventType.TOUCH_END, () => this.close(), this);
    panel.addChild(closeButton);
    this.setupInputOwnership(dialog);
    return dialog;
  }

  /** 一行一条线：线名（左）/「当前」角标（右，只有所在线有） */
  private createRow(channel: number, current: boolean): Node {
    const row = layout.row;
    // 玩家视角的线号 = 服务端 channel + 1（公共线 0 就是「1 线」）
    const label = getText("channel_row_label", { channel: channel + 1 });
    const node = createRoundedPanel(
      `${layout.name}_row_${channel}`,
      row.size,
      row.fill,
      current ? row.currentBorder : row.border,
      row.radius,
    );
    node.addChild(UiHelper.createLabel(`${layout.name}_row_${channel}_name`, label, row.nameColor, row.nameFontSize, new Vec2(row.nameX, 0), row.nameSize));
    if (current) {
      node.addChild(
        UiHelper.createLabel(`${layout.name}_row_${channel}_tag`, getText("channel_tag_current"), row.tagColor, row.tagFontSize, new Vec2(row.tagX, 0), row.tagSize),
      );
    }
    // 整行就是一个点击目标：鼠标通道要独占（弹窗下面是可点的游戏世界）
    blockClickThrough(node);
    node.on(Node.EventType.TOUCH_END, () => this.pick(channel), this);
    return node;
  }

  /**
   * 选一条线
   *
   * 自己所在的线不浪费一次往返（本地就能判）；其余发 `changeChannel`，服务端**总是**
   * 回帧 —— 成功关窗飘字，失败按 `field` 提示并留在弹窗里。通道不在线 / 已有请求在途
   * 时发不出去（返回 false），提示而不假装发了。
   */
  private pick(channel: number): void {
    if (channel === this.currentChannel) {
      GameUiHelper.createTip("channel_same_tip");
      return;
    }
    const sent = CombatChannel.requestChangeChannel(channel, (result) => this.applyResult(channel, result));
    if (!sent) {
      // 发不出去只有两种原因：通道不在线 / 上一条还没回来。按 CombatChannel.active 分开提示
      GameUiHelper.createTip(CombatChannel.active ? "channel_busy_tip" : "channel_offline_tip");
      return;
    }
  }

  /** 换线应答落场：成功关窗飘字；失败按 field / timedOut 取文案，弹窗留着让人再挑 */
  private applyResult(requested: number, result: ChangeChannelResult): void {
    if (result.ok) {
      this.close();
      GameUiHelper.createTip("channel_changed_tip", { channel: result.channel + 1 });
      return;
    }
    if (result.timedOut) {
      GameUiHelper.createTip("channel_timeout_tip");
      return;
    }
    if (result.field === "full") {
      // 服务端指了一条还有空位的线就顺路带上（玩家不用一条条试）
      if (typeof result.suggestChannel === "number") {
        GameUiHelper.createTip("channel_full_suggest_tip", { channel: requested + 1, suggest: result.suggestChannel + 1 });
      } else {
        GameUiHelper.createTip("channel_full_tip", { channel: requested + 1 });
      }
      return;
    }
    GameUiHelper.createTip(result.field === "zone" ? "channel_zone_tip" : "channel_unknown_tip");
  }

  /**
   * 输入独占：触摸通道让遮罩/面板独占本次触摸，鼠标通道命中即中断
   *
   * 弹窗背后是整个游戏世界（摇杆 / 技能按钮 / 地图点击寻路），按下若穿透过去会顺手
   * 触发一次攻击或寻路。鼠标通道交给 blockClickThrough（它登记的是 MOUSE_UP 的中断）。
   */
  private setupInputOwnership(dialog: Node) {
    blockClickThrough(dialog);
    dialog.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 停住这次触摸的冒泡（不再传给下层的摇杆与按钮） */
  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }
}
