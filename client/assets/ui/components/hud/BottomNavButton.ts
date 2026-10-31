import { EventKeyboard, Input, input, KeyCode, Node, Sprite } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";

/**
 * 快捷键名 → 键码（configs/bottomNav.shortcutKey 的显示名就是真实按键）：
 * 字母键与 ASCII 对齐（KeyCode.KEY_A = 65），特殊键显式列出；未知名字返回 null（不监听）
 */
function navKeyCode(name: string): number | null {
  if (name === "Enter") return KeyCode.ENTER;
  if (/^[A-Z]$/.test(name)) return name.charCodeAt(0);
  return null;
}

/**
 * 底部栏功能按钮（自身即一个功能入口图标，作为功能按键区的 flex item）
 * 样式（图标/快捷键名/未解锁置灰）由 GameUiHelper 零件施加
 * 未解锁时点击只提示所需等级，不触发功能
 *
 * 快捷键：按配置的 shortcutKey 监听**全局键盘按下**（键盘事件只在全局 input 上派发，
 * 节点上收不到，与 ShortcutKeySlot 同一套做法），命中即走与点击同一条路径
 * （未解锁置灰 → 提示等级；未做 → 「开发中」飘字）—— 键盘与鼠标不会出现两套行为。
 * 场景销毁时移除全局监听，避免重进场景后残留。
 */
export default class BottomNavButton extends Node {
  /** 按钮配置（含功能回调与解锁等级） */
  private config: BottomNavBarButton;

  constructor(config: BottomNavBarButton, role: Role) {
    // 节点名用**稳定的 key**，不用图标路径：图标是外观、会换 —— 按名字找按钮的代码
    // （引导、验收脚本、自动化点击）会命中错的那一个（#486）
    super(`bottom_nav_${config.key}`);
    this.config = config;
    GameUiHelper.applyBottomNavBarButtonStyle(this, config, role);
    this.on(Node.EventType.TOUCH_END, this.onClick, this);
    const keyCode = navKeyCode(config.shortcutKey);
    if (keyCode !== null) {
      input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
      this.once(Node.EventType.NODE_DESTROYED, () => input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this));
    }
  }

  /** 全局键盘按下：命中本入口的快捷键时走与点击同一条路 */
  private onKeyDown(event: EventKeyboard) {
    if (event.keyCode === navKeyCode(this.config.shortcutKey)) this.onClick();
  }

  /** 点击 / 快捷键共用：未解锁（图标置灰）时提示解锁等级，否则执行功能回调 */
  private onClick() {
    if (this.getComponent(Sprite).grayscale) {
      GameUiHelper.createErrorTip("feature_locked_tip", { feature: this.config.label, level: this.config.openLevel });
      return;
    }
    this.config.onClick();
  }
}
