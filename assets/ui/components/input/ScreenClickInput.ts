import { EventMouse, Input, input } from "cc";
import DropManager from "../../core/DropManager";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import { getHitScreenPoint } from "../../utils/input/Pointer";
import RoleDisplay from "../role/RoleDisplay";

/**
 * 屏幕点击输入
 * 负责鼠标点击：优先拾取掉落物，其次选中怪物
 * 怪物/掉落物查询分别走 MonsterManager、DropManager，主角通过构造函数注入
 *
 * 点击落在 UI 层元素上时整条链路直接跳过（见 LayerManager.isPointOnUi）：
 * 界面操作（开背包/换装备/点挂机…）不该影响世界本身——
 * 不会清掉当前选中目标、不会打断自动战斗、也不会误拾取界面背后的掉落物
 *
 * 拖动走路（按下即走、抬起即停）不在这里：那是 components/input/RolePointerInput 的职责，
 * 两边共用同一套命中判定口径（getHitScreenPoint + isPointOnUi + getClickedMonster）
 */
export default class ScreenClickInput {
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
    // 右键属于界面操作（背包穿戴、脱下装备等），不参与世界点击
    if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
    // 命中检测统一用屏幕坐标（见 utils/input/Pointer.getHitScreenPoint）
    const screenPoint = getHitScreenPoint(event);
    // 点在 UI 元素上：交给界面自己处理，世界侧不做任何反应
    // （不加这一层的话，点界面会走到下面的 setTarget(null) 把当前攻击目标清掉，角色就停手了）
    if (LayerManager.isPointOnUi(screenPoint)) return;
    // 命中掉落物则直接拾取，不改变当前选中目标
    const clickedDrop = DropManager.getClickedDrop(screenPoint);
    if (clickedDrop) {
      DropManager.pickup(clickedDrop);
      return;
    }
    const clickedNode = MonsterManager.getClickedMonster(screenPoint);
    this.roleDisplay.setTarget(clickedNode);
  }
}
