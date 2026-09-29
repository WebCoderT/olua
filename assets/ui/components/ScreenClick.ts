import { EventMouse, Input, input } from "cc";
import Monsters from "./Monsters";
import RoleDisplayFrame from "./RoleDisplayFrame";

const ScreenClick = {
  /** 初始化屏幕点击 */
  init() {
    input.on(Input.EventType.MOUSE_UP, ScreenClick.checkClickTarget, this);
  },
  /** 根据鼠标按键处理目标选择 */
  checkClickTarget(event: EventMouse) {
    const clickedNode = Monsters.checkWhichMonterBeClicked(event.getUILocation());
    if (clickedNode) {
      if (event.getButton() === EventMouse.BUTTON_RIGHT) {
        /** 右键点击直接攻击 */
        RoleDisplayFrame.setTarget(clickedNode, true);
      }
      if (event.getButton() === EventMouse.BUTTON_LEFT) {
        /** 左键点击仅显示目标信息 */
        RoleDisplayFrame.setTarget(clickedNode);
      }
    }
  },
};

export default ScreenClick;
