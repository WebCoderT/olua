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
  constructor(buttons: BottomNavBarButton[], role: Role) {
    super("bottom_nav_bar");
    const layout = bottomBarLayout.navBar;
    GameUiHelper.applyRowStyle(this, layout.spacing, layout.position, layout.size);
    buttons.forEach((button) => this.addChild(new BottomNavButton(button, role)));
  }
}
