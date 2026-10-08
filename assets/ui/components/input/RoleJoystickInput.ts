import { EventTouch, isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import GameHelper from "../../core/GameHelper";
import { clampJoystickOffset, resolveJoystickMove } from "../../utils/input/Joystick";
import { blockClickThrough } from "../../utils/input/UiHit";

/**
 * 角色摇杆操控输入（左下角常驻摇杆的「手感」部分）
 *
 * 只保存按下状态、方向与走/跑，并按拖动实时把手柄摆到对应位置（手柄节点由构造注入）；
 * 角色每帧读 moveDirection/isRunning 决定位移与动画，状态变化时通过构造注入的回调通知宿主刷新动作朝向
 * —— 与键盘操控（RoleKeyboardInput）、鼠标操控（RolePointerInput）同一套模式。
 *
 * **只用 touch 通道**（TOUCH_START / MOVE / END / CANCEL），不注册任何 MOUSE_*：
 * · 引擎在鼠标按下后会把鼠标移动／抬起**成对模拟**成 touch-move／touch-end
 *   （input._registerEvent：mouse-down 置 `_needSimulateTouchMoveEvent = true` 后 `_simulateEventTouch`，
 *    mouse-move 在它仍为 true 时同样模拟，mouse-up 置回 false 再模拟一次；
 *    类型映射见同文件的 `{ "mouse-down": "touch-start", "mouse-move": "touch-move", "mouse-up": "touch-end" }`），
 *   所以桌面端用鼠标按住拖动同样能收到 TOUCH_MOVE —— 一套通道同时覆盖触屏与桌面；
 * · 反过来若再注册 MOUSE_*，一次鼠标操作会派发两次（同一次拖动被算两遍）；
 * · 而且 MOUSE_MOVE **绝不能注册在节点上**：节点一旦命中就吞掉它，指针样式（CursorInput）与
 *   世界侧的按住走路（RolePointerInput）都会卡住，见 utils/input/Pointer 的长注释。
 *
 * touch 通道自带「本次触摸独占」：TOUCH_START 命中的节点会一直收到后续 MOVE/END（引擎的
 * pointer-event-dispatcher.claimedTouchIdList），所以拖动中不必担心事件被别的元素抢走。
 *
 * 手柄位移以**底座中心**为基准（按下点在底座内任意位置即成为手柄所在方向），位移被夹在
 * configs/layout/hud.joystickLayout.radius 之内；走/跑与方向由 utils/input/Joystick 的纯函数判定
 * （拖动幅度占半径的比例：低于死区不动、中间走路、超过阈值跑动）。
 *
 * 与界面/世界侧的交界：· 摇杆是 UI 元素，所以在它上面按下时世界侧不会接管成「按住走路」
 * （RolePointerInput 会按 LayerManager.isPointOnUi 跳过）；· 这里调 blockClickThrough 补齐鼠标通道的
 * 穿透拦截与「按压起点」登记 —— 于是「在摇杆上按下、拖到摇杆外才松手」的那次抬起不会被世界侧
 * 当作一次世界点击（见 ScreenClickInput 的起点判定），选中目标/自动战斗不会被误打断。
 */
export default class RoleJoystickInput {
  /** 摇杆底座节点（= 触摸命中的范围，尺寸见 joystickLayout.size） */
  private host: Node;
  /** 手柄节点（跟随拖动位移；锚点在自身中心） */
  private handle: Node;
  /** 状态变化回调（宿主刷新动作与朝向） */
  private onStateChanged: () => void;
  /** 是否按住（触摸在摇杆上按下且未抬起） */
  private pressed = false;
  /** 是否跑动（拖动幅度达到跑动阈值） */
  private run = false;
  /** 移动方向（八方向之一的单位向量；零向量表示不移动） */
  private direction: Vec2 = new Vec2();

  constructor(host: Node, handle: Node, onStateChanged: () => void) {
    this.host = host;
    this.handle = handle;
    this.onStateChanged = onStateChanged;
    host.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
    host.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
    host.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    // 触摸被系统打断（来电/手势冲突）同样要收尾，否则手柄停在拖到的位置、角色一直走
    host.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    // 点击不穿透下层 + 顺手登记「按压起点」（摇杆是 UI 元素，鼠标通道也参与命中）
    blockClickThrough(host);
    // 宿主销毁时自动移除监听，避免重进场景后残留对已销毁节点的引用
    host.once(Node.EventType.NODE_DESTROYED, () => this.destroy());
  }

  /** 是否正在移动（按下且方向有效） */
  get isMoving(): boolean {
    return this.pressed && this.direction.lengthSqr() > 0;
  }

  /** 是否跑动（拖动幅度达到跑动阈值） */
  get isRunning(): boolean {
    return this.run;
  }

  /** 移动方向（八方向之一的单位向量；无输入时为零向量） */
  get moveDirection(): Vec2 {
    return this.direction;
  }

  /** 移除监听并收尾（幂等）；节点销毁时由 NODE_DESTROYED 自动调用 */
  destroy() {
    this.release(false);
  }

  /**
   * 触摸按下：开始一次摇杆操作，并立即按按下点定方向
   * （按下点落在底座内任意位置都算 —— 手柄跳到该方位，按下的那一刻就开始走/跑）
   */
  private onTouchStart(event: EventTouch) {
    this.pressed = true;
    this.applyTouch(event);
  }

  /** 拖动：手柄跟着走，方向与走/跑实时更新 */
  private onTouchMove(event: EventTouch) {
    if (!this.pressed) return;
    this.applyTouch(event);
  }

  /** 抬起：结束本次操作 */
  private onTouchEnd() {
    this.release();
  }

  /** 触摸被打断：按抬起处理 */
  private onTouchCancel() {
    this.release();
  }

  /**
   * 结束本次操作：手柄回中、清方向与走/跑状态
   * 幂等：本来就没在按住时什么都不做；死区内按下又原地松开（压根没走过）不必惊动宿主
   * @param notify 是否通知宿主刷新动作（节点销毁时不通知：那时宿主多半也在销毁中）
   */
  private release(notify = true) {
    if (!this.pressed) return;
    const wasMoving = this.direction.lengthSqr() > 0;
    this.pressed = false;
    this.run = false;
    this.direction = new Vec2();
    if (isValid(this.handle)) this.handle.setPosition(0, 0, 0);
    if (wasMoving && notify) this.onStateChanged();
  }

  /** 按本次触摸点更新手柄位置与移动状态 */
  private applyTouch(event: EventTouch) {
    const offset = this.getOffsetByTouch(event);
    if (!offset) return;
    // 手柄摆在夹取后的位置（可见），判定也用它 —— 所见即所得：手柄贴到最外圈就是最大速度
    const clamped = clampJoystickOffset(offset);
    if (isValid(this.handle)) this.handle.setPosition(clamped.x, clamped.y, 0);
    const state = resolveJoystickMove(clamped);
    this.setMoveState(state ? state.direction : new Vec2(), state ? state.run : false);
  }

  /**
   * 触摸点 -> 相对底座中心的位移（底座节点坐标系；相机未就绪时返回 null）
   * 触摸事件给的是**屏幕坐标**（物理像素，与命中检测同一口径），先经相机换算到世界坐标，
   * 再转到摇杆节点本地空间（与 GameUiHelper.followScreenPoint 同一套换算）
   */
  private getOffsetByTouch(event: EventTouch): Vec2 | null {
    const transform = this.host.getComponent(UITransform);
    if (!transform || !GameHelper.camera) return null;
    const point = event.getLocation();
    const world = GameHelper.screenPositionToWorldPosition(new Vec3(point.x, point.y, 0));
    const local = transform.convertToNodeSpaceAR(world, new Vec3());
    return new Vec2(local.x, local.y);
  }

  /** 落地新状态与新手柄方向（方向或走/跑真的变了才通知宿主，避免高频 TOUCH_MOVE 空刷动作） */
  private setMoveState(direction: Vec2, run: boolean) {
    const changed = !this.direction.equals(direction) || this.run !== run;
    this.direction = direction;
    this.run = run;
    if (changed) this.onStateChanged();
  }
}
