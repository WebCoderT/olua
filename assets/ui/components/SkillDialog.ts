import { Color, Label, Node, ScrollView, Size, Sprite, Vec2 } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";
import UiHelper from "../helpers/UiHelper";
import LayerManager from "../utils/LayerManager";
import StorageManager from "../utils/StorageManager";
import { oeccupationSkills } from "../../configs/game";
import { skills } from "../../configs/skill";

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
};

export default SkillDialog;
