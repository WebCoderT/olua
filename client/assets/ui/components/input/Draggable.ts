import { _decorator, Component, EventTouch, Node } from "cc";
import { blockClickThrough } from "../../utils/input/UiHit";
const { ccclass } = _decorator;

/**
 * 拖拽行为组件（挂在节点上使其可拖动）
 * 由 GameUiHelper.createDialogBg 挂到弹窗背景上，实现弹窗拖拽移动；
 * 拖拽期间拦截触摸事件冒泡，避免触发底下的 ScrollView 滚动
 */
@ccclass("Draggable")
export class Draggable extends Component {
  /** 是否处于拖拽中 */
  private dragging = false;

  /** 注册触摸监听 */
  start() {
    // 可拖拽节点必然是可点元素（弹窗背景），拖拽逻辑走 TOUCH_* 通道；
    // 这里在鼠标通道补一次命中拦截，避免按住拖动时点击穿透到下层 UI（见 utils/input/UiHit.blockClickThrough）
    blockClickThrough(this.node);
    this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
    this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
    this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
  }

  /** 移除监听，避免内存泄漏 */
  onDestroy() {
    this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
    this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
    this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
  }

  /**
   * 开始拖拽（拦截冒泡，防止 ScrollView 跟着滚）
   *
   * 按下点**自带拖动手势**时（背包格子的物品拖动、滚动视图、滑条…这类都在自己的节点上注册了
   * TOUCH_MOVE），这次拖动归它，弹窗不抢：子节点的触摸会冒泡到这里，但「谁有自己的拖动」一望可辨 ——
   * 注册过 TOUCH_MOVE 的就是。少了这一条，子节点一拖、整个弹窗跟着一起动
   * （背包那边还会自己把触摸收住，这里是通用兜底，见 components/panel/BagGridView.setupTouchOwnership）。
   * 判 `!== this.node`：弹窗自己就是拖拽柄，也注册了 TOUCH_MOVE，别把自己也拦掉 ——
   * 按下点没有命中任何子节点时（弹窗空白处、标题这类没有手势的子节点），弹窗照旧可以拖。
   */
  private onTouchStart(event: EventTouch) {
    // 每次按下都从「不拖」开始：上一次的残留状态不该让弹窗跟着动
    this.dragging = false;
    if (event.target && event.target !== this.node && event.target.hasEventListener(Node.EventType.TOUCH_MOVE)) return;
    this.dragging = true;
    event.propagationStopped = true;
  }

  /** 按屏幕像素级偏移移动节点 */
  private onTouchMove(event: EventTouch) {
    event.propagationStopped = true;
    if (!this.dragging) return;
    const delta = event.getUIDelta();
    this.node.position = this.node.position.add3f(delta.x, delta.y, 0);
  }

  /** 结束拖拽 */
  private onTouchEnd(event: EventTouch) {
    event.propagationStopped = true;
    this.dragging = false;
  }
}
