import {
  Animation,
  AnimationClip,
  BoxCollider2D,
  Button,
  Color,
  Graphics,
  isValid,
  Label,
  LabelAtlas,
  Layout,
  math,
  Node,
  ProgressBar,
  resources,
  Size,
  Sprite,
  tween,
  UIOpacity,
  UITransform,
  Vec2,
  Vec3,
} from "cc";
import UiHelper from "./UiHelper";
import AnimationHelper from "./AnimationHelper";
import { AnimationPlayer } from "../../scripts/AnimationPlayer";
import { Draggable } from "../components/input/Draggable";
import { debugConfig } from "../../configs/debug";
import { getAnimationName } from "../../configs/animation";
import { bagRow, bagCol } from "../../configs/role";
import { Role } from "../../entities/Role";
import { ACTION, DIRECTION, SpeedRate } from "../../types/animation";
import { BattleAttributes } from "../../types/common";
import { Equipment, EQUIPMENT_TYPE, Goods, isEquipment } from "../../types/good";
import { Monster } from "../../types/monster";
import { NPC } from "../../types/map";
import { OECCUPATION } from "../../types/role";
import { SkillId } from "../../types/skill";
import { StatusBadge } from "../../types/status";
import GameHelper from "../core/GameHelper";
import { markClickThrough } from "../utils/input/UiHit";
import { goodShowAttributes, goodShowAttributesLabel } from "../../configs/good";
import { skills } from "../../configs/skill";
import LayerManager from "../core/LayerManager";
import { clearChildren } from "../utils/node/NodeTree";
import { avatarImage, bottomBarLayout, hudImages, hudSize, monsterInfoPanelLayout, roleInfoBarLayout, smallMapLayout, tipsLayout } from "../../configs/hudLayout";

//#region 类型定义

/** 小地图坐标点（地图内容区本地坐标，调用方负责把世界坐标换算过来） */
export interface SmallMapDot {
  /** 相对内容区中心的横向偏移 */
  x: number;
  /** 相对内容区中心的纵向偏移 */
  y: number;
  /** 点颜色 */
  color: Color;
  /** 点半径 */
  radius: number;
}

/** 底部功能按钮配置 */
export interface BottomNavBarButton {
  /** 功能名称（未解锁时用于提示文案） */
  label: string;
  /** 图标资源 */
  icon: string;
  /** 解锁等级（角色等级低于该值时置灰并提示） */
  openLevel: number;
  /** 点击回调 */
  onClick: () => void;
  /** 显示在图标上的快捷键名（仅展示用） */
  shortcutKey: string;
}

/** 碰撞范围显示类别（决定配色：静态障碍 / 角色自身） */
export type ColliderRangeKind = "obstacle" | "role";

//#endregion

//#region 碰撞范围显示常量（调试用）

/** 碰撞范围框线宽（像素） */
const COLLIDER_RANGE_LINE_WIDTH = 3;
/** 碰撞范围填充透明度（低透明度，避免遮挡地图与角色） */
const COLLIDER_RANGE_FILL_ALPHA = 40;
/** 碰撞范围名称字号 */
const COLLIDER_RANGE_NAME_FONT_SIZE = 14;
/** 碰撞范围名称文本宽度（窄区域下允许超出，保证名称完整可读） */
const COLLIDER_RANGE_NAME_WIDTH = 260;
/** 碰撞范围名称文本高度 */
const COLLIDER_RANGE_NAME_HEIGHT = 18;
/** 静态障碍的碰撞范围颜色（Tiled 碰撞区 / NPC / 怪物） */
const COLLIDER_RANGE_OBSTACLE_COLOR = new Color(255, 64, 64);
/** 角色自身的碰撞范围颜色（与静态障碍区分，便于混杂场景下分辨） */
const COLLIDER_RANGE_ROLE_COLOR = new Color(64, 255, 128);
/** 怪物刷怪区域的颜色（无碰撞体，用另一种配色与碰撞体区分） */
const COLLIDER_RANGE_AREA_COLOR = new Color(255, 208, 64);

//#endregion

//#region 装备详情显示常量

/** 装备详情中标签行的尺寸（占名称下方一整行） */
const GOOD_TAG_ROW_SIZE = new Size(220, 18);
/** 装备标签文字颜色（与白色正文区分，突出标签） */
const GOOD_TAG_COLOR = new Color(255, 214, 102);
/** 装备标签字号 */
const GOOD_TAG_FONT_SIZE = 11;
/** 装备标签之间的横向间距 */
const GOOD_TAG_SPACING = 6;
/** 单条标签的最小宽度 */
const GOOD_TAG_MIN_WIDTH = 24;
/** 单条标签的左右留白 */
const GOOD_TAG_PADDING_X = 8;

//#endregion

/**
 * 游戏UI零件工厂（静态类）
 * 只提供单个可复用的 UI 零件（货币、按钮、插槽、头像、血条、弹窗、物品等），
 * 页面/弹窗的拼接组装由各组件自身完成，本类不做整页视图生成
 */
export default class GameUiHelper {
  //#region 通用元素零件

  /** 创建一张带资源图的节点 */
  static createImage(name: string, src: string, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createSprite(name, src, position, size);
  }

  /** 创建铺满全屏的资源图 */
  static createFullScreenImage(name: string, src: string) {
    return UiHelper.createFullScreenNode(name, src);
  }

  /** 创建文本 */
  static createText(
    name: string,
    text: string,
    fontSize: number,
    position: Vec2 = new Vec2(),
    size: Size = new Size(),
    color: Color = Color.WHITE,
    horizontalAlign: Label["horizontalAlign"] = Label.HorizontalAlign.CENTER,
    verticalAlign: Label["verticalAlign"] = Label.VerticalAlign.CENTER,
  ) {
    return UiHelper.createLabel(name, text, color, fontSize, position, size, horizontalAlign, verticalAlign);
  }

  /** 创建横向排列容器 */
  static createRow(name: string, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createFlexRow(name, spacing, position, size);
  }

  /** 创建纵向排列容器 */
  static createColumn(name: string, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createFlexCol(name, spacing, position, size);
  }

  /**
   * 为已有节点施加"横向排列容器"样式（组件自身即容器时使用，避免多包一层节点）
   * @returns 该节点的 Layout 组件
   */
  static applyRowStyle(node: Node, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.applyFlexRowStyle(node, spacing, position, size);
  }

  /**
   * 为已有节点施加"纵向排列容器"样式（组件自身即容器时使用，避免多包一层节点）
   * @returns 该节点的 Layout 组件
   */
  static applyColumnStyle(node: Node, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.applyFlexColStyle(node, spacing, position, size);
  }

  /** 创建带资源图的按钮（可选文字） */
  static createTexturedButton(name: string, src: string, text: string = "", position: Vec2 = new Vec2(), size: Size = new Size(129, 54), textColor: Color = Color.WHITE, fontSize: number = 20) {
    const button = UiHelper.createButton(name, src, position, size);
    if (text) button.addChild(UiHelper.createLabel(`${name}_label`, text, textColor, fontSize, new Vec2(), size));
    return button;
  }

