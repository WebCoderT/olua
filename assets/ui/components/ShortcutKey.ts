import { EventKeyboard, Input, input, Node } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";

/**
 * 快捷键组件
 * 图标与按键名样式由 GameUiHelper 生成，本组件只负责图标更新与点击/键盘监听
 * 键盘事件只在全局 input 上派发（节点上监听不到），因此监听全局键盘按下并按按键码过滤
 */
export default class ShortcutKey extends Node {
  /** 快捷键名称 */
  private label: string;
  /** 监听的键盘输入 */
  private listenKey: number;
  /** 图标 */
  private spriteSrc?: string;
  /** 触发回调 */
  private onClick?: Function;

  constructor(label: string, listenKey: number, spriteSrc?: string, onClick?: Function) {
    super(`shortcut_key_${label}`);
    this.label = label;
    this.listenKey = listenKey;
    GameUiHelper.applyShortcutKeyStyle(this, label);
    this.updateIcon(spriteSrc, onClick);
    // 场景销毁时移除全局键盘监听，避免重进场景后残留
    this.once(Node.EventType.NODE_DESTROYED, () => this.offKeyDown());
  }

  /** 修改图标（同时更新点击回调） */
  public updateIcon(spriteSrc?: string, onClick?: Function) {
    this.spriteSrc = spriteSrc;
    this.onClick = onClick;
    // 先移除旧的监听，避免重复注册
    this.off(Node.EventType.TOUCH_END);
    this.offKeyDown();
    if (!this.spriteSrc) return;
    GameUiHelper.updateNodeIcon(this, this.spriteSrc);
    if (this.onClick) {
      this.on(Node.EventType.TOUCH_END, this.onClick, this);
      input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    }
  }

  /** 全局键盘按下：命中监听的按键码时触发回调 */
  private onKeyDown(event: EventKeyboard) {
    if (event.keyCode === this.listenKey) this.onClick?.();
  }

  /** 移除全局键盘监听（幂等） */
  private offKeyDown() {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
  }
}
