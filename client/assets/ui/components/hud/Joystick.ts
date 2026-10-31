import { Node, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import { joystickLayout, uiImages } from "../../../configs/hudLayout";

/**
 * 操作摇杆（左下角常驻 HUD）
 *
 * 自身只负责组装零件（底座底图 + 可拖动手柄）与定位，不含任何「手感」逻辑：
 * 拖动判定、手柄位移与走/跑解释都在 components/input/RoleJoystickInput，由组合根（ui/Game）
 * 把底座与手柄两个节点交给主角组件 —— 摇杆是**屏幕常驻 HUD**、坐标以屏幕中心为原点且贴屏幕左下角，
 * 不属于角色子树，所以不能像键盘/鼠标操控那样在主角组件里自建（那两个输入的宿主就是角色节点）。
 *
 * 尺寸/位置/手柄尺寸见 configs/hudLayout.joystickLayout（固定值，构造时一次设好），图片来源见 uiImages。
 */
export default class Joystick extends Node {
  /** 手柄节点（拖动时由输入层摆位；初始停在底座正中间） */
  private handle: Node;

  constructor() {
    super("joystick");
    // 主体与零件自己拼：底座尺寸即触摸命中的范围；位置是配置固定值，构造时一次设好（窗口变化不重排）
    const { size, position, handleSize } = joystickLayout;
    this.addComponent(UITransform).setContentSize(size);
    this.setPosition(position.x, position.y, 0);
    this.addChild(GameUiHelper.createImage("joystick_bg", uiImages.joystickBackground, new Vec2(), size));
    // 手柄初始停在正中间（拖动位移由输入层写入；锚点在自身中心，位移即相对底座中心）
    this.handle = GameUiHelper.createImage("joystick_handle", uiImages.joystickHandle, new Vec2(), handleSize);
  }

  /** 摇杆主体节点（触摸命中的范围，交给输入层当宿主） */
  get stickNode(): Node {
    return this;
  }

  /** 手柄节点（交给输入层摆位） */
  get handleNode(): Node {
    return this.handle;
  }
}
