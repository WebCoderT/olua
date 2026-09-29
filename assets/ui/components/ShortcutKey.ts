import { Node } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";

/**
 * 快捷键组件
 * 图标与按键名样式由 GameUiHelper 生成，本组件只负责图标更新与点击监听
 */
export default class ShortcutKey extends Node {
  /** 快捷键名称 */
  private label: string;
  /** 监听的键盘输入 */
  private listenKey: number;
  /** 图标 */
  private spriteSrc?: string;

  constructor(label: string, listenKey: number, spriteSrc?: string, onClick?: Function) {
    super(`shortcut_key_${label}`);
    this.label = label;
    this.listenKey = listenKey;
    GameUiHelper.applyShortcutKeyStyle(this, label);
    this.updateIcon(spriteSrc, onClick);
  }

  /** 修改图标（同时更新点击回调） */
  public updateIcon(spriteSrc?: string, onClick?: Function) {
    this.spriteSrc = spriteSrc;
    // 先移除旧的点击监听，避免重复注册
    this.off(Node.EventType.TOUCH_END);
    if (this.spriteSrc) {
      GameUiHelper.updateNodeIcon(this, this.spriteSrc);
      this.on(Node.EventType.TOUCH_END, onClick, this);
    }
  }
}
