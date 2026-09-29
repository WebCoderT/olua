import { Color, isValid, Label, Node, ScrollView, Size, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/game";
import { skills } from "../../../configs/skill";
import { Role } from "../../../configs/role";
import { SkillId } from "../../../types/common";

/**
 * 技能弹窗
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
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
    this.createSkillList(skillDialog);
    LayerManager.addToUILayer(skillDialog);
  }

  /** 创建技能列表 */
  private createSkillList(parent: Node) {
    const skillList = UiHelper.createScrollView("skill_list", new Vec2(0, -15), new Size(260, 350));
    this.createSkill(skillList.getComponent(ScrollView).content);
    parent.addChild(skillList);
  }

  /** 创建技能显示 */
  private createSkill(parent: Node) {
    const role = StorageManager.findOnlineRole();
    const skillIds = oeccupationSkills.get(role.occupation);
    skillIds.map((skillId) => {
      const skillConfig = skills.get(skillId);
      const node = UiHelper.createFlexRow(skillId, 5, new Vec2(), new Size(250, 50));
      const skillIcon = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2(), new Size(40, 40));
      if (!role.skills[skillId]) skillIcon.getComponent(Sprite).grayscale = true;
      /** 已学习技能打开快捷配置弹窗 */
      if (role.skills[skillId]) skillIcon.on(Node.EventType.TOUCH_END, () => this.openSetShortcutKey(role, skillId), this);
      node.addChild(skillIcon);
      const description = UiHelper.createFlexCol(`${skillId}_desc`, 3, new Vec2(), new Size(205, 40));
      const skillLabel = UiHelper.createLabel(
        "skill_label",
        `${skillConfig.label} (${role.skills[skillId] ? "lv." + role.skills[skillId] : "未学习"})`,
        Color.WHITE,
        12,
        new Vec2(),
        new Size(205, 20),
      );
      skillLabel.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
      description.addChild(skillLabel);
      const skillDesc = UiHelper.createLabel("skill_label", skillConfig.description, Color.WHITE, 10, new Vec2(), new Size(205, 15));
      skillDesc.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
      description.addChild(skillDesc);
      node.addChild(description);
      parent.addChild(node);
    });
  }

  /** 快捷配置弹窗：如果是已学习技能，点击图标打开快捷配置 */
  private openSetShortcutKey(role: Role, skillId: SkillId) {
    if (this.shortcutKeyDialog && isValid(this.shortcutKeyDialog)) {
      this.shortcutKeyDialog.destroy();
      this.shortcutKeyDialog = null;
    }
    this.shortcutKeyDialog = GameUiHelper.createDialog("shortcut_key_dialog", "设置快捷键", new Vec2(), new Size(300, 200));
    const content = UiHelper.createFlexRow("skill_dialog_content", 10, new Vec2(), new Size(230, 50));
    role.shortcutKeys.forEach((shortcutKey, index) => {
      const button = GameUiHelper.createSmallButtion(shortcutKey.key.toString(), shortcutKey.label, new Vec2());
      content.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => StorageManager.changeShortcutKey(index, skillId));
    });
    this.shortcutKeyDialog.addChild(content);
    LayerManager.addToUILayer(this.shortcutKeyDialog);
  }
}
