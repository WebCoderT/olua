import { Color, isValid, Label, Node, ScrollView, Size, Sprite, Vec2 } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";
import UiHelper from "../helpers/UiHelper";
import LayerManager from "../utils/LayerManager";
import StorageManager from "../utils/StorageManager";
import { oeccupationSkills } from "../../configs/game";
import { skills } from "../../configs/skill";
import { Role } from "../../configs/role";
import { SkillId } from "../../types/common";

const SkillDialog = {
  /** 弹窗名称 */
  name: "skill_dialog",
  /** 弹窗默认位置 */
  position: new Vec2(),
  /** 弹窗标题 */
  title: "技能",
  /** 弹窗尺寸 */
  size: new Size(280, 400),
  /** 创建技能弹窗 */
  createDialog() {
    const skillDialog = GameUiHelper.createDialog(SkillDialog.name, SkillDialog.title, SkillDialog.position, SkillDialog.size);
    SkillDialog.createSkillList(skillDialog);
    LayerManager.addToUILayer(skillDialog);
  },

  /** 创建技能列表 */
  createSkillList(parent: Node) {
    const skillList = UiHelper.createScrollView("skill_list", new Vec2(0, -15), new Size(260, 350));
    SkillDialog.createSkill(skillList.getComponent(ScrollView).content);
    parent.addChild(skillList);
  },

  /** 创建技能显示 */
  createSkill(parent: Node) {
    const role = StorageManager.findOnlineRole();
    const skillIds = oeccupationSkills.get(role.occupation);
    skillIds.map((skillId) => {
      const skillConfig = skills.get(skillId);
      const node = UiHelper.createFlexRow(skillId, 5, new Vec2(), new Size(250, 50));
      const skillIcon = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2(), new Size(40, 40));
      if (!role.skills[skillId]) skillIcon.getComponent(Sprite).grayscale = true;
      /** 已学习技能打开快捷配置弹窗 */
      if (role.skills[skillId]) skillIcon.on(Node.EventType.TOUCH_END, () => SkillDialog.openSetShortcutKey(role, skillId), this);
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
      const skilldesc = UiHelper.createLabel("skill_label", skillConfig.description, Color.WHITE, 10, new Vec2(), new Size(205, 15));
      skilldesc.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
      description.addChild(skilldesc);
      node.addChild(description);
      parent.addChild(node);
    });
  },

  /** 快捷配置弹窗 */
  shortcutKeyDialog: null as Node,

  /** 如果是已学习技能，点击图标打开快捷配置 */
  openSetShortcutKey(role: Role, skillId: SkillId) {
    if (SkillDialog.shortcutKeyDialog && isValid(SkillDialog.shortcutKeyDialog)) {
      SkillDialog.shortcutKeyDialog.destroy();
      SkillDialog.shortcutKeyDialog = null;
    }
    SkillDialog.shortcutKeyDialog = GameUiHelper.createDialog("shortcut_key_dialog", "设置快捷键", new Vec2(), new Size(300, 200));
    const content = UiHelper.createFlexRow("skill_dialog_content", 10, new Vec2(), new Size(230, 50));
    role.shortcutKeys.forEach((shortcutkey, index) => {
      const button = GameUiHelper.createSmallButtion(shortcutkey.key.toString(), shortcutkey.label, new Vec2());
      content.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => StorageManager.changeShorcutKey(index, skillId));
    });
    SkillDialog.shortcutKeyDialog.addChild(content);
    LayerManager.addToUILayer(SkillDialog.shortcutKeyDialog);
  },
};

export default SkillDialog;
