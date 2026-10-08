import { EventMouse, Input, input } from "cc";
import { basicAttackSkillId } from "../../../configs/skill";
import DropManager from "../../core/DropManager";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import SkillManager from "../../core/SkillManager";
import { getHitScreenPoint, isUiPressOnUiElement } from "../../utils/input/Pointer";
import RoleDisplay from "../role/RoleDisplay";

/**
 * 屏幕点击输入
 * 负责鼠标点击怪物：**左键直接攻击、右键只选中**（右键 = 原来左键的行为）；
 * 两者都会更新选中状态（点空地 = 取消选中），只有左键会拾取掉落物
 * 怪物/掉落物查询分别走 MonsterManager、DropManager，主角通过构造函数注入
 *
 * 点击落在 UI 层元素上时整条链路直接跳过（见 LayerManager.isPointOnUi）：
 * 界面操作（开背包/换装备/点挂机…）不该影响世界本身——
 * 不会清掉当前选中目标、不会打断自动战斗、也不会误拾取界面背后的掉落物
 * （界面自己的右键语义——背包穿戴/脱下装备——因此不会被世界侧抢走）
 *
 * 另外，**按压起点**落在界面元素上的那次抬起也跳过（见 utils/input/Pointer.isUiPressOnUiElement）：
 * 拖动可能早已离开界面（典型是左下角摇杆：在摇杆上按住、把指针拖到世界才松手），
 * 只看「抬起点是否在 UI 上」会把这种拖动的结束误判成一次世界点击
 *
 * 点击落在 NPC 这类「世界侧可交互对象」上时也跳过（见 LayerManager.isPointOnWorldInteractive）：
 * 那是它自己的交互（点开对话/传送），点它同样不该清掉当前选中目标、打断挂机
 *
 * 拖动走路（按下即走、抬起即停）不在这里：那是 components/input/RolePointerInput 的职责，
 * 两边共用同一套命中判定口径（getHitScreenPoint + isPointOnUi + isPointOnWorldInteractive + getClickedMonster）；
 * 按在这两类目标上时 RolePointerInput 不接管（既不走路也不跑），正好留给这里的攻击/选中
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

  /** 根据鼠标按键处理：左键点怪 = 攻击，右键点怪 = 只选中；点空地 = 取消选中 */
  private checkClickTarget(event: EventMouse) {
    const button = event.getButton();
    // 只认左右键：左键 = 攻击/拾取，右键 = 只选中（中键等忽略）
    const isAttack = button === EventMouse.BUTTON_LEFT;
    if (!isAttack && button !== EventMouse.BUTTON_RIGHT) return;
    // 命中检测统一用屏幕坐标（见 utils/input/Pointer.getHitScreenPoint）
    const screenPoint = getHitScreenPoint(event);
    // 点在 UI 元素上：交给界面自己处理，世界侧不做任何反应
    // （不加这一层的话，点界面会走到下面的 setTarget 把当前攻击目标清掉，角色就停手了）
    if (LayerManager.isPointOnUi(screenPoint)) return;
    // 本次按压的起点也在界面元素上：这次抬起同样不属于世界侧，无论松手落在哪
    // （典型是左下角摇杆：在摇杆上按住拖动、拖到世界区域才松手，松手点已不在 UI 上，
    //   只看上面那条会把拖动结束误判成一次世界点击 —— 清掉选中目标、打断挂机）
    if (isUiPressOnUiElement()) return;
    // 拾取只认左键（右键是"只选中"，不参与世界操作）；拾取不改变当前选中目标
    if (isAttack) {
      const clickedDrop = DropManager.getClickedDrop(screenPoint);
      if (clickedDrop) {
        DropManager.pickup(clickedDrop);
        return;
      }
    }
    // 点在世界侧可交互对象（NPC）上：那是它自己的交互（节点上的 TOUCH_END 负责点开对话/传送），
    // 世界侧既不选中也不取消选中——点 NPC 不该把当前攻击目标清掉、更不该打断挂机
    if (LayerManager.isPointOnWorldInteractive(screenPoint)) return;
    const clickedNode = MonsterManager.getClickedMonster(screenPoint);
    // 选中/取消选中：左右键都更新（点空地取消选中）
    this.roleDisplay.setTarget(clickedNode);
    // 左键点怪直接开打：走技能统一入口（冷却/魔法值/距离校验 + 特效 + 伤害结算都在里面），
    // 目标超出距离时由 canAuto 的普攻技能委托 AutoBattle 走过去继续打，冷却期内的连点静默失败
    if (isAttack && clickedNode) SkillManager.release(basicAttackSkillId);
  }
}
