import { ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import SkillShortcutSettingDialog from "./SkillShortcutSettingDialog";

/** 弹窗名称与标题 */
const DIALOG_NAME = "skill_list_dialog";
const DIALOG_TITLE = "技能";
/** 弹窗尺寸 */
const DIALOG_SIZE = new Size(280, 400);

/**
 * 技能列表弹窗
 * 只负责开关与技能数据读取：技能行（未学习置灰、已学习可点击）由 GameUiHelper 零件生成，
 * 点击技能图标打开快捷键设置弹窗（SkillShortcutSettingDialog）
 */
export default class SkillListDialog {
  /** 快捷键设置弹窗（子弹窗，由本弹窗持有） */
  private shortcutKeySettingDialog = new SkillShortcutSettingDialog();

  /** 打开技能列表弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    const dialog = GameUiHelper.createDialog(DIALOG_NAME, DIALOG_TITLE, new Vec2(), DIALOG_SIZE);
    const skillList = GameUiHelper.createSkillListView();
    const content = skillList.getComponent(ScrollView).content;
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      content.addChild(GameUiHelper.createSkillItem(role, skillId, () => this.shortcutKeySettingDialog.open(role, skillId)));
    });
    dialog.addChild(skillList);
    LayerManager.addToUILayer(dialog);
  }
}
