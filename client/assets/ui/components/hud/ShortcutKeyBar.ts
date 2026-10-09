import { Node } from "cc";
import { Role } from "../../../entities/Role";
import { ShortcutKeys } from "../../../types/role";
import { SkillId } from "../../../types/skill";
import { skills } from "../../../configs/skill";
import { bottomBarLayout } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";
import SkillManager from "../../core/SkillManager";
import ShortcutKeySlot from "./ShortcutKeySlot";

/**
 * 技能快捷键栏组件（自身即快捷键行容器）
 * 布局（间距/位置/尺寸）见 configs/hudLayout.bottomBar.shortcutBar
 * 按角色快捷键配置逐格生成快捷键槽，技能触发统一走 SkillManager（施法上下文由 RoleDisplay 提供）
 */
export default class ShortcutKeyBar extends Node {
  /** 各快捷键槽（按按键码索引，键位数量需与 types/role.ShortcutKeys 一致） */
  private slots: { [key in ShortcutKeys]: ShortcutKeySlot | null } = {
    49: null,
    50: null,
    51: null,
    52: null,
    53: null,
    54: null,
  };

  constructor(role: Role) {
    super("shortcut_key_bar");
    const layout = bottomBarLayout.shortcutBar;
    GameUiHelper.applyRowStyle(this, layout.spacing, layout.position, layout.size);
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
