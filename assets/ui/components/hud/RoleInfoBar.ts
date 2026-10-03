import { Color, Label, Node, Size, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import RoleUIManager from "../../core/RoleUIManager";
import StatusIconBar from "./StatusIconBar";
import { Role } from "../../../entities/Role";
import { RELATION_SHIP } from "../../../types/role";
import { hudImages, roleInfoBarLayout } from "../../../configs/hudLayout";
import { getAnchoredPosition, getVisibleSize } from "../../utils/layout/ScreenLayout";

/** 货币种数（金币 / 绑定金币 / 银币），用于把货币容器宽度等分给每件 */
const CURRENCY_COUNT = 3;

/**
 * 角色信息栏组件（左上角常驻 HUD）
 * 展示：背景框 + 头像 + 名称 + 等级 + 金币/绑定金币/银币（横向布局容器）+ 战斗力
 * 由通用零件（背景/头像/货币/战斗力）拼装而成，本组件负责拼装与数据刷新
 * 位置与尺寸全部来自 configs/hudLayout（各子件坐标以信息栏中心为原点）：
 * 自己的位置按「贴屏幕左上角 + 边距」用当前可见尺寸实时算出（窗口尺寸变化时由组合根调用 applyAnchorPosition 重排）
 */
export default class RoleInfoBar extends Node {
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
  /** 是否为本人信息栏（本人贴左上角，其他玩家固定在屏幕中心） */
  private isSelf: boolean;

  constructor(role: Role) {
    super("role_info_bar");
    const layout = roleInfoBarLayout;
    const isSelf = role.relationShip === RELATION_SHIP.SELF;
    this.isSelf = isSelf;
    this.addComponent(UITransform).setContentSize(layout.size);
    this.applyAnchorPosition();
    // 背景框
    this.addChild(GameUiHelper.createImage("role_info_background", hudImages.roleInfoBackground, new Vec2(), layout.backgroundSize));
    // 名称与等级
    this.nameLabel = GameUiHelper.createText("role_name", role.name, layout.name.fontSize, layout.name.position, layout.name.size, Color.WHITE, Label.HorizontalAlign.LEFT).getComponent(Label);
    this.addChild(this.nameLabel.node);
    this.levelLabel = GameUiHelper.createText("role_level", role.level.toString(), layout.level.fontSize, layout.level.position, layout.level.size).getComponent(Label);
    this.addChild(this.levelLabel.node);
    // 头像
    this.addChild(GameUiHelper.createAvatarPortrait(role, layout.portrait.position, layout.portrait.size));
    // 货币区：三种货币放在同一个横向布局容器里，每件占容器宽度的三分之一、内容各自左对齐
    const currencyBar = GameUiHelper.createRow("role_currency_bar", layout.currencyBar.spacing, layout.currencyBar.position, layout.currencyBar.size);
    const itemSize = new Size(layout.currencyBar.size.width / CURRENCY_COUNT, layout.currencyBar.size.height);
    const gold = GameUiHelper.createCurrencyItem(hudImages.gold, role.gold, new Vec2(), itemSize);
    this.goldCountLabel = gold.valueLabel;
    currencyBar.addChild(gold.node);
    const bindGold = GameUiHelper.createCurrencyItem(hudImages.bindGold, role.bindGold, new Vec2(), itemSize);
    this.bindGoldCountLabel = bindGold.valueLabel;
    currencyBar.addChild(bindGold.node);
    const silver = GameUiHelper.createCurrencyItem(hudImages.silver, role.silver, new Vec2(), itemSize);
    this.silverCountLabel = silver.valueLabel;
    currencyBar.addChild(silver.node);
    this.addChild(currencyBar);
    // 战斗力
    const combat = GameUiHelper.createCombatPower(role, layout.combat.position);
    this.combatLabel = combat.combatLabel;
    this.addChild(combat.node);
    // 状态图标条（头像正下方，进行中状态的图标；由 StatusManager 经 RoleUIManager 刷新）
    const statusIconBar = new StatusIconBar();
    this.addChild(statusIconBar);
    RoleUIManager.registerStatusIconBar(statusIconBar);
  }

  /** 贴边定位（本人贴屏幕左上角按可见尺寸重算；其他玩家固定在屏幕中心）——窗口尺寸变化时可重复调用 */
  applyAnchorPosition() {
    const layout = roleInfoBarLayout;
    if (!this.isSelf) {
      this.setPosition(layout.otherPosition.x, layout.otherPosition.y, 0);
      return;
    }
    const { anchor } = layout;
    const position = getAnchoredPosition(layout.size, getVisibleSize(), anchor.edge, anchor.marginX, anchor.marginY);
    this.setPosition(position.x, position.y, 0);
  }

  /** 数据变更后刷新显示 */
  updateRole(role: Role) {    this.nameLabel.string = role.name;
    this.levelLabel.string = role.level.toString();
    this.goldCountLabel.string = role.gold.toString();
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.silverCountLabel.string = role.silver.toString();
    this.combatLabel.string = role.combat.toString();
  }
}
