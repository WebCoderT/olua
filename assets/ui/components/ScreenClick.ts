import { EventMouse, Input, input } from "cc";
import DropManager from "../core/DropManager";
import MonsterManager from "../core/MonsterManager";
import RoleDisplay from "./role/RoleDisplay";

/**
 * 屏幕点击处理
 * 负责鼠标点击：优先拾取掉落物，其次选中怪物
 * 怪物/掉落物查询分别走 MonsterManager、DropManager，主角通过构造函数注入
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

  /** 根据鼠标按键处理目标选择（优先拾取掉落物；点击空地取消选中） */
  private checkClickTarget(event: EventMouse) {
    const uiLocation = event.getUILocation();
    // 命中掉落物则直接拾取，不改变当前选中目标
    const clickedDrop = DropManager.getClickedDrop(uiLocation);
    if (clickedDrop) {
      DropManager.pickup(clickedDrop);
      return;
    }
    const clickedNode = MonsterManager.getClickedMonster(uiLocation);
    this.roleDisplay.setTarget(clickedNode);
  }
}