  /** 创建带图标的输入框组（背景 + 可选图标 + 输入框），返回背景节点与输入框节点 */
  static createInputField(placeholder: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 80), icon?: string, password: boolean = false) {
    const background = UiHelper.createSprite("input_background", "login/input_bg", position, size);
    if (icon) background.addChild(UiHelper.createSprite("input_icon", icon, new Vec2(-size.width / 2 + 60, -6), new Size(40, 40)));
    const input = UiHelper.createInputBox("input", placeholder, new Vec2(0, -6), new Vec2(size.width - 200, 60), password);
    background.addChild(input);
    return { node: background, input };
  }

  /** 创建开关组 */
  static createToggleGroup(name: string, toggles: Node[], spacing: number, position: Vec2 = new Vec2()) {
    return UiHelper.createToggleGroup(name, toggles, spacing, position);
  }

  /**
   * 创建货币显示零件（图标 + 数值，内容在零件内左对齐：图标贴左边缘、数值紧随其右）
   * @param icon 货币图标资源路径
   * @param value 数值
   * @param position 零件中心位置
   * @param size 零件尺寸（父容器等分时传容器宽度/份数）
   */
  static createCurrencyItem(icon: string, value: string | number, position: Vec2 = new Vec2(), size: Size = new Size(43, 12)) {
    const node = UiHelper.createNode("currency_item", position, size);
    const iconWidth = 15;
    const iconGap = 3;
    const left = -size.width / 2;
    node.addChild(UiHelper.createSprite("currency_icon", icon, new Vec2(left + iconWidth / 2, 0), new Size(iconWidth, 10)));
    const valueLabelNode = UiHelper.createLabel(
      "currency_value",
      value.toString(),
      Color.WHITE,
      12,
      new Vec2(left + iconWidth + iconGap, 0),
      new Size(size.width - iconWidth - iconGap, size.height),
      Label.HorizontalAlign.LEFT,
    );
    valueLabelNode.getComponent(UITransform).setAnchorPoint(0, 0.5);
    node.addChild(valueLabelNode);
    return { node, valueLabel: valueLabelNode.getComponent(Label) };
  }

  /**
   * 创建战斗力显示零件（图标 + 数字图集文本，数值紧随图标右边缘）
   * 图标尺寸见 hudLayout.roleInfoBarLayout.combat.iconSize
   * @return node 零件节点、combatLabel 战斗力文本（供刷新）
   */
  static createCombatPower(role: Role, position: Vec2 = new Vec2()) {
    const { iconSize, labelGap } = roleInfoBarLayout.combat;
    const node = UiHelper.createNode("combat_power", position);
    node.addChild(UiHelper.createSprite("combat_icon", hudImages.combatIcon, new Vec2(), iconSize));
    const labelX = iconSize.width / 2 + labelGap;
    const labelNode = UiHelper.createLabel("combat_number", role.combat.toString(), Color.WHITE, 20, new Vec2(labelX, 0), new Size(200, iconSize.height), Label.HorizontalAlign.LEFT);
    labelNode.getComponent(UITransform).setAnchorPoint(0, 0.5);
    const combatLabel = labelNode.getComponent(Label);
    resources.load(hudImages.combatFont, LabelAtlas, (error, atlas) => {
      if (!error && atlas && combatLabel.isValid) combatLabel.font = atlas;
    });
    node.addChild(labelNode);
    return { node, combatLabel };
  }

  /**
   * 创建角色头像（按职业与性别取图，尺寸见 hudLayout.roleInfoBar.portrait）
   * 打开 Sprite 的 trim：头像图四周透明边距较多，裁剪后内容正好填满零件尺寸
   */
  static createAvatarPortrait(role: Role, position: Vec2 = new Vec2(), size: Size = roleInfoBarLayout.portrait.size) {
    const node = UiHelper.createSprite(`role_avatar_${role.occupation}_${role.sex}`, avatarImage(role.occupation, role.sex), position, size);
    node.getComponent(Sprite)!.trim = true;
    return node;
  }

  /** 创建装备插槽（名称即装备类型，便于按类型查找） */
  static createEquipmentSlot(type: EQUIPMENT_TYPE, imageSrc: string, size: Size = new Size(50, 50)) {
    const slot = UiHelper.createSprite(`equipment_slot_${type}`, imageSrc, new Vec2(), size);
    slot.name = type;
    return slot;
  }

  //#endregion

  //#region 过渡场景

  /**
   * 创建加载进度文本零件（一行字，百分比显示）
   * @return node 零件节点、progressLabel 进度文本（供刷新）
   */
  static createLoadingProgress(text: string, position: Vec2 = new Vec2(), fontSize: number = 32) {
    const node = UiHelper.createLabel("loading_progress", text, Color.WHITE, fontSize, position, new Size(960, 50));
    return { node, progressLabel: node.getComponent(Label) };
  }

  //#endregion

  //#region 角色预览

  /**
   * 创建角色预览效果
   * @param occupation 职业
   * @param sex 性别
   */
  static createRolePreview(name: string, level: number, occupation: string = "1", sex: string = "1", position: Vec2 = new Vec2(), size: Size = new Size()) {
    const role = UiHelper.createEmptyNode(name, position, size);
    const node = UiHelper.createSprite(name ? `${name}_animation` : "role_preview_animation", "");
    node.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    node.getComponent(Sprite).trim = false;
    const animationPlayer = node.addComponent(AnimationPlayer);
    animationPlayer.animationName = `create_role/plist/create_role_${occupation}_${sex}_stand@0`;
    animationPlayer.wrapMode = AnimationClip.WrapMode.Loop;
    animationPlayer.sample = 8;
    role.addChild(node);
    return role;
  }

  //#endregion

  //#region 选角开关组零件

  /** 创建性别选择开关组（选中值为节点名 "1"/"2"） */
  static createSexToggleGroup(position: Vec2 = new Vec2(0, 148)) {
    return UiHelper.createToggleGroup(
      "role_sex_toggle_group",
      [UiHelper.createToggle("1", "create_role/1_1", "create_role/1_0", new Vec2(), new Size(48, 48)), UiHelper.createToggle("2", "create_role/2_1", "create_role/2_0", new Vec2(), new Size(48, 48))],
      30,
      position,
    );
  }

  /** 创建职业选择开关组（选中值为 OECCUPATION 枚举） */
  static createOccupationToggleGroup(position: Vec2 = new Vec2(0, 52)) {
    return UiHelper.createToggleGroup(
      "role_occupation_toggle_group",
      [
        UiHelper.createToggle(OECCUPATION.ZHAN, "create_role/3_1", "create_role/3_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle(OECCUPATION.FA, "create_role/4_1", "create_role/4_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle(OECCUPATION.DAO, "create_role/5_1", "create_role/5_0", new Vec2(), new Size(48, 48)),
      ],
      30,
      position,
    );
  }

  //#endregion

  //#region 底部导航

  /**
   * 为已有节点施加底部导航按钮样式（组件自身即按钮时使用）
   * @param node 目标节点
   * @param button 按钮配置
   * @param role 当前角色（用于判断功能是否解锁并置灰）
   * @returns 该节点的 Sprite 组件
   */
  static applyBottomNavBarButtonStyle(node: Node, button: BottomNavBarButton, role: Role) {
    const layout = bottomBarLayout.navButton;
    const uiTransform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    uiTransform.setContentSize(layout.size);
    const buttonComponent = node.getComponent(Button) ?? node.addComponent(Button);
    buttonComponent.transition = Button.Transition.SCALE;
    const sprite = node.getComponent(Sprite) ?? node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    this.updateNodeIcon(node, button.icon);
    node.addChild(UiHelper.createLabel("shortcut_key", button.shortcutKey, Color.WHITE, layout.key.fontSize, layout.key.position, layout.key.size));
    // 判断是否解锁
    if (button.openLevel > role.level) sprite.grayscale = true;
    return sprite;
  }

  /**
   * 为已有节点施加自动挂机开关按钮样式（组件自身即按钮时使用）
   * 圆形图标随挂机状态切换（关闭=收剑 / 开启=举剑），位置在底部栏中段（快捷键栏与功能按键区之间的空档），
   * 图标下方带「挂机」文字；图标资源见 hudImages.autoFightOff / autoFightOn，切换由组件调 updateNodeIcon
   * @param node 目标节点
   */
  static applyAutoFightButtonStyle(node: Node) {
    const layout = bottomBarLayout.autoFight;
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(layout.size);
    node.setPosition(layout.position.x, layout.position.y, 0);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    this.updateNodeIcon(node, hudImages.autoFightOff);
    node.addChild(UiHelper.createLabel("auto_fight_label", layout.label.text, Color.WHITE, layout.label.fontSize, layout.label.position, layout.label.size));
    return sprite;
  }

  //#endregion

  //#region 血条与经验条

  /**
   * 创建游戏经验条
   * @param name 元素名称
   * @param progress 进度
   * @param position 位置
   * @param size 尺寸
   * @return 经验条
   */
  static createExpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return this.createBar(name, progress, "", hudImages.expBarFill, position, size);
  }

  /** 创建血条（底图与填充图见 hudImages.hpBarBackground / hpBarFill） */
  static createHpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return this.createBar(name, progress, hudImages.hpBarBackground, hudImages.hpBarFill, position, size, Color.RED);
  }

  /**
   * 创建进度条的公共方法
   * @param name 元素名称
   * @param progress 进度
   * @param bgSrc 背景图（空字符串则无背景）
   * @param barSrc 填充图
   * @param position 位置
   * @param size 尺寸
   * @param barColor 填充图着色（可选）
   */
  private static createBar(name: string, progress: number, bgSrc: string, barSrc: string, position: Vec2, size: Size, barColor?: Color) {
    const bar = UiHelper.createProgressBar(name, progress, bgSrc, position, size);
    const barFill = UiHelper.createSprite(`${name}_progress`, barSrc, new Vec2(), size);
    if (barColor) barFill.getComponent(Sprite).color = barColor;
    bar.addChild(barFill);
    bar.getComponent(ProgressBar).barSprite = barFill.getComponent(Sprite);
    return bar;
  }

  /** 创建头部信息 */
  static createHead(name: string, label: string, hp: number, maxHp: number) {
    /** 头部信息栏父节点 */
    const head = UiHelper.createFlexCol(name, 3, new Vec2(0, 100), new Size(100, 0));
    head.getComponent(UITransform).setAnchorPoint(0.5, 0);
    /** 角色名称显示节点 */
    const roleName = UiHelper.createLabel("role_name", label, Color.WHITE, 10, new Vec2(), new Size(100, 10));
    head.addChild(roleName);
    /** 文字称号 */
    const roleTitle = UiHelper.createLabel("role_title", "- 战神 * 女武神 -", Color.RED, 10, new Vec2(), new Size(100, 12));
    head.addChild(roleTitle);
    /** 血量进度条 */
    const roleHp = this.createHpBar("", hp / maxHp, new Vec2(), new Size(80, 4));
    head.addChild(roleHp);
    /** 血量文字显示 */
    const roleHpText = UiHelper.createLabel("role_name", `${hp} / ${maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(roleHpText);
    return head;
  }

  //#endregion

  //#region 提示

  /**
   * 创建错误提示
   * @param error 错误信息
   */
  static createErrorTip(name: string, error: string) {
    const errorTip = UiHelper.createTipLabel(name, error, tipsLayout.errorColor, tipsLayout.fontSize, tipsLayout.size);
    // 飘字是临时装饰（屏幕中间上浮 1~3 秒），标为点击穿透：不遮挡世界点击
    markClickThrough(errorTip);
    const uiOpacity = errorTip.addComponent(UIOpacity);
    tween(errorTip)
      .to(tipsLayout.errorMoveDuration, { position: new Vec3(0, tipsLayout.risePositionY, 0) })
      .start();
    tween(uiOpacity)
      .to(tipsLayout.errorFadeDuration, { opacity: 0 })
      .call(() => {
        errorTip.destroy();
      })
      .start();
    LayerManager.addToUILayer(errorTip);
  }

  /**
   * 创建提示
   */
  static createTip(name: string, text: string) {
    const errorTip = UiHelper.createTipLabel(name, text, tipsLayout.messageColor, tipsLayout.fontSize, tipsLayout.size);
    // 飘字是临时装饰（屏幕中间上浮 1~3 秒，拾取/提示时高频出现），标为点击穿透：不遮挡世界点击
    markClickThrough(errorTip);
    const uiOpacity = errorTip.addComponent(UIOpacity);
    tween(errorTip)
      .to(tipsLayout.messageMoveDuration, { position: new Vec3(0, tipsLayout.risePositionY, 0) })
      .start();
    tween(uiOpacity)
      .to(tipsLayout.messageFadeDuration, { opacity: 0 })
      .call(() => {
        errorTip.destroy();
      })
      .start();
    LayerManager.addToUILayer(errorTip);
  }

  /**
   * 创建自动战斗提示动画节点（"自动战斗中/自动寻路中"，屏幕中间循环播放的图集帧动画）
   * 帧来自 TexturePacker 图集且各帧源画布尺寸一致（800×800，内容居中），
   * 用 tipsLayout.autoTipSize 的自定义尺寸 + 不裁剪：每帧都按源画布等比缩放到该尺寸，
   * 逐帧内容位置与缩放比稳定不抖动（若裁剪，各帧裁剪矩形不同会被拉伸成不同缩放比而抖动）
   * 节点默认隐藏，帧动画由调用方通过 AnimationHelper.playLoopWithFrames 装载
   */
  static createAutoBattleTip(name: string): { node: Node; animate: Animation } {
    const node = UiHelper.createSprite(name, "", new Vec2(), tipsLayout.autoTipSize);
    const sprite = node.getComponent(Sprite)!;
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    const animate = node.addComponent(Animation);
    node.active = false;
    return { node, animate };
  }

  //#endregion

  //#region 战斗特效

  /**
   * 创建技能特效节点（图集帧动画，挂在特效层由 core/EffectManager 播放，播完自动销毁）
   * 与角色外观同一套口径：原始尺寸（RAW）+ 不裁剪，因此特效与角色美术天然对齐、逐帧不抖动
   * （特效图集各帧源画布尺寸一致，如 800×700/800×800，内容位置由帧自带的 offset 决定）
   */
  static createSkillEffect(name: string): Node {
    const node = UiHelper.createSprite(name, "");
    const sprite = node.getComponent(Sprite)!;
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    node.addComponent(Animation);
    return node;
  }

  /**
   * 创建状态图标零件（头像下方状态图标条的一项，见 ui/components/hud/StatusIconBar）
   * 图标来源为状态配置（configs/status 的 icon，resources 下精灵路径），尺寸统一见 hudLayout
   */
  static createStatusIcon(badge: StatusBadge): Node {
    const size = roleInfoBarLayout.statusBar.iconSize;
    return UiHelper.createSprite(`status_icon_${badge.id}`, badge.icon, new Vec2(), size);
  }

  /**
   * 在受伤物体位置显示受伤飘字（挂特效层，上浮淡出后自动销毁）
   * @param target 受伤物体节点
   * @param damage 受到的伤害数值
   */
  static showDamageText(target: Node, damage: number) {
    if (!isValid(target)) return;
    const damageText = UiHelper.createLabel("damage_text", damage > 0 ? `-${damage}` : "MISS", Color.RED, 18, new Vec2(), new Size(80, 24));
    LayerManager.addToEffectLayer(damageText);
    // 位置与受伤物体保持一致
    damageText.setWorldPosition(target.getWorldPosition());
    const uiOpacity = damageText.addComponent(UIOpacity);
    tween(damageText)
      .to(0.6, { position: new Vec3(damageText.position.x, damageText.position.y + 40, 0) })
      .start();
    tween(uiOpacity)
      .to(0.9, { opacity: 0 })
      .call(() => {
        damageText.destroy();
      })
      .start();
  }

  /**
   * 在技能释放者位置显示技能释放提示（挂特效层，上浮淡出后自动销毁）
   * @param caster 技能释放者节点
   * @param skillName 技能名称
   */
  static showSkillTip(caster: Node, skillName: string) {
    if (!isValid(caster)) return;
    const skillTip = UiHelper.createLabel("skill_tip", `释放${skillName}`, Color.YELLOW, 14, new Vec2(), new Size(120, 20));
    LayerManager.addToEffectLayer(skillTip);
    // 位置在释放者头顶（上移角色身高的一半）
    const casterPosition = caster.getWorldPosition();
    skillTip.setWorldPosition(casterPosition.x, casterPosition.y + 40, casterPosition.z);
    const uiOpacity = skillTip.addComponent(UIOpacity);
    tween(skillTip)
      .to(0.6, { position: new Vec3(skillTip.position.x, skillTip.position.y + 30, 0) })
      .start();
    tween(uiOpacity)
      .to(0.9, { opacity: 0 })
      .call(() => {
        skillTip.destroy();
      })
      .start();
  }

  /**
   * 在击杀位置显示经验获取飘字（挂特效层，上浮淡出后自动销毁；经验为 0 时不显示）
   * @param target 被击杀的怪物节点
   * @param exp 获得的经验值
   */
  static showExpGain(target: Node, exp: number) {
    if (exp <= 0 || !isValid(target)) return;
    const expText = UiHelper.createLabel("exp_gain_text", `+${exp} 经验`, Color.GREEN, 14, new Vec2(), new Size(100, 20));
    LayerManager.addToEffectLayer(expText);
    // 位置在被击杀怪物头顶
    const targetPosition = target.getWorldPosition();
    expText.setWorldPosition(targetPosition.x, targetPosition.y + 40, targetPosition.z);
    const uiOpacity = expText.addComponent(UIOpacity);
    tween(expText)
      .to(0.6, { position: new Vec3(expText.position.x, expText.position.y + 40, 0) })
      .start();
    tween(uiOpacity)
      .to(1, { opacity: 0 })
      .call(() => {
        expText.destroy();
      })
      .start();
  }

  //#endregion

  //#region 掉落物

  /**
   * 创建掉落物零件（地面上的物品：图标 + 名称，可叠加物品显示数量）
   * 挂载点与拾取逻辑由 DropManager 处理
   * @param good 物品数据
   * @param count 掉落数量
   * @param size 图标尺寸
   * @return node 掉落物节点、nameLabel 名称文本（供刷新/高亮）
   */
  static createDropItem(good: Goods, count: number = 1, size: Size = new Size(40, 40)) {
    const node = UiHelper.createNode("drop_item", new Vec2(), new Size(size.width, size.height + 14));
    const icon = UiHelper.createSprite(`drop_icon_${good.type}`, good.icon, new Vec2(0, 7), size);
    node.addChild(icon);
    // 名称（可叠加物品带上数量）
    const name = count > 1 ? `${good.label} x${count}` : good.label;
    const nameLabel = UiHelper.createLabel("drop_name", name, Color.WHITE, 10, new Vec2(0, -size.height / 2 - 3), new Size(120, 12));
    // 名称超出图标宽度时靠底部对齐，避免遮挡
    nameLabel.getComponent(UITransform).setAnchorPoint(0.5, 1);
    node.addChild(nameLabel);
    return { node, nameLabel: nameLabel.getComponent(Label) };
  }

  //#endregion

  //#region 弹窗与按钮

  /**
   * 创建游戏通用弹窗背景
   */
  static createDialogBg(name: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 500)) {
    const dialog = UiHelper.createSprite(name, "common/popup-bg", position, size);
    dialog.name = name;
    dialog.addComponent(Draggable);
    return dialog;
  }

  /**
   * 创建游戏通用弹窗标题
   */
  static createDialogTitle(name: string, title: string, position: Vec2 = new Vec2(0, 228)) {
    return UiHelper.createLabel(name, title, math.color("#FF8B8B"), 14, position, new Size(300, 30));
  }

  /**
   * 创建游戏通用关闭按钮
   */
  static createCloseButton(name: string, position: Vec2 = new Vec2(), size: Size = new Size(30, 30)) {
    return UiHelper.createButton(name, "common/close-button", position, size);
  }

  /**
   * 创建通用弹窗
   */
  static createDialog(name: string, title: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 500)) {
    // 弹窗
    const dialog = this.createDialogBg(name, position, size);
    // 关闭弹窗按钮
    const closeButton = UiHelper.createButton(`${name}_close_button`, "common/close-button", new Vec2(size.width / 2 - 15, size.height / 2 - 15), new Size(30, 30));
    dialog.addChild(closeButton);
    // 弹窗标题
    const dialogTitle = UiHelper.createLabel(`${name}_title`, title, math.color("#FF8B8B"), 14, new Vec2(0, size.height / 2 - 15), new Size(size.width - 60, 30));
    dialog.addChild(dialogTitle);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  }

  /**
   * 创建游戏大按钮
   */
  static createBigButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const bigButton = UiHelper.createButton(name, hudImages.bigButtonBackground, position, hudSize.bigButtonSize);
    bigButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, hudSize.bigButtonFontSize, new Vec2(), hudSize.bigButtonSize);
    bigButton.addChild(label);
    return bigButton;
  }

  /** 创建游戏中按钮 */
  static createMiddleButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const middleButton = UiHelper.createButton(name, hudImages.middleButtonBackground, position, hudSize.middleButtonSize);
    middleButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, hudSize.middleButtonFontSize, new Vec2(), hudSize.middleButtonSize);
    middleButton.addChild(label);
    return middleButton;
  }

  /** 创建游戏小按钮 */
  static createSmallButtion(name: string, text: string, position: Vec2 = new Vec2()) {
    const button = UiHelper.createButton(name, hudImages.smallButtonBackground, position, hudSize.smallButtonSize);
    button.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, hudSize.smallButtonFontSize, new Vec2(), hudSize.smallButtonSize);
    button.addChild(label);
    return button;
  }

  //#endregion

  //#region 物品

  // 在某个格子上创建物品
  static createGood(cell: Node, good: Goods) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    cell.addChild(sprite);
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        const screenPosition = GameHelper.worldPositionToScreenPosition(cell.getWorldPosition());
        const detailDialog = this.createGoodDetailDialog(good, cell.getComponent(UITransform).contentSize, screenPosition);
        LayerManager.addToUILayer(detailDialog);
        // 鼠标移出、或物品节点被销毁（背包刷新/换装重建）都要销毁详情，
        // 否则图标被销毁时不会触发 MOUSE_LEAVE，详情会永久留在屏幕上并挡住后续点击
        let closed = false;
        const closeDetail = () => {
          if (closed) return;
          closed = true;
          detailDialog.destroy();
        };
        sprite.once(Node.EventType.MOUSE_LEAVE, closeDetail, this);
        sprite.once(Node.EventType.NODE_DESTROYED, closeDetail, this);
      },
      this,
    );
  }

  /**
   * 创建物品详情弹窗
   */
  static createGoodDetailDialog(good: Goods, contentSize: Size, screenPosition: Vec3 = new Vec3()) {
    const screenSize = UiHelper.getScreenSize();
    const position = new Vec2(screenPosition.x - screenSize.width / 2, screenPosition.y - screenSize.height / 2);
    const dialog = UiHelper.createSprite("good_detail", "common/bg", position, new Size(240, 200));

    dialog.setPosition(position.x, position.y, 0);
    const layout = dialog.addComponent(Layout);
    layout.type = Layout.Type.GRID;
    layout.alignHorizontal = true;
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.spacingY = 8;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.node.setPosition(position.x, position.y);
    layout.padding = 10;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;

    // 头部
    const contentHeader = UiHelper.createFlexRow("header", 10, new Vec2(), new Size(220, 40));
    // 图标
    const goodImage = UiHelper.createSprite("good_image", good.icon, new Vec2(), new Size(40, 40));
    // 标题（装备名称 = 前缀 + 名称 + 后缀；其他物品没有前后缀概念）
    const titleText = isEquipment(good) ? `${good.prefix ?? ""}${good.label}${good.suffix ?? ""}` : good.label;
    const title = UiHelper.createLabel("good_detail_title", titleText, Color.WHITE, 14, new Vec2(), new Size(170, 40));
    const titleLabel = title.getComponent(Label);
    titleLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    titleLabel.verticalAlign = Label.VerticalAlign.TOP;
    titleLabel.enableWrapText = true;
    titleLabel.isBold = true;
    titleLabel.isItalic = true;
    titleLabel.isUnderline = true;
    titleLabel.lineHeight = 20;

    contentHeader.addChild(goodImage);
    contentHeader.addChild(title);

    // 标签行（装备专属：显示在名称正下方，与其他物品区分开）
    const contentTags = isEquipment(good) ? this.createGoodTagRow(good.tags ?? []) : null;

    // 介绍
    const contentDescription = UiHelper.createLabel("content_description", good.description, Color.WHITE, 12, new Vec2(), new Size(220, 50));
    const descLabel = contentDescription.getComponent(Label);
    descLabel.lineHeight = 16;
    descLabel.enableWrapText = true;
    descLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    descLabel.overflow = Label.Overflow.RESIZE_HEIGHT;

    // 属性列表（装备按槽位显示战斗属性）
    const contentBody = UiHelper.createFlexCol("content_body", 3, new Vec2(), new Size(220, 220));
    contentBody.getComponent(Layout).resizeMode = Layout.ResizeMode.CONTAINER;
    if (isEquipment(good)) {
      (goodShowAttributes.get(good.slot) ?? []).forEach((attr) => {
        contentBody.addChild(this.createAttributeLabel(attr, good[attr].toString()));
      });
    }

    dialog.addChild(contentHeader);
    if (contentTags) dialog.addChild(contentTags);
    dialog.addChild(contentDescription);
    dialog.addChild(contentBody);

    // 脚步图标
    const footerLogo = UiHelper.createSprite("logo", "logo", new Vec2(), new Size(220, 120));
    dialog.addChild(footerLogo);

    // 物品在左侧
    if (screenPosition.x < screenSize.width / 2) {
      position.x += contentSize.width / 2;
      dialog.getComponent(UITransform).anchorX = 0;
      contentHeader.getComponent(UITransform).anchorX = 0;
      contentDescription.getComponent(UITransform).anchorX = 0;
    }
    // 物品在右侧
    if (screenPosition.x > screenSize.width / 2) {
      dialog.getComponent(UITransform).anchorX = 1;
      contentHeader.getComponent(UITransform).anchorX = 0.5;
      contentDescription.getComponent(UITransform).anchorX = 1;
    }
    // 物品在上册
    if (screenPosition.y > screenSize.height / 2) {
      position.y += contentSize.height / 2;
      dialog.getComponent(UITransform).anchorY = 1;
      contentHeader.getComponent(UITransform).anchorY = 0.5;
      contentDescription.getComponent(UITransform).anchorY = 1;
    }
    // 物品在下册
    if (screenPosition.y < screenSize.height / 2) {
      position.y -= contentSize.height / 2;
      dialog.getComponent(UITransform).anchorY = 0;
      contentHeader.getComponent(UITransform).anchorY = 0;
      contentDescription.getComponent(UITransform).anchorY = 0;
    }
    return dialog;
  }

  /**
   * 创建属性标签
   */
  static createAttributeLabel(key: keyof BattleAttributes, value: string, size: Size = new Size(220, 20)) {
    const attributeLabel = UiHelper.createFlexRow(key, 10, new Vec2(), size);

    const icon = UiHelper.createSprite("icon", "common/dot", new Vec2(), new Size(10, 10));
    attributeLabel.addChild(icon);

    const label = UiHelper.createLabel(key, goodShowAttributesLabel.get(key), Color.WHITE, 12, new Vec2(), new Size(50, size.height));
    label.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    attributeLabel.addChild(label);

    const attribute = UiHelper.createLabel(key, value.replace(",", " - "), Color.WHITE, 12, new Vec2(), new Size(size.width - 20 - 50 - 10, size.height));
    attributeLabel.addChild(attribute);

    return attributeLabel;
  }

  /**
   * 创建装备标签行（标签逐条横排，占名称下方一整行）
   * 无标签时返回空行：保持"名称下方固定有一行标签"的排版位置不随标签有无而跳动
   */
  static createGoodTagRow(tags: string[], size: Size = GOOD_TAG_ROW_SIZE) {
    const row = UiHelper.createFlexRow("good_tags", GOOD_TAG_SPACING, new Vec2(), size);
    tags.forEach((tag, index) => {
      // 每条标签按字数给宽（中文字宽≈字号），避免长标签被 CLAMP 截断
      const width = Math.max(GOOD_TAG_MIN_WIDTH, tag.length * GOOD_TAG_FONT_SIZE + GOOD_TAG_PADDING_X);
      row.addChild(UiHelper.createLabel(`good_tag_${index}`, tag, GOOD_TAG_COLOR, GOOD_TAG_FONT_SIZE, new Vec2(), new Size(width, size.height)));
    });
    return row;
  }

  /**
   * 为已有节点施加"角色属性列表"样式并填充属性条目（组件自身即列表容器时使用）
   * 结构：基础属性标题 + 各属性行 + 特殊属性标题
   * @param node 目标节点
   * @param role 角色数据
   * @param position 位置
   * @param size 尺寸
   * @returns 该节点的 Layout 组件
   */
  static applyRoleAttributeListStyle(node: Node, role: Role, position: Vec2 = new Vec2(217, 205), size: Size = new Size(150, 0)) {
    const layout = this.applyColumnStyle(node, 5, position, size);
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    layout.padding = 10;
    node.getComponent(UITransform).setAnchorPoint(0.5, 1);
    // 重复调用即刷新（装备穿脱等改变属性后重建条目，旧条目真正销毁）
    clearChildren(node);
    node.addChild(this.createText("role_basic_attributes", "基础属性", 14, new Vec2(), new Size(size.width, 14)));
    for (const element of goodShowAttributesLabel.keys()) {
      node.addChild(this.createAttributeLabel(element, role[element].toString(), new Size(size.width, 20)));
    }
    node.addChild(this.createText("role_special_attributes", "特殊属性", 14, new Vec2(), new Size(size.width, 14)));
    return layout;
  }

  //#endregion

  //#region 角色内观与特效

  /**
   * 创建角色衣服内观
   * 内观的大小、旋转与位置由装备配置的 inScaleX / inScaleY / inRotate / inPosition 决定（缺省不缩放、不旋转）
   */
  static createRoleClothInShow(cloth: Equipment, size: Size = new Size()) {
    const clothInShow = UiHelper.createSprite("cloth_in_show", "", cloth.inPosition, size);
    clothInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    clothInShow.setScale(cloth?.inScaleX ?? 1, cloth?.inScaleY ?? 1, 1);
    clothInShow.angle = cloth?.inRotate ?? 0;
    AnimationHelper.playLoopWithDir("cloth_in_show", clothInShow, cloth.in, 1);
    return clothInShow;
  }

  /**
   * 创建角色武器内观
   * 内观的大小、旋转与位置由装备配置的 inScaleX / inScaleY / inRotate / inPosition 决定（缺省不缩放、不旋转）
   */
  static createRoleWeaponInshow(weapon: Equipment, size: Size = new Size()) {
    const weaponInShow = UiHelper.createSprite("weapon_in_show", "", weapon.inPosition, size);
    weaponInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    weaponInShow.setScale(weapon?.inScaleX ?? 1, weapon?.inScaleY ?? 1, 1);
    weaponInShow.angle = weapon?.inRotate ?? 0;
    AnimationHelper.playLoopWithDir("weapon_in_show", weaponInShow, weapon.in, 1);
    return weaponInShow;
  }

  /**
   * 创建升级特效
   */
  static createUpgradeEffect(position: Vec2 = new Vec2()) {
    const upgrade = UiHelper.createSprite("upgrade_effect", "", new Vec2(0, 90), new Size(284, 380));
    // 升级特效是纯装饰动画，标为点击穿透：不遮挡世界点击
    markClickThrough(upgrade);
    AnimationHelper.playOnceWithDir("upgrade", upgrade, "effect/upgrade", 1);
    return upgrade;
  }

  //#endregion

  //#region 背包

  /** 创建背包格子 */
  static createRoleBagCell(row: number, col: number) {
    return UiHelper.createSprite(`bag_slot_${row}_${col}`, "common/grid", new Vec2(), new Size(50, 50));
  }

  /** 创建背包格子行（在 parent 下逐行生成格子并返回 [行][列] 索引） */
  static createRoleBagCellRow(parent: Node) {
    const cells = [];
    for (let row = 0; row < bagRow; row++) {
      cells[row] = [];
      const rowNode = UiHelper.createFlexRow(`bag_row_${row}`, 3, new Vec2(0, 0), new Size(580, 50));
      parent.addChild(rowNode);
      for (let col = 0; col < bagCol; col++) {
        const cell = this.createRoleBagCell(row, col);
        rowNode.addChild(cell);
        cells[row][col] = cell;
      }
    }
    return cells;
  }

  //#endregion

  //#region 角色/怪物动画

  /**
   * 使用角色动画（按游戏配置 roleAnimationMap 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
  static useRoleAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return AnimationHelper.useRoleAnimation(name, node, dirSrc, speedRate);
  }

  /**
   * 使用怪物动画（按游戏配置 monsterAnimation 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
  static useMonsterAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return AnimationHelper.useMonsterAnimation(name, node, dirSrc, speedRate);
  }

  //#endregion

  //#region 快捷键图标

  /** 为快捷键节点附加图标样式与按键名，返回冷却倒计时文字引用（几何见 hudLayout.bottomBar.shortcutSlot） */
  static applyShortcutKeyStyle(node: Node, label: string) {
    const layout = bottomBarLayout.shortcutSlot;
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    node.getComponent(UITransform).setContentSize(layout.size);
    node.addChild(UiHelper.createLabel("shortcut_key_label", label, Color.WHITE, layout.key.fontSize, layout.key.position, layout.key.size));
    const cooldownNode = UiHelper.createLabel("shortcut_key_cooldown", "", Color.WHITE, layout.cooldown.fontSize, layout.cooldown.position, layout.cooldown.size);
    cooldownNode.active = false;
    node.addChild(cooldownNode);
    return { cooldownLabel: cooldownNode.getComponent(Label) };
  }

  /** 更新节点图标（异步加载 SpriteFrame） */
  static updateNodeIcon(node: Node, src?: string) {
    const sprite = node.getComponent(Sprite);
    if (!src || !sprite) return;
    UiHelper.loadSprite(src, (spriteFrame) => {
      if (node.isValid && sprite.isValid) sprite.spriteFrame = spriteFrame;
    });
  }

  //#endregion

  //#region 底部栏

  /** 为已有节点施加底部栏主体样式（尺寸、位置与背景见 hudLayout.bottomBar），节点由底部栏组件自身充当 */
  static applyBottomBarBodyStyle(node: Node) {
    node.addComponent(UITransform).setContentSize(bottomBarLayout.size);
    node.setPosition(bottomBarLayout.position.x, bottomBarLayout.position.y, 0);
    node.addChild(UiHelper.createSprite("bottom_nav_bar_background", hudImages.bottomBarBackground, new Vec2(), bottomBarLayout.size));
  }

  /** 创建血量/魔法值文字零件（位置与尺寸见 hudLayout.bottomBar.hpText / mpText） */
  static createHpText(text: string, position: Vec2 = new Vec2(), size: Size = bottomBarLayout.hpText.size, name = "hp_text") {
    return UiHelper.createLabel(name, text, Color.WHITE, bottomBarLayout.hpText.fontSize, position, size);
  }

  /**
   * 创建圆形血量/魔法值显示零件（底图 + 竖向进度条）
   * 返回底图节点与其内部的进度条节点，位置与尺寸见 hudLayout.bottomBar.hpOrb / mpOrb
   * 底图见 hudImages.hpOrbBase；填充图缺省为 hudImages.hpOrbFill，魔法球传 hudImages.mpOrbFill
   */
  static createRoundHpBar(progress: number, position: Vec2 = new Vec2(), size: Size = bottomBarLayout.hpOrb.size, fillImage: string = hudImages.hpOrbFill): { barSprite: Node; hpBar: Node } {
    const barSprite = UiHelper.createSprite("hp_bar_sprite", hudImages.hpOrbBase, position, size);
    const hpBar = UiHelper.createProgressBar("hp_bar", progress, "", new Vec2(), size);
    const hpProgress = UiHelper.createSprite("hp_bar_progress", fillImage, new Vec2(), size);
    hpProgress.getComponent(Sprite).type = Sprite.Type.TILED;
    hpProgress.setPosition(0, 0);
    hpProgress.getComponent(UITransform).setAnchorPoint(0.5, 0);
    hpBar.addChild(hpProgress);
    hpBar.getComponent(ProgressBar).barSprite = hpProgress.getComponent(Sprite);
    hpBar.getComponent(ProgressBar).mode = ProgressBar.Mode.VERTICAL;
    barSprite.addChild(hpBar);
    return { barSprite, hpBar };
  }

  //#endregion

  //#region 主角外观与怪物/NPC

  /** 创建主角衣服展示节点 */
  static createRoleClothNode() {
    const cloth = UiHelper.createSprite("cloth", "");
    cloth.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    return cloth;
  }

  /** 创建主角武器展示节点 */
  static createRoleWeaponNode() {
    const weapon = UiHelper.createSprite("weapon", "");
    weapon.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    return weapon;
  }

  /** 创建怪物节点主体（身体 + 待机动画），碰撞体与点击事件由调用方处理 */
  static createMonsterBody(monster: Monster): { node: Node; animate: Animation } {
    const node = UiHelper.createNode("monster", new Vec2(), monster.contentSize);
    const animationNode = UiHelper.createNode("monster_animation");
    animationNode.addComponent(Sprite);
    const animate = AnimationHelper.useMonsterAnimation(getAnimationName(ACTION.STAND, DIRECTION.DOWN), animationNode, monster.out, monster.speedRate);
    node.addChild(animationNode);
    return { node, animate };
  }

  /** 创建NPC节点主体（名字 + 外观动画），位置与点击事件由调用方处理 */
  static createNpcNode(npc: NPC) {
    const npcNode = UiHelper.createFlexCol("npc_node", 0, new Vec2(), new Size(100, 170));
    npcNode.addChild(UiHelper.createLabel("npc_label", npc.label, Color.WHITE, 12, new Vec2(), new Size(100, 20)));
    const npcSpriteNode = UiHelper.createSprite("npc_sprite_node", "", new Vec2(), new Size(100, 150));
    const npcSprite = UiHelper.createSprite("npc_sprite", "");
    npc.scale && npcSprite.setScale(npc.scale);
    npc.position && npcSprite.setPosition(npc.position);
    AnimationHelper.playLoopWithDir("npc", npcSprite, npc.src);
    npcSpriteNode.addChild(npcSprite);
    npcNode.addChild(npcSpriteNode);
    return npcNode;
  }

  //#endregion

  //#region 地图碰撞区

  /**
   * 创建碰撞区域节点（节点尺寸即碰撞范围，本体不含任何显示元素）
   * 用于把 Tiled collision 对象组里的矩形实例化成游戏内的碰撞范围，
   * 碰撞体由调用方（CollisionAreaSpawner）通过 addObstacleCollider 添加
   * @param name 对象名称（仅用于命名节点，便于在层级中定位）
   * @param size 区域尺寸
   */
  static createCollisionAreaNode(name: string, size: Size) {
    return UiHelper.createNode(`collision_${name}`, new Vec2(), size);
  }

  //#endregion

  //#region 怪物刷怪区域

  /**
   * 创建刷怪区域节点（节点尺寸即区域范围，本体不含任何显示元素）
   * 用于把 Tiled monster 对象组里的矩形实例化成怪物落点范围，
   * 怪物本身的生成由 MonsterManager 按区域完成，区域范围显示见 showAreaRange
   * @param label 区域名称（用于命名节点与调试显示）
   * @param size 区域尺寸
   */
  static createMonsterAreaNode(label: string, size: Size) {
    return UiHelper.createNode(`monster_area_${label}`, new Vec2(), size);
  }

  //#endregion

  //#region 碰撞范围显示（调试）

  /**
   * 显示节点的碰撞范围：范围框 + 名称 + 尺寸，用于核对游戏内实际的碰撞范围
   * 直接读取节点上 BoxCollider2D 的 size 与 offset 绘制，因此显示范围与引擎实际判定范围永远一致
   * （角色碰撞体相对脚下原点有偏移，范围框与名称都按该偏移摆放）
   * 所有碰撞体（Tiled 碰撞区 / NPC / 怪物 / 角色）统一走本方法，由 debugConfig.colliderRange 一个开关控制
   * @param node 已挂载 BoxCollider2D 的节点（没有碰撞体则不做任何事）
   * @param name 显示名称（缺省取节点名；传空串则只画范围框）
   * @param kind 类别（role 使用另一种配色，便于与静态障碍区分）
   * @return 显示节点（无碰撞体或开关关闭时为 null）
   */
  static showColliderRange(node: Node, name?: string, kind: ColliderRangeKind = "obstacle") {
    if (!debugConfig.colliderRange) return null;
    const collider = node.getComponent(BoxCollider2D);
    if (!collider) return null;
    const color = kind === "role" ? COLLIDER_RANGE_ROLE_COLOR : COLLIDER_RANGE_OBSTACLE_COLOR;
    return this.drawRange(node, collider.size, collider.offset, color, name ?? node.name);
  }

  /**
   * 显示区域的范围（范围框 + 名称 + 尺寸），用于没有碰撞体的区域（如怪物刷怪区域）
   * 取节点 UITransform 的尺寸绘制，尺寸即区域的落点范围
   * 由 debugConfig.areaRange 一个开关控制
   * @param node 区域节点（带 UITransform，其尺寸即区域尺寸）
   * @param name 显示名称（缺省取节点名）
   * @return 显示节点（开关关闭或无 UITransform 时为 null）
   */
  static showAreaRange(node: Node, name?: string) {
    if (!debugConfig.areaRange) return null;
    const uiTransform = node.getComponent(UITransform);
    if (!uiTransform) return null;
    return this.drawRange(node, uiTransform.contentSize, new Vec2(), COLLIDER_RANGE_AREA_COLOR, name ?? node.name);
  }

  /**
   * 在节点上绘制范围框与名称尺寸（碰撞范围显示与区域范围显示共用的绘制实现）
   * 直接绘制在目标节点自身，因此显示范围与节点的实际尺寸/碰撞体偏移永远一致
   * @param node 目标节点
   * @param size 范围尺寸
   * @param offset 范围相对节点原点的偏移（碰撞体偏移，无偏移传 Vec2.ZERO）
   * @param color 范围框与名称颜色
   * @param label 名称（空串则只画范围框）
   * @return 承载名称的显示节点
   */
  private static drawRange(node: Node, size: Size, offset: Vec2, color: Color, label: string) {
    /** 范围框：按偏移换算矩形左下角（组件绘制在节点自身，不受子节点布局影响） */
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = COLLIDER_RANGE_LINE_WIDTH;
    graphics.strokeColor = color;
    graphics.fillColor = new Color(color.r, color.g, color.b, COLLIDER_RANGE_FILL_ALPHA);
    graphics.rect(offset.x - size.width / 2, offset.y - size.height / 2, size.width, size.height);
    graphics.fill();
    graphics.stroke();

    /** 名称与尺寸：挂在纯分组节点上，避免目标节点是布局容器（如 NPC 节点）时子节点被 Layout 重排 */
    const view = UiHelper.createGroupNode("collider_range_view", offset);
    node.addChild(view);
    // 图层挂载完成后再创建显示节点时也要跟随所在图层，否则会留在默认图层而不可见
    LayerManager.setNodeToLayer(view, node.layer);
    if (label)
      view.addChild(
        UiHelper.createLabel(
          "collider_range_name",
          `${label} ${Math.round(size.width)}×${Math.round(size.height)}`,
          color,
          COLLIDER_RANGE_NAME_FONT_SIZE,
          new Vec2(),
          new Size(COLLIDER_RANGE_NAME_WIDTH, COLLIDER_RANGE_NAME_HEIGHT),
        ),
      );
    return view;
  }

  //#endregion

  //#region 怪物信息面板

  /**
   * 为已有节点施加怪物信息面板主体样式（尺寸、位置与背景见 hudLayout.monsterInfoPanel），节点由面板组件自身充当
   * 背景资源见 hudImages.monsterInfoBackground
   */
  static applyMonsterInfoBodyStyle(node: Node) {
    node.addComponent(UITransform).setContentSize(monsterInfoPanelLayout.size);
    node.setPosition(monsterInfoPanelLayout.position.x, monsterInfoPanelLayout.position.y, 0);
    node.addChild(UiHelper.createSprite("monster_info_background", hudImages.monsterInfoBackground, new Vec2(), monsterInfoPanelLayout.size));
  }

  /** 创建怪物头像（左侧，取怪物图标；位置与尺寸见 hudLayout.monsterInfoPanel.avatar） */
  static createMonsterAvatar(monster: Monster, position: Vec2 = monsterInfoPanelLayout.avatar.position, size: Size = monsterInfoPanelLayout.avatar.size) {
    return UiHelper.createSprite("monster_avatar", monster.icon, position, size);
  }

  /**
   * 创建怪物技能行（怪物技能图标，未配置技能则不渲染）
   * @param monster 怪物数据
   * @param position 行位置（缺省取 hudLayout.monsterInfoPanel.skillRow）
   * @param slotSize 单个技能图标尺寸
   * @param spacing 图标间距
   */
  static createMonsterSkillRow(
    monster: Monster,
    position: Vec2 = monsterInfoPanelLayout.skillRow.position,
    slotSize: number = monsterInfoPanelLayout.skillRow.slotSize,
    spacing: number = monsterInfoPanelLayout.skillRow.spacing,
  ) {
    const row = UiHelper.createNode("monster_skills", position, new Size(monsterInfoPanelLayout.size.width, slotSize));
    const skillIds = monster.skills ?? [];
    skillIds.forEach((skillId, index) => {
      const skillConfig = skills.get(skillId);
      if (!skillConfig) return;
      const slot = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2((index - (skillIds.length - 1) / 2) * (slotSize + spacing), 0), new Size(slotSize, slotSize));
      row.addChild(slot);
    });
    return row;
  }

  //#endregion

  //#region 小地图

  /**
   * 为已有节点施加小地图主体样式（尺寸与屏幕右上角位置见 hudLayout.smallMap），节点由小地图组件自身充当
   * 尺寸需容纳「左侧功能按钮列 + 名称条/地图/标签/坐标条」整块内容（子节点位置以地图内容区中心为原点）
   */
  static applySmallMapBodyStyle(node: Node) {
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(smallMapLayout.size);
    node.setPosition(smallMapLayout.position.x, smallMapLayout.position.y, 0);
  }

  /**
   * 创建小地图坐标点绘制层（单个 Graphics 节点，占满内容区）
   * 点位由 drawSmallMapDots 整体重绘，避免按怪物增删节点
   */
  static createSmallMapDotLayer(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_dots", position, size);
    return node.addComponent(Graphics);
  }

  /** 在绘制层上重绘全部坐标点（先清空再画，重绘频率由调用方节流） */
  static drawSmallMapDots(graphics: Graphics, dots: SmallMapDot[]) {
    graphics.clear();
    dots.forEach((dot) => {
      graphics.fillColor = dot.color;
      graphics.circle(dot.x, dot.y, dot.radius);
      graphics.fill();
    });
  }

  //#endregion

  //#region 技能列表

  /** 创建技能列表滚动区 */
  static createSkillListView(): Node {
    return UiHelper.createScrollView("skill_list", new Vec2(0, -15), new Size(260, 350));
  }

  /** 创建单个技能行（未学习置灰；已学习点击触发回调） */
  static createSkillItem(role: Role, skillId: SkillId, onOpenShortcutKey: () => void): Node {
    const skillConfig = skills.get(skillId);
    const node = UiHelper.createFlexRow(skillId, 5, new Vec2(), new Size(250, 50));
    const skillIcon = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2(), new Size(40, 40));
    if (!role.skills[skillId]) skillIcon.getComponent(Sprite).grayscale = true;
    if (role.skills[skillId]) skillIcon.on(Node.EventType.TOUCH_END, onOpenShortcutKey, this);
    node.addChild(skillIcon);
    const description = UiHelper.createFlexCol(`${skillId}_desc`, 3, new Vec2(), new Size(205, 40));
    const skillLabel = UiHelper.createLabel("skill_label", `${skillConfig.label} (${role.skills[skillId] ? "lv." + role.skills[skillId] : "未学习"})`, Color.WHITE, 12, new Vec2(), new Size(205, 20));
    skillLabel.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    description.addChild(skillLabel);
    const skillDesc = UiHelper.createLabel("skill_label", skillConfig.description, Color.WHITE, 10, new Vec2(), new Size(205, 15));
    skillDesc.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    description.addChild(skillDesc);
    node.addChild(description);
    return node;
  }

  //#endregion
}
