import { Node, UITransform, Vec2 } from "cc";
import { roleInfoBarLayout } from "../../../configs/hudLayout";
import { StatusBadge } from "../../../types/status";
import HoverTipManager from "../../core/HoverTipManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { clearChildren } from "../../utils/node/NodeTree";
import { trackUiPress } from "../../utils/input/Pointer";

/**
 * 状态图标条（角色信息栏头像下方）
 * 展示当前进行中的状态图标（横向布局，图标与顺序来自 StatusManager 的徽标列表）：
 * 重建式刷新（每次全量重建图标），数量少（几个到十几个）开销可忽略
 * 位置/尺寸/图标尺寸见 configs/hudLayout 的 roleInfoBarLayout.statusBar
 * 鼠标悬停图标弹出状态详情（HoverTipManager），图标重建时旧详情随图标销毁自动收起
 */
export default class StatusIconBar extends Node {
  /** 图标排列容器（横向 Layout） */
  private row: Node;

  constructor() {
    super("status_icon_bar");
    const layout = roleInfoBarLayout.statusBar;
    this.addComponent(UITransform).setContentSize(layout.size);
    this.setPosition(layout.position.x, layout.position.y, 0);
    // 行容器取单图标尺寸：横向 Layout 从容器左边界起排，首个图标中心正好落在容器原点（头像正下方），后续图标向右排开
    this.row = GameUiHelper.createRow("status_icons", layout.spacing, new Vec2(), layout.iconSize);
    this.addChild(this.row);
  }

  /** 状态增删后全量重建图标（StatusManager 经 RoleUIManager 调用），并给每个图标绑定悬停详情 */
  updateStatuses(badges: StatusBadge[]) {
    clearChildren(this.row);
    badges.forEach((badge) => {
      const icon = GameUiHelper.createStatusIcon(badge);
      // MOUSE_ENTER/MOUSE_LEAVE 是 DOM 式 enter/leave 语义：移入图标即显示，移出或图标被销毁即收起
      icon.on(Node.EventType.MOUSE_ENTER, () => HoverTipManager.showStatus(badge, icon), this);
      icon.on(Node.EventType.MOUSE_LEAVE, () => HoverTipManager.hide(), this);
      icon.once(Node.EventType.NODE_DESTROYED, () => HoverTipManager.hide(), this);
      // 图标只注册了悬停事件，而它这条链上（状态条 → 角色信息栏）没有别的「按压起点记录点」，
      // 所以这里自己登记一次：按下图标时把起点记下来，抬起判定才不会拿到上一次按压的旧起点
      // （见 utils/input/Pointer.trackUiPress）
      trackUiPress(icon);
      this.row.addChild(icon);
    });
  }
}
