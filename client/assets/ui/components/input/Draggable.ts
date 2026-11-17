import { _decorator, Component, EventTouch, Node } from "cc";
import { blockClickThrough } from "../../utils/input/UiHit";
const { ccclass } = _decorator;

/**
 * 拖拽行为组件（挂在节点上使其可拖动，拖的是 dragTarget —— 缺省拖自身）
 *
 * #1090 用户拍板：**只有标题栏可以拖动弹窗**，内容区（列表/网格/空白）怎么拖都不影响弹窗位置。
 * 所以本组件只由 GameUiHelper.createDialog 挂在「标题栏拖拽柄」条带上（透明、垫在标题与
 * 关闭键之下），dragTarget 指向弹窗根；弹窗根上不再挂拖拽。
 *
 * 为什么内容区天生拖不动弹窗：触摸被引擎认领给「按下点的最深带 touch 监听节点」
 * （cocos/2d/event/pointer-event-dispatcher），列表（ScrollView）、背包格（物品拖动）都
 * 在更深处认领了触摸，事件根本不会到标题栏柄上；关闭按钮是柄的**兄弟**节点且命中更深，
 * 按它也走不到这里 —— 拖拽只可能从柄自己的空白条上开始。
 */
@ccclass("Draggable")
export class Draggable extends Component {
  /** 被拖动的节点（弹窗根）；不设置则拖自身 */
  dragTarget: Node | null = null;

  /** 按下点是否落在拖拽柄上（只有认领给柄自己的按下才算数） */
  private pressed = false;

  /** 注册触摸监听（拖拽柄同时要在鼠标通道拦截，点它不穿透到下层 UI） */
  start() {
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

  /** 按下：认领给柄自己才开始记（子件/兄弟件的按下不拖） */
  private onTouchStart(event: EventTouch) {
    this.pressed = event.target === this.node;
  }

  /** 按屏幕像素级偏移移动目标节点（拖动期间停住冒泡） */
  private onTouchMove(event: EventTouch) {
    event.propagationStopped = true;
    if (!this.pressed) return;
    const target = this.dragTarget ?? this.node;
    const delta = event.getUIDelta();
    target.setPosition(target.position.x + delta.x, target.position.y + delta.y, 0);
  }

  /** 结束拖拽 */
  private onTouchEnd(event: EventTouch) {
    event.propagationStopped = true;
    this.pressed = false;
  }
}
