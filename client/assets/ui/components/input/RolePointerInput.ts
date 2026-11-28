import { BoxCollider2D, EventMouse, Input, input, isValid, Node, Vec2, Vec3 } from "cc";
import { autoBattle } from "../../../configs/autoBattle";
import { pointerMove } from "../../../configs/role";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import { getDirectionByVector, getVectorByDirection } from "../../utils/battle/BattleMath";
import { clearWorldPressRelease, getHitScreenPoint, setWorldPressRelease } from "../../utils/input/Pointer";

/**
 * 角色鼠标操控输入
 * 鼠标左键按住走路、右键按住跑动；方向 = 「指针位置相对角色的方位」按 360° 平分八块取其一
 * （相机始终跟随主角、主角即在画面中心，所以这就是「相对画面的位置」；八方向与角色动画朝向一致）
 *
 * **连续模式（经典走路模式关闭，现状行为）**：方向随指针实时更新——按下时算一次，
 * 按住期间每次 MOUSE_MOVE 重算并量化，按住后把指针拖到别的方位角色立刻转向；抬起即停。
 *
 * **经典走路模式（#1340）**：步进制——每「步」固定 `autoBattle.classicStepLength` 像素：
 * - 按下定第一步方向（八分量化），走满步长才算走完一步；
 * - **点击一下（很快抬起）= 走完当前这一步后停**——不再是一帧位移的「挪一点点」；
 * - **持续按住 = 每走完一步立刻接下一步**，方向用最新指针方位在步边界重新量化
 *   （方向只在步边界切换，步中途不转向——这正是「走完一步才走下一步」）；
 * - 右键跑动同理，步长相同、速度用跑步。
 *
 * 步的推进由 `tick()` 驱动（RoleDisplay 每帧调用）：按**实际位移**累计步长——被墙/怪挡住时
 * 位移不足不算走完（顶着挡住的方向走不出去就不会空计步），滑墙位移照常累计。
 * 完全被挡（位移持续为 0）超过容忍时长则步作废停住，避免按住顶墙永久卡在「这一步」上。
 *
 * 与键盘操控（RoleKeyboardInput）同一套模式：只保存按下状态与方向，
 * 角色每帧读 moveDirection/isRunning 决定位移与动画，状态变化时通过构造注入的回调通知宿主刷新动作朝向
 *
 * 不接管的按下：① 落在 UI 元素上（界面操作：开背包/换装/右键使用…）；
 * ② 落在世界侧可交互对象上（NPC：点开对话/传送，LayerManager.isPointOnWorldInteractive）；
 * ③ 落在怪物身上（那是选中/攻击，抬起时由 ScreenClickInput 选中，与之一致）
 *
 * 抬起的两条来路：① 全局 MOUSE_UP（正常情况）；② **界面侧拦下抬起后的交还**——
 * 界面为了让点击不穿透会在鼠标通道上「命中即独占」（utils/input/UiHit.blockClickThrough），
 * 那条路径上全球监听收不到 MOUSE_UP，所以界面会把这次按压的结束通过 releaseWorldPress 交还过来
 * （构造时用 setWorldPressRelease 登记收尾回调）。少了这条交还，按住状态不解除，角色会一直走。
 *
 * 死区（指针几乎踩在角色身上）：按下时只记按下状态、方向留空，指针拖出死区后由 MOUSE_MOVE 补上方向；
 * 按住期间指针滑回死区则保持上一次方向（不更新，也不停下），避免拖动经过身体时一停一走；
 * 抬起、或宿主节点销毁时清零
 */
export default class RolePointerInput {
  /** 完全被挡（这一步内实际位移为 0）容忍时长：超过则当前步作废停住 */
  private static readonly BLOCKED_GIVE_UP_MS = 3000;

