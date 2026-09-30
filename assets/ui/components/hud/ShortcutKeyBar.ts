import { Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { ShortcutKeys } from "../../../types/role";
import { SkillId } from "../../../types/skill";
import { skills } from "../../../configs/skill";
import GameUiHelper from "../../helpers/GameUiHelper";
import SkillManager from "../../core/SkillManager";
import ShortcutKeySlot from "./ShortcutKeySlot";

/** 快捷键栏布局（底部栏内固定几何） */
const SHORTCUT_SPACING = 6;
const SHORTCUT_POSITION = new Vec2(-270, -9);
const SHORTCUT_SIZE = new Size(178, 40);

/**
 * 技能快捷键栏组件（自身即快捷键行容器）
 * 按角色快捷键配置逐格生成快捷键槽，技能触发统一走 SkillManager（施法上下文由 RoleDisplay 提供）
 */
export default class ShortcutKeyBar extends Node {
  /** 各快捷键槽（按按键码索引） */
  private slots: { [key in ShortcutKeys]: ShortcutKeySlot | null } = {
    49: null,
    50: null,
    51: null,
    52: null,
  };

  constructor(role: Role) {
    super("shortcut_key_bar");
    GameUiHelper.applyRowStyle(this, SHORTCUT_SPACING, SHORTCUT_POSITION, SHORTCUT_SIZE);
    role.shortcutKeys.forEach((config) => {
      const skill = skills.get(config.skillId as SkillId);
      const slot = new ShortcutKeySlot(
        config.label,
        config.key,
        skill?.icon,
        config.skillId ? () => SkillManager.release(config.skillId as SkillId) : undefined,
        config.skillId as SkillId | undefined,
      );
      this.slots[config.key] = slot;
      this.addChild(slot);
    });
  }

  /** 每帧刷新各快捷键槽冷却显示（由组合根驱动） */
  updateCooldowns() {
    for (const key in this.slots) {
      this.slots[key]?.updateCooldown();
    }
  }

  /** 更新指定快捷键槽的图标、回调与绑定技能 */
  updateSlotIcon(key: ShortcutKeys, icon?: string, onClick?: Function, skillId?: SkillId) {
    this.slots[key]?.updateIcon(icon, onClick, skillId);
  }
}
