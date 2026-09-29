import { isValid, Node, ScrollView, Vec2, Size } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";

/**
 * 技能弹窗
 * 弹窗由通用零件（弹窗框/滚动区/技能行/小按钮）拼装，本类负责开关与技能数据读取
 */
export default class SkillDialog {
  /** 弹窗名称 */
  private name = "skill_dialog";
  /** 弹窗默认位置 */
  private position = new Vec2();
  /** 弹窗标题 */
  private title = "技能";
  /** 弹窗尺寸 */
  private size = new Size(280, 400);
  /** 快捷键配置弹窗 */
  private shortcutKeyDialog: Node | null = null;

  /** 打开技能弹窗 */
  open() {
    const skillDialog = GameUiHelper.createDialog(this.name, this.title, this.position, this.size);
    const skillList = GameUiHelper.createSkillListView();
    const role = StorageManager.findOnlineRole();
    const content = skillList.getComponent(ScrollView).content;
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      content.addChild(GameUiHelper.createSkillItem(role, skillId, () => this.openSetShortcutKey(role, skillId)));
    });
    skillDialog.addChild(skillList);
    LayerManager.addToUILayer(skillDialog);
  }

  /** 快捷配置弹窗：如果是已学习技能，点击图标打开快捷配置 */
  private openSetShortcutKey(role: Role, skillId: SkillId) {
    if (this.shortcutKeyDialog && isValid(this.shortcutKeyDialog)) {
      this.shortcutKeyDialog.destroy();
      this.shortcutKeyDialog = null;
    }
    // 快捷键弹窗由通用零件拼装
    const dialog = GameUiHelper.createDialog("shortcut_key_dialog", "设置快捷键", new Vec2(), new Size(300, 200));
    const content = GameUiHelper.createRow("skill_dialog_content", 10, new Vec2(), new Size(230, 50));
    role.shortcutKeys.forEach((shortcutKey, index) => {
      const button = GameUiHelper.createSmallButtion(shortcutKey.key.toString(), shortcutKey.label, new Vec2());
      content.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => StorageManager.changeShortcutKey(index, skillId));
    });
    dialog.addChild(content);
    this.shortcutKeyDialog = dialog;
    LayerManager.addToUILayer(this.shortcutKeyDialog);
  }
}