  /** 鼠标事件坐标基准与方向基准（角色节点） */
  private host: Node;
  /** 按下状态变化回调（宿主刷新动作与朝向） */
  private onStateChanged: () => void;
  /** 是否按下（左键或右键） */
  private pressed = false;
  /** 是否跑动（右键按下） */
  private run = false;
  /** 移动方向（八方向之一的单位向量；零向量表示不移动）。经典模式下 = 当前步的方向 */
  private direction: Vec2 = new Vec2();
  /** 经典模式：按住期间指针的最新方向（只在步边界采用，步中途不转向） */
  private pendingDirection: Vec2 = new Vec2();
  /** 经典模式：当前是否有一步在走（按下未定出方向时为 false，等 MOUSE_MOVE 出死区再起第一步） */
  private stepping = false;
  /** 经典模式：当前步还剩多少像素（按实际位移扣减） */
  private stepRemaining = 0;
  /** 经典模式：抬起后仍要把当前步走完（点击一下 = 走完一步） */
  private finishing = false;
  /** 经典模式：上一帧的角色位置（位移累计基准；null = 尚未记录） */
  private lastTickPos: Vec3 | null = null;
  /** 经典模式：从什么时刻起当前步内实际位移一直为 0（完全被挡的判定起点） */
  private blockedSince = 0;
  /** 界面交还抬起时的收尾回调（构造时创建一份，销毁时按同一引用注销） */
  private releaseHandler: () => void = () => this.handleRelease();

  constructor(host: Node, onStateChanged: () => void) {
    this.host = host;
    this.onStateChanged = onStateChanged;
    input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    // 按住期间的指针移动必须收：方向要跟着指针走（仅按下时收，松开状态直接返回）
    input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    // 界面拦下抬起时会把这次按压的结束交还过来（见 utils/input/Pointer 的「按压归属」）：
    // 那条路径上全局监听收不到 MOUSE_UP，没有这条回收，按住状态不解除、角色会一直走
    setWorldPressRelease(this.releaseHandler);
    // 宿主销毁时自动移除全局监听，避免重进场景后残留对已销毁节点的引用
    host.once(Node.EventType.NODE_DESTROYED, () => this.destroy());
  }

  /** 是否正在移动（按下且方向有效）。经典模式下抬起后的收尾步也算在移动 */
  get isMoving(): boolean {
    return (this.pressed || this.finishing) && this.direction.lengthSqr() > 0;
  }

  /** 是否跑动（右键按下） */
  get isRunning(): boolean {
    return this.run;
  }

  /** 移动方向（八方向之一的单位向量；无输入时为零向量）。经典模式 = 当前步方向 */
  get moveDirection(): Vec2 {
    return this.direction;
  }

  /** 移除全局鼠标监听（幂等） */
  destroy() {
    input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    clearWorldPressRelease(this.releaseHandler);
  }

  /**
   * 每帧步进推进（RoleDisplay.update 调用；连续模式为空操作）
   * 按「实际位移」扣减当前步剩余量：被墙/怪挡住时位移不足不空计步，
   * 顶死不动超过容忍时长则当前步作废停住（死亡/长攻击锁同理，不能永远卡在「这一步」上）
   */
  tick() {
    if (!autoBattle.classicWalkMode) return;
    if (!this.stepping || !isValid(this.host)) return;
    const position = this.host.getWorldPosition();
    if (this.lastTickPos) {
      const moved = Math.hypot(position.x - this.lastTickPos.x, position.y - this.lastTickPos.y);
      if (moved > autoBattle.classicStepLength * 2) {
        // 位移异常大（传送/服务端回拉）：这一步作废重记基准，不把瞬移算进步长
        this.lastTickPos = position.clone();
        return;
      }
      if (moved <= 0) {
        if (this.blockedSince === 0) this.blockedSince = Date.now();
        else if (Date.now() - this.blockedSince > RolePointerInput.BLOCKED_GIVE_UP_MS) {
          this.finishStepping();
          return;
        }
      } else {
        this.blockedSince = 0;
        this.stepRemaining -= moved;
        if (this.stepRemaining <= 0) {
          this.arriveStep();
          return;
        }
      }
    }
    this.lastTickPos = position.clone();
  }

