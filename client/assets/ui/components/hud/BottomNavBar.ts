import { Node } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";
import { bottomBarLayout } from "../../../configs/hudLayout";
import BottomNavButton from "./BottomNavButton";

/**
 * 底部栏功能按键区（自身即按键行容器）
 * 布局（间距/位置/尺寸）见 configs/hudLayout.bottomBar.navBar
 * 按配置逐项生成功能按钮，功能是否可用（等级解锁）由各按钮自行判断
 */
export default class BottomNavBar extends Node {
  /** 入口 key → 按钮节点（引导要高亮某个入口时按 key 取，见 GuideOverlay 的 spotProvider） */
  private nodes = new Map<string, BottomNavButton>();

  constructor(buttons: BottomNavBarButton[], role: Role) {
    super("bottom_nav_bar");
    const layout = bottomBarLayout.navBar;
    GameUiHelper.applyRowStyle(this, layout.spacing, layout.position, layout.size);
    buttons.forEach((button) => {
      const node = new BottomNavButton(button, role);
      this.nodes.set(button.key, node);
      this.addChild(node);
    });
  }

  /** 按入口 key 取按钮节点（不存在返回 null —— 引导据此退化为只显示气泡） */
  nodeOf(key: string): Node | null {
    return this.nodes.get(key) ?? null;
  }
}
