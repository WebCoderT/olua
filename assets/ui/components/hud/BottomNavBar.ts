import { Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";
import BottomNavButton from "./BottomNavButton";

/** 功能按键区布局（底部栏内固定几何） */
const NAV_SPACING = 6;
const NAV_POSITION = new Vec2(153.5, -10);
const NAV_SIZE = new Size(400, 40);

/**
 * 底部栏功能按键区（自身即按键行容器）
 * 按配置逐项生成功能按钮，功能是否可用（等级解锁）由各按钮自行判断
 */
export default class BottomNavBar extends Node {
  constructor(buttons: BottomNavBarButton[], role: Role) {
    super("bottom_nav_bar");
    GameUiHelper.applyRowStyle(this, NAV_SPACING, NAV_POSITION, NAV_SIZE);
    buttons.forEach((button) => this.addChild(new BottomNavButton(button, role)));
  }
}
