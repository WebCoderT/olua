import { EventTouch, Graphics, Label, Node, Size, UITransform, Vec2 } from "cc";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";
import { confirmDialogLayout } from "../../../configs/hudLayout";
import { blockClickThrough } from "../../utils/input/UiHit";
import { getVisibleSize } from "../../utils/layout/ScreenLayout";

/** 确认框的文案与回调（文案由使用方从 configs/texts 取，见 BagDialog 的拖出销毁） */
export interface ConfirmDialogOptions {
  /** 标题（面板上部） */
  title: string;
  /** 正文（说明这次操作的对象与后果，可换行） */
  message: string;
  /** 「确定」按钮文案 */
  confirmText: string;
  /** 「取消」按钮文案 */
  cancelText: string;
  /** 点「确定」（确认框已先关闭，这里直接执行不可恢复的操作） */
  onConfirm: () => void;
  /** 点「取消」（确认框已先关闭，数据保持原样） */
  onCancel: () => void;
}

/**
 * 通用确认框（自身即全屏模态节点，由使用方挂到 UI 层顶层）
 *
 * 用途：给「不可恢复的操作」一个明确的二选一 —— 确定执行 / 取消放弃。
 * 与「再点一次确认」（回收、丢弃模式、删角色）的分工：那套适合**按钮/格子本身还能再点一次**的场景，
 * 不新增节点；而「拖到背包弹窗外面松手」是一次性动作、没有可以再点的对象，只能靠确认框。
 *
 * 为什么必须自己接管输入（两层都要）：
 * · 触摸通道：面板/遮罩自身注册 TOUCH_* 并在回调里停冒泡，按下遮罩即独占本次触摸 ——
 *   否则一次按下会穿过遮罩落到下面的背包格子（格子注册了 TOUCH_START，会开始拖物品）；
 * · 鼠标通道：blockClickThrough 命中即中断，下层 UI（背包按钮）与世界（点地面走路）都收不到这次点击。
 * 全屏尺寸取「可见区」而不是设计分辨率（见 ScreenLayout.getVisibleSize），任意窗口宽高比都盖满屏幕。
 *
 * 点遮罩空白处**不做任何事**：销毁类操作必须明确选择，别让「随手点一下」被当成取消/确定。
 */
export default class ConfirmDialog extends Node {
  /** 点「确定」的回调（构造时注入，见 ConfirmDialogOptions） */
  private handleConfirm: () => void;
  /** 点「取消」的回调 */
  private handleCancel: () => void;

  constructor(options: ConfirmDialogOptions) {
    // 几何与配色见 configs/hudLayout.confirmDialogLayout（组件里不写坐标与尺寸）
    const layout = confirmDialogLayout;
    super(layout.name);
    this.handleConfirm = options.onConfirm;
    this.handleCancel = options.onCancel;
    // 全屏遮罩：覆盖整个可见区（黑色半透明，兼作下层点击的拦截层）
    const screenSize = getVisibleSize();
    this.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    const mask = new Node("confirm_mask");
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    this.addChild(mask);
    // 居中面板：标题 / 正文 / 确定 · 取消
    const panel = UiHelper.createSprite(layout.panel.name, layout.panel.background, new Vec2(), layout.panel.size);
    this.addChild(panel);
    panel.addChild(UiHelper.createLabel(layout.title.name, options.title, layout.title.color, layout.title.fontSize, layout.title.position, layout.title.size));
    panel.addChild(this.createMessage(options.message));
    const confirmButton = GameUiHelper.createMiddleButton(layout.confirmButton.name, options.confirmText, layout.confirmButton.position);
    const cancelButton = GameUiHelper.createMiddleButton(layout.cancelButton.name, options.cancelText, layout.cancelButton.position);
    confirmButton.on(Node.EventType.TOUCH_END, () => this.finish(this.handleConfirm), this);
    cancelButton.on(Node.EventType.TOUCH_END, () => this.finish(this.handleCancel), this);
    panel.addChild(confirmButton);
    panel.addChild(cancelButton);
    this.setupInputOwnership();
  }

  /** 正文（宽度固定、高度按内容自适应：文案带物品名与数量，长度不定） */
  private createMessage(text: string) {
    const layout = confirmDialogLayout.message;
    const node = UiHelper.createLabel(layout.name, text, layout.color, layout.fontSize, layout.position, new Size(layout.width, 0));
    const label = node.getComponent(Label)!;
    label.lineHeight = layout.lineHeight;
    label.overflow = Label.Overflow.RESIZE_HEIGHT;
    label.enableWrapText = true;
    return node;
  }

  /**
   * 收尾：**先关掉自己再执行回调** —— 回调里要刷新界面（丢弃会重建背包格子），
   * 确认框先消失才不会盖在刷新过程中；先关也顺手挡住「同一帧内连点两次」重复执行
   */
  private finish(handler: () => void) {
    this.destroy();
    handler();
  }

  /** 遮罩接管输入：触摸通道独占本次触摸 + 鼠标通道命中即中断（见类注释） */
  private setupInputOwnership() {
    blockClickThrough(this);
    // 同屏多弹窗时点哪个哪个浮到其它弹窗之上（确认框是全屏模态，本来就在最上，这里与其它弹窗同一套口径）
    GameUiHelper.bindDialogRaiseOnPress(this);
    this.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 停住这次触摸的冒泡（不再传给下层的背包格子与弹窗拖动） */
  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }
}
