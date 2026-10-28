import { Node, Sprite } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";

/**
 * 底部栏功能按钮（自身即一个功能入口图标，作为功能按键区的 flex item）
 * 样式（图标/快捷键名/未解锁置灰）由 GameUiHelper 零件施加
 * 未解锁时点击只提示所需等级，不触发功能
 */
export default class BottomNavButton extends Node {
  /** 按钮配置（含功能回调与解锁等级） */
  private config: BottomNavBarButton;

  constructor(config: BottomNavBarButton, role: Role) {
    // 节点名用**稳定的 key**，不用图标路径：图标是外观、会换（聊天入口的图标等 #468 接入），
    // 而「聊天」与「好友」当前共用 `friend` 图 —— 按图标命名会让两个节点同名，
    // 按名字找按钮的代码（引导、验收脚本、自动化点击）会命中错的那一个（#486）
    super(`bottom_nav_${config.key}`);
    this.config = config;
    GameUiHelper.applyBottomNavBarButtonStyle(this, config, role);
    this.on(Node.EventType.TOUCH_END, this.onClick, this);
  }

  /** 点击：未解锁（图标置灰）时提示解锁等级，否则执行功能回调 */
  private onClick() {
    if (this.getComponent(Sprite).grayscale) {
      GameUiHelper.createErrorTip("feature_locked_tip", { feature: this.config.label, level: this.config.openLevel });
      return;
    }
    this.config.onClick();
  }
}
