import { EventKeyboard, Input, input, Label, Node, Sprite } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import SkillManager from "../../core/SkillManager";
import { SkillId } from "../../../types/skill";

/**
 * 技能快捷键槽组件（自身即一个快捷键格子，作为快捷键栏的 flex item）
 * 图标与按键名样式由 GameUiHelper 生成，本组件只负责图标更新、点击/键盘监听与冷却显示
 * 键盘事件只在全局 input 上派发（节点上监听不到），因此监听全局键盘按下并按按键码过滤
 * 冷却显示由外部每帧驱动 updateCooldown()：冷却中图标置灰并居中显示剩余秒数（最多 2 位小数）
 */
export default class ShortcutKeySlot extends Node {
  /** 快捷键名称 */
  private label: string;
  /** 监听的键盘输入 */
  private listenKey: number;
  /** 图标 */
  private spriteSrc?: string;
  /** 触发回调 */
  private onClick?: Function;
  /** 绑定的技能 id（冷却查询用，未绑定无冷却显示） */
  private skillId?: SkillId;
  /** 冷却倒计时文字（由 GameUiHelper 生成） */
  private cooldownLabel: Label;

  constructor(label: string, listenKey: number, spriteSrc?: string, onClick?: Function, skillId?: SkillId) {
    super(`shortcut_key_${label}`);
    this.label = label;
    this.listenKey = listenKey;
    this.cooldownLabel = GameUiHelper.applyShortcutKeyStyle(this, label).cooldownLabel;
    this.updateIcon(spriteSrc, onClick, skillId);
    // 场景销毁时移除全局键盘监听，避免重进场景后残留
    this.once(Node.EventType.NODE_DESTROYED, () => this.offKeyDown());
  }

  /** 修改图标（同时更新点击回调与绑定技能） */
  public updateIcon(spriteSrc?: string, onClick?: Function, skillId?: SkillId) {
    this.spriteSrc = spriteSrc;
    this.onClick = onClick;
    this.skillId = skillId;
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

  /** 刷新冷却显示（由外部每帧驱动）：冷却中图标置灰并居中显示剩余秒数 */
  public updateCooldown() {
    if (!this.skillId) return;
    const remaining = SkillManager.getCooldownRemaining(this.skillId);
    if (remaining > 0) {
      this.getComponent(Sprite).grayscale = true;
      this.cooldownLabel.node.active = true;
      // 最多保留 2 位小数
      this.cooldownLabel.string = remaining.toFixed(2);
    } else {
      this.getComponent(Sprite).grayscale = false;
      this.cooldownLabel.node.active = false;
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
