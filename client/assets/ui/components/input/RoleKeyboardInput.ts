import { EventKeyboard, Input, input, KeyCode, Node, Vec2 } from "cc";

/**
 * 角色键盘操控输入
 * 只负责 WASD/Shift 的按下状态与全局监听（键盘事件必须挂在全局 input 单例上，节点上收不到），
 * 按键状态变化时通过构造注入的回调通知宿主（宿主刷新动作与朝向）
 * 宿主节点销毁时自动移除全局监听，避免重进场景后残留对已销毁节点的引用
 */
export default class RoleKeyboardInput {
  /** 上（W） */
  private up = false;
  /** 下（S） */
  private down = false;
  /** 左（A） */
  private left = false;
  /** 右（D） */
  private right = false;
  /** 疾跑（Shift） */
  private sprint = false;
  /** 按键状态变化回调（宿主刷新动作与朝向） */
  private onKeysChanged: () => void;

  constructor(host: Node, onKeysChanged: () => void) {
    this.onKeysChanged = onKeysChanged;
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    host.once(Node.EventType.NODE_DESTROYED, () => this.destroy());
  }

  /** 是否有方向键按下 */
  get isMoving(): boolean {
    return this.up || this.down || this.left || this.right;
  }

  /** 上（W）是否按下 */
  get isUp(): boolean {
    return this.up;
  }

  /** 下（S）是否按下 */
  get isDown(): boolean {
    return this.down;
  }

  /** 左（A）是否按下 */
  get isLeft(): boolean {
    return this.left;
  }

  /** 右（D）是否按下 */
  get isRight(): boolean {
    return this.right;
  }

  /** 是否按住疾跑键 */
  get isSprinting(): boolean {
    return this.sprint;
  }

  /** 归一化的移动方向（无输入时为零向量） */
  get moveDirection(): Vec2 {
    const direction = new Vec2((this.right ? 1 : 0) - (this.left ? 1 : 0), (this.up ? 1 : 0) - (this.down ? 1 : 0));
    if (direction.length() > 0) direction.normalize();
    return direction;
  }

  /** 移除全局键盘监听（幂等） */
  destroy() {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  /** 按键按下 */
  private onKeyDown(event: EventKeyboard) {
    this.setKeyState(event.keyCode, true);
    this.onKeysChanged();
  }

  /** 按键抬起 */
  private onKeyUp(event: EventKeyboard) {
    this.setKeyState(event.keyCode, false);
    this.onKeysChanged();
  }

  /** 按键码对应的按下状态变更 */
  private setKeyState(keyCode: number, pressed: boolean) {
    switch (keyCode) {
      case KeyCode.KEY_W:
        this.up = pressed;
        break;
      case KeyCode.KEY_S:
        this.down = pressed;
        break;
      case KeyCode.KEY_A:
        this.left = pressed;
        break;
      case KeyCode.KEY_D:
        this.right = pressed;
        break;
      case KeyCode.SHIFT_LEFT:
        this.sprint = pressed;
        break;
    }
  }
}
