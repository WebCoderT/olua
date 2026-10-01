import { BoxCollider2D, EventMouse, Input, input, isValid, Node, Vec2, Vec3 } from "cc";
import { pointerMove } from "../../../configs/role";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import { getDirectionByVector, getVectorByDirection } from "../../utils/battle/BattleMath";
import { getHitScreenPoint } from "../../utils/input/Pointer";

/**
 * 角色鼠标操控输入
 * 鼠标左键按住走路、右键按住跑动、抬起即停；方向 = 「指针位置相对角色的方位」按 360° 平分八块取其一
 * （相机始终跟随主角、主角即在画面中心，所以这就是「相对画面的位置」；八方向与角色动画朝向一致）
 *
 * 方向随指针实时更新：按下时算一次，按住期间每次 MOUSE_MOVE 重算并量化，
 * 所以按住后把指针拖到别的方位，角色立刻转向（不是只在按下那一刻把方向定死）
 *
 * 与键盘操控（RoleKeyboardInput）同一套模式：只保存按下状态与方向，
 * 角色每帧读 moveDirection/isRunning 决定位移与动画，状态变化时通过构造注入的回调通知宿主刷新动作朝向
 *
 * 不接管的按下：① 落在 UI 元素上（界面操作：开背包/换装/右键使用…）；
 * ② 落在怪物身上（那是选中/攻击，抬起时由 ScreenClickInput 选中，与之一致）
 *
 * 死区（指针几乎踩在角色身上）：按下时只记按下状态、方向留空，指针拖出死区后由 MOUSE_MOVE 补上方向；
 * 按住期间指针滑回死区则保持上一次方向（不更新，也不停下），避免拖动经过身体时一停一走；
 * 抬起、或宿主节点销毁时清零
 */
export default class RolePointerInput {
  /** 鼠标事件坐标基准与方向基准（角色节点） */
  private host: Node;
  /** 按下状态变化回调（宿主刷新动作与朝向） */
  private onStateChanged: () => void;
  /** 是否按下（左键或右键） */
  private pressed = false;
  /** 是否跑动（右键按下） */
  private run = false;
  /** 移动方向（八方向之一的单位向量；零向量表示不移动） */
  private direction: Vec2 = new Vec2();

  constructor(host: Node, onStateChanged: () => void) {
    this.host = host;
    this.onStateChanged = onStateChanged;
    input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    // 按住期间的指针移动必须收：方向要跟着指针走（仅按下时收，松开状态直接返回）
    input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    // 宿主销毁时自动移除全局监听，避免重进场景后残留对已销毁节点的引用
    host.once(Node.EventType.NODE_DESTROYED, () => this.destroy());
  }

  /** 是否正在移动（按下且方向有效） */
  get isMoving(): boolean {
    return this.pressed && this.direction.lengthSqr() > 0;
  }

  /** 是否跑动（右键按下） */
  get isRunning(): boolean {
    return this.run;
  }

  /** 移动方向（八方向之一的单位向量；无输入时为零向量） */
  get moveDirection(): Vec2 {
    return this.direction;
  }

  /** 移除全局鼠标监听（幂等） */
  destroy() {
    input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
  }

  /**
   * 按下：左键走路、右键跑动，并按当前指针位置定方向
   * UI 上或怪物身上的按下不接管；死区内按下只记状态（方向留空，等拖出死区再定）
   */
  private onMouseDown(event: EventMouse) {
    const button = event.getButton();
    const run = button === EventMouse.BUTTON_RIGHT;
    // 只认左右键（中键等忽略）
    if (!run && button !== EventMouse.BUTTON_LEFT) return;
    const screenPoint = getHitScreenPoint(event);
    // 按在 UI 上：交给界面自己处理，世界侧不接管（与「点 UI 不打断角色操作」同一条规则）
    if (LayerManager.isPointOnUi(screenPoint)) return;
    // 按在怪物身上：那是选中/攻击，不移动（ScreenClickInput 会在抬起时把它选中）
    if (MonsterManager.getClickedMonster(screenPoint)) return;
    this.pressed = true;
    this.setDirection(this.getDirectionByScreenPoint(screenPoint), run);
  }

  /**
   * 按住期间指针移动：方向跟着指针实时改（八分之一扇区为最小变化单位，扇区内不动不通知宿主）
   * 落在死区里（指针滑到角色身上）不改方向也不停下，抬起才停
   */
  private onMouseMove(event: EventMouse) {
    if (!this.pressed) return;
    const direction = this.getDirectionByScreenPoint(getHitScreenPoint(event));
    if (direction.lengthSqr() <= 0) return;
    this.setDirection(direction, this.run);
  }

  /** 抬起：任何键抬起都停（引擎的 mouseup 挂在 window 上，拖出画布再松开同样收得到） */
  private onMouseUp() {
    if (!this.pressed) return;
    const wasMoving = this.direction.lengthSqr() > 0;
    this.pressed = false;
    this.run = false;
    this.direction = new Vec2();
    // 死区内按下又原地松开（压根没走过）不必惊动宿主
    if (wasMoving) this.onStateChanged();
  }

  /** 落地新方向与新跑动状态（方向或走/跑真的变了才通知宿主，避免同扇区内的高频 MOUSE_MOVE 空刷动作） */
  private setDirection(direction: Vec2, run: boolean) {
    const changed = !this.direction.equals(direction) || this.run !== run;
    this.direction = direction;
    this.run = run;
    if (changed) this.onStateChanged();
  }

  /**
   * 指针位置相对角色的方位 -> 八方向单位向量
   * 基准取角色身体中心（节点原点 + 碰撞盒偏移）而不是节点原点：角色锚点在脚底，
   * 以原点判定会让「点角色头顶」变成向上走
   */
  private getDirectionByScreenPoint(screenPoint: Vec2): Vec2 {
    const camera = LayerManager.camera;
    if (!camera || !isValid(camera.node) || !isValid(this.host)) return new Vec2();
    const worldPoint = camera.screenToWorld(new Vec3(screenPoint.x, screenPoint.y, 0), new Vec3());
    const rolePosition = this.host.getWorldPosition();
    const bodyOffset = this.host.getComponent(BoxCollider2D)?.offset;
    const offset = new Vec2(worldPoint.x - rolePosition.x - (bodyOffset?.x ?? 0), worldPoint.y - rolePosition.y - (bodyOffset?.y ?? 0));
    // 死区：指针几乎踩在角色身上时不定方向（按住期间落在死区里则保持上一次方向，见 onMouseMove）
    if (offset.length() < pointerMove.deadZone) return new Vec2();
    return getVectorByDirection(getDirectionByVector(offset));
  }
}
