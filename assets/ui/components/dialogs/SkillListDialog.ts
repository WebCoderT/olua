import { Node, ScrollView, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import HoverTipManager from "../../core/HoverTipManager";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import SkillShortcutSettingDialog from "./SkillShortcutSettingDialog";
import { skillListDialogLayout } from "../../../configs/hudLayout";

/**
 * 技能列表弹窗
 * 只负责开关与技能数据读取：技能行（未学习置灰、已学习可点击）由 GameUiHelper 零件生成，
 * 点击技能图标打开快捷键设置弹窗（SkillShortcutSettingDialog）；
 * 鼠标悬停技能图标弹出技能详情弹窗（HoverTipManager）
 */
export default class SkillListDialog {
  /** 快捷键设置弹窗（子弹窗，由本弹窗持有） */
  private shortcutKeySettingDialog = new SkillShortcutSettingDialog();

  /** 打开技能列表弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    const dialog = GameUiHelper.createDialog(skillListDialogLayout.name, skillListDialogLayout.title, new Vec2(), skillListDialogLayout.size);
    const skillList = GameUiHelper.createSkillListView();
    const content = skillList.getComponent(ScrollView).content;
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      const item = GameUiHelper.createSkillItem(role, skillId, () => this.shortcutKeySettingDialog.open(role, skillId));
      // 鼠标悬停技能图标弹出技能详情（图标是技能行的第一个子节点，节点名 = 技能 id）
      const icon = item.getChildByName(skillId);
      if (icon) {
        icon.on(Node.EventType.MOUSE_ENTER, () => HoverTipManager.showSkill(skillId, icon), this);
        icon.on(Node.EventType.MOUSE_LEAVE, () => HoverTipManager.hide(), this);
        icon.once(Node.EventType.NODE_DESTROYED, () => HoverTipManager.hide(), this);
      }
      content.addChild(item);
    });
    dialog.addChild(skillList);
    LayerManager.addToUILayer(dialog);
  }
}
