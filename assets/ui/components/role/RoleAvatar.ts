import { Color, Label, Node, Size, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import { Role } from "../../../entities/Role";
import { RELATION_SHIP } from "../../../types/role";

/**
 * 角色头像栏组件
 * 由通用零件（背景/头像/货币/战斗力）拼装而成，本组件负责拼装与数据刷新
 */
export default class RoleAvatar extends Node {
  /** 名称文本 */
  private nameLabel: Label;
  /** 等级文本 */
  private levelLabel: Label;
  /** 金币数量文本 */
  private goldCountLabel: Label;
  /** 绑定金币数量文本 */
  private bindGoldCountLabel: Label;
  /** 银币数量文本 */
  private silverCountLabel: Label;
  /** 战斗力文本 */
  private combatLabel: Label;

  constructor(role: Role) {
    super("role_avatar");
    const isSelf = role.relationShip === RELATION_SHIP.SELF;
    this.addComponent(UITransform).setContentSize(300, 70);
    this.setPosition(isSelf ? -648 : 0, isSelf ? 324 : 0);
    // 背景框
    this.addChild(GameUiHelper.createImage("role_info_background", "common/user-info-frame", new Vec2(), new Size(300, 70)));
    // 名称与等级
    this.nameLabel = GameUiHelper.createText("role_name", role.name, 16, new Vec2(17, 24), new Size(190, 24), Color.WHITE, Label.HorizontalAlign.LEFT).getComponent(Label);
    this.addChild(this.nameLabel.node);
    this.levelLabel = GameUiHelper.createText("role_level", role.level.toString(), 16, new Vec2(-138, -17.5), new Size(24, 24)).getComponent(Label);
    this.addChild(this.levelLabel.node);
    // 头像
    this.addChild(GameUiHelper.createAvatarPortrait(role, new Vec2(-109.5, 7.5)));
    // 货币区（createCurrencyItem 为通用零件，其他界面可直接复用）
    const gold = GameUiHelper.createCurrencyItem("money/gold", role.gold, new Vec2(-68, -20));
    this.goldCountLabel = gold.valueLabel;
    this.addChild(gold.node);
    const bindGold = GameUiHelper.createCurrencyItem("money/bind-gold", role.bindGold, new Vec2(-22, -20));
    this.bindGoldCountLabel = bindGold.valueLabel;
    this.addChild(bindGold.node);
    const silver = GameUiHelper.createCurrencyItem("money/silver", role.silver, new Vec2(24, -20));
    this.silverCountLabel = silver.valueLabel;
    this.addChild(silver.node);
    // 战斗力
    const combat = GameUiHelper.createCombatPower(role, new Vec2(-44, 2));
    this.combatLabel = combat.combatLabel;
    this.addChild(combat.node);
    // VIP 按钮
    this.addChild(GameUiHelper.createVipButton(new Vec2(110, 30)));
  }

  /** 数据变更后刷新显示 */
  updateRole(role: Role) {
    this.nameLabel.string = role.name;
    this.levelLabel.string = role.level.toString();
    this.goldCountLabel.string = role.gold.toString();
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.silverCountLabel.string = role.silver.toString();
    this.combatLabel.string = role.combat.toString();
  }
}
