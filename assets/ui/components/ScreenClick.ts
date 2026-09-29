import { EventMouse, Input, input } from "cc";
import Monsters from "./map/Monsters";
import RoleDisplay from "./role/RoleDisplay";

/**
 * 屏幕点击处理
 * 负责鼠标点击选中怪物：左键选中，右键选中并攻击
 * 依赖通过构造函数注入
 */
export default class ScreenClick {
  /** 怪物容器（外部注入） */
  private monsters: Monsters;
  /** 主角（外部注入） */
  private roleDisplay: RoleDisplay;

  constructor(monsters: Monsters, roleDisplay: RoleDisplay) {
    this.monsters = monsters;
    this.roleDisplay = roleDisplay;
  }

  /** 初始化屏幕点击 */
  init() {
    input.on(Input.EventType.MOUSE_UP, this.checkClickTarget, this);
  }

  /** 销毁（场景卸载时由 Game 调用），移除全局监听避免重进场景后残留 */
  destroy() {
    input.off(Input.EventType.MOUSE_UP, this.checkClickTarget, this);
  }

  /** 根据鼠标按键处理目标选择 */
  private checkClickTarget(event: EventMouse) {
    const clickedNode = this.monsters.getClickedMonster(event.getUILocation());
    if (clickedNode) {
      if (event.getButton() === EventMouse.BUTTON_RIGHT) {
        /** 右键点击直接攻击 */
        this.roleDisplay.setTarget(clickedNode, true);
      }
      if (event.getButton() === EventMouse.BUTTON_LEFT) {
        /** 左键点击仅显示目标信息 */
        this.roleDisplay.setTarget(clickedNode);
      }
    }
  }
}
