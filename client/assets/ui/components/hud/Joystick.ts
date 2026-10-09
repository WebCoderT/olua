import { Node } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 操作摇杆（左下角常驻 HUD）
 *
 * 自身只负责组装零件（底座底图 + 可拖动手柄）与贴边定位，不含任何「手感」逻辑：
 * 拖动判定、手柄位移与走/跑解释都在 components/input/RoleJoystickInput，由组合根（ui/Game）
 * 把底座与手柄两个节点交给主角组件 —— 摇杆是**屏幕常驻 HUD**、坐标以屏幕中心为原点且随窗口尺寸贴边，
 * 不属于角色子树，所以不能像键盘/鼠标操控那样在主角组件里自建（那两个输入的宿主就是角色节点）。
 *
 * 尺寸/边距见 configs/hudLayout.joystickLayout，图片来源见 uiImages（joystickBackground / joystickHandle）。
 */
export default class Joystick extends Node {
  /** 手柄节点（拖动时由输入层摆位；初始停在底座正中间） */
  private handle: Node;

  constructor() {
    super("joystick");
    // 零件与初始位置由 GameUiHelper 施加（底座尺寸即触摸命中的范围）
    this.handle = GameUiHelper.applyJoystickBodyStyle(this);
  }

  /** 摇杆主体节点（触摸命中的范围，交给输入层当宿主） */
  get stickNode(): Node {
    return this;
  }

  /** 手柄节点（交给输入层摆位） */
  get handleNode(): Node {
    return this.handle;
  }

  /** 贴边定位（贴屏幕左下角按可见尺寸重算）——窗口尺寸变化时由组合根调用 */
  applyAnchorPosition() {
    GameUiHelper.setJoystickPosition(this);
  }
}
