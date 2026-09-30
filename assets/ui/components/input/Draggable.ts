import { _decorator, Component, EventTouch, Node } from "cc";
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

  /** 开始拖拽（拦截冒泡，防止 ScrollView 跟着滚） */
  private onTouchStart(event: EventTouch) {
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