  /**
   * 按下：左键走路、右键跑动，并按当前指针位置定方向
   * UI 上、世界侧可交互对象（NPC）上、怪物身上的按下都不接管；死区内按下只记状态（方向留空，等拖出死区再定）
   */
  private onMouseDown(event: EventMouse) {
    const button = event.getButton();
    const run = button === EventMouse.BUTTON_RIGHT;
    // 只认左右键（中键等忽略）
    if (!run && button !== EventMouse.BUTTON_LEFT) return;
    const screenPoint = getHitScreenPoint(event);
    // 按在 UI 上：交给界面自己处理，世界侧不接管（与「点 UI 不打断角色操作」同一条规则）
    if (LayerManager.isPointOnUi(screenPoint)) return;
    // 按在 NPC 这类世界侧可交互对象上：那是它自己的交互（点开对话/传送），不走路
    // （不拦的话按一下就先往 NPC 那边迈步，弹窗出来时角色还在走）
    if (LayerManager.isPointOnWorldInteractive(screenPoint)) return;
    // 按在怪物身上：那是选中/攻击，不移动（ScreenClickInput 会在抬起时把它选中）
    if (MonsterManager.getClickedMonster(screenPoint)) return;
    // 上一次按压的收尾步还没走完又按下：新按压接管，收尾标记作废（否则走完这步会被误停）
    this.finishing = false;
    this.pressed = true;
    this.run = run;
    const direction = this.getDirectionByScreenPoint(screenPoint);
    if (direction.lengthSqr() > 0) {
      // 经典模式：起第一步（步内方向固定）；连续模式：与现状一致实时跟随
      if (autoBattle.classicWalkMode) this.startStep(direction);
      else this.setDirection(direction, run);
    } else {
      // 死区内按下：只记状态（经典模式等 MOUSE_MOVE 出死区起第一步；连续模式保持现状行为）
      this.direction = new Vec2();
      this.onStateChanged();
    }
  }

  /**
   * 按住期间指针移动。
   * 连续模式：方向跟着指针实时改（八分之一扇区为最小变化单位）。
   * 经典模式：只缓存最新方向（pendingDirection），**步边界才采用**——步中途不转向；
   * 起步还没发生（死区内按下）时拖出死区立刻起第一步。
   */
  private onMouseMove(event: EventMouse) {
    if (!this.pressed) return;
    const direction = this.getDirectionByScreenPoint(getHitScreenPoint(event));
    if (direction.lengthSqr() <= 0) return;
    if (autoBattle.classicWalkMode) {
      this.pendingDirection = direction;
      if (!this.stepping) this.startStep(direction);
      return;
    }
    this.setDirection(direction, this.run);
  }

  /** 抬起：任何键抬起都停（引擎的 mouseup 挂在 window 上，拖出画布再松开同样收得到）。
   * 经典模式例外：抬起不立刻停——**当前这一步走完才停**（点击一下 = 走完一步） */
  private onMouseUp() {
    this.handleRelease();
  }

  /**
   * 结束按住（抬起、或界面拦下抬起后把这次按压交还回来）
   * 经典模式：还有一步在走 → 只标记收尾（finishing），走完当前步由 arriveStep 停；
   * 没有步在走（死区内原地松开 / 尚未起步）→ 立即清状态，与连续模式一致
   */
  private handleRelease() {
    if (!this.pressed) return;
    if (autoBattle.classicWalkMode && this.stepping) {
      this.finishing = true;
      this.pressed = false;
      return;
    }
    this.releasePress();
  }

  /**
   * 走完当前步：还有下一步（仍按住）→ 用最新指针方向起下一步；收尾步（已抬起）→ 彻底停住
   * 指针停在死区时保持上一步的方向继续走（与连续模式的死区口径一致：不因指针路过身体而停）
   */
  private arriveStep() {
    if (this.finishing || !this.pressed) {
      this.finishStepping();
      return;
    }
    const next = this.pendingDirection.lengthSqr() > 0 ? this.pendingDirection : this.direction;
    this.startStep(next);
  }

  /** 起一步：固定方向与剩余步长，步内不再转向；方向或走/跑变化时通知宿主刷新动作 */
  private startStep(direction: Vec2) {
    this.stepping = true;
    this.stepRemaining = autoBattle.classicStepLength;
    this.blockedSince = 0;
    this.lastTickPos = null;
    this.setDirection(direction, this.run);
  }

  /** 当前步作废或走完停住：清掉全部步进与按压状态并通知宿主（恢复待机动作） */
  private finishStepping() {
    const wasMoving = this.isMoving;
    this.stepping = false;
    this.finishing = false;
    this.pressed = false;
    this.run = false;
    this.direction = new Vec2();
    this.pendingDirection = new Vec2();
    this.lastTickPos = null;
    this.blockedSince = 0;
    if (wasMoving) this.onStateChanged();
  }

  /**
   * 结束按住（连续模式的抬起路径，经典模式的收尾步不走这里）：清掉按下状态与方向并通知宿主刷新动作
   * 幂等：世界侧本来就没在按住（这次按压起点在界面上）时什么都不做
   */
  private releasePress() {
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
