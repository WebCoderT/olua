import { _decorator, Component, EventTouch, Node } from "cc";
const { ccclass } = _decorator;

// 可拖拽组件：使挂载节点支持触摸拖拽操作
@ccclass("Draggable")
export class Draggable extends Component {
  // 本组件内部的拖拽状态标志
  private dragging = false;

  // 生命周期：注册触摸事件监听器
  start() {
    this.node.on(Node.EventType.TOUCH_START, this._onStart, this);
    this.node.on(Node.EventType.TOUCH_MOVE, this._onMove, this);
    this.node.on(Node.EventType.TOUCH_END, this._onEnd, this);
    this.node.on(Node.EventType.TOUCH_CANCEL, this._onEnd, this);
  }
  // 生命周期：移除监听，避免内存泄漏
  onDestroy() {
    this.node.off(Node.EventType.TOUCH_START, this._onStart, this);
    this.node.off(Node.EventType.TOUCH_MOVE, this._onMove, this);
    this.node.off(Node.EventType.TOUCH_END, this._onEnd, this);
    this.node.off(Node.EventType.TOUCH_CANCEL, this._onEnd, this);
  }

  // 触摸开始处理：设置拖拽并阻止事件继续冒泡
  private _onStart(e: EventTouch) {
    this.dragging = true;
    // 阻止事件继续冒泡，防止 ScrollView 跟着滚
    e.propagationStopped = true;
  }
  // 触摸移动处理：按 delta 更新节点位置
  private _onMove(e: EventTouch) {
    e.propagationStopped = true;
    if (!this.dragging) return;
    const delta = e.getUIDelta(); // 屏幕像素级偏移
    this.node.position = this.node.position.add3f(delta.x, delta.y, 0);
  }
  // 触摸结束处理：关闭拖拽标志并阻止冒泡
  private _onEnd(e: EventTouch) {
    e.propagationStopped = true;
    this.dragging = false;
  }
}
