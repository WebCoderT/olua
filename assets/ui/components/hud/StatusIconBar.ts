import { Node, UITransform, Vec2 } from "cc";
import { roleInfoBarLayout } from "../../../configs/hudLayout";
import { StatusBadge } from "../../../types/status";
import GameUiHelper from "../../helpers/GameUiHelper";
import { clearChildren } from "../../utils/node/NodeTree";

/**
 * 状态图标条（角色信息栏头像下方）
 * 展示当前进行中的状态图标（横向布局，图标与顺序来自 StatusManager 的徽标列表）：
 * 重建式刷新（每次全量重建图标），数量少（几个到十几个）开销可忽略
 * 位置/尺寸/图标尺寸见 configs/hudLayout 的 roleInfoBarLayout.statusBar
 */
export default class StatusIconBar extends Node {
  /** 图标排列容器（横向 Layout） */
  private row: Node;

  constructor() {
    super("status_icon_bar");
    const layout = roleInfoBarLayout.statusBar;
    this.addComponent(UITransform).setContentSize(layout.size);
    this.setPosition(layout.position.x, layout.position.y, 0);
    this.row = GameUiHelper.createRow("status_icons", layout.spacing, new Vec2(), layout.size);
    this.addChild(this.row);
  }

  /** 状态增删后全量重建图标（StatusManager 经 RoleUIManager 调用） */
  updateStatuses(badges: StatusBadge[]) {
    clearChildren(this.row);
    badges.forEach((badge) => this.row.addChild(GameUiHelper.createStatusIcon(badge)));
  }
}
