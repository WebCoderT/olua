import { EventMouse, Input, input } from "cc";
import MonsterManager from "../core/MonsterManager";
import RoleDisplay from "./role/RoleDisplay";

/**
 * 屏幕点击处理
 * 负责鼠标点击选中怪物：左键选中，右键选中并攻击
 * 怪物查询统一走 MonsterManager，主角通过构造函数注入
 */
export default class ScreenClick {
  /** 主角（外部注入） */
  private roleDisplay: RoleDisplay;

  constructor(roleDisplay: RoleDisplay) {
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

  /** 根据鼠标按键处理目标选择（点击空地取消选中） */
  private checkClickTarget(event: EventMouse) {
    const clickedNode = MonsterManager.getClickedMonster(event.getUILocation());
    this.roleDisplay.setTarget(clickedNode);
  }
}
