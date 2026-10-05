import {
  Animation,
  BoxCollider2D,
  Button,
  Color,
  Graphics,
  isValid,
  Label,
  LabelAtlas,
  Layout,
  Mask,
  Node,
  ProgressBar,
  resources,
  Size,
  Sprite,
  SpriteFrame,
  tween,
  UIOpacity,
  UITransform,
  Vec2,
  Vec3,
} from "cc";
import UiHelper from "./UiHelper";
import AnimationHelper from "./AnimationHelper";
import { Draggable } from "../components/input/Draggable";
import { debugConfig } from "../../configs/debug";
import { getText, TextParams } from "../../configs/texts";
import { BottomNavItem } from "../../configs/bottomNav";
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
import { SoulAttributes, SoulLevelConfig } from "../../types/soul";
import { TitleAttributes, TitleLevelConfig } from "../../types/title";
import { StatusBadge } from "../../types/status";
import GameHelper from "../core/GameHelper";
import { blockClickThrough, markClickThrough } from "../utils/input/UiHit";
import { goodShowAttributes, goodShowAttributesLabel } from "../../configs/good";
import { equipmentSlots, getEquipmentNameParts, getRecyclePrice } from "../../configs/equipments";
import { soulAttributeLabels } from "../../configs/soul";
import { titleAttributeLabels } from "../../configs/title";
import { skills } from "../../configs/skill";
import LayerManager from "../core/LayerManager";
import { clearChildren } from "../utils/node/NodeTree";
import { getAnchoredPosition, getPopupPosition, getVisibleSize } from "../utils/layout/ScreenLayout";
import {
  avatarImage,
  bagGridLayout,
  bottomBarLayout,
  createRolePreviewImage,
  dialogFrame,
  equipmentBorderLayout,
  equipmentDetailBackgroundLayout,
  titleUpgradeDialogLayout,
  equipmentSlotLayout,
  goodDetailLayout,
  hoverTipLayout,
  monsterInfoPanelLayout,
  roleAttributeListLayout,
  roleInfoBarLayout,
  roleSelectorLayout,
  skillListDialogLayout,
  smallMapLayout,
  tipsLayout,
  uiImages,
  uiSize,
  uiTheme,
  warSoulDialogLayout,
} from "../../configs/hudLayout";
import { borders, getEquipmentBorderKey } from "../../configs/border";
import { detailBackgrounds, getEquipmentDetailBackgroundKey } from "../../configs/background";

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

/**
 * 路线指示线样式（点状线）
 * 路线不是实线，而是沿折线等距铺一串圆点，终点再画一个更大的圆点表示目的地；
 * 颜色/半径/间距都由调用方的配置传进来（绘制层坐标单位：大地图是世界像素，小地图/预览是像素）
 */
export interface RouteLineStyle {
  /** 点与终点圆点的颜色 */
  color: Color;
  /** 单个点半径 */
  dotRadius: number;
  /** 相邻点间距（需大于 2 × dotRadius，否则点会连成一团） */
  dotGap: number;
  /** 终点圆点半径（比普通点大一圈，一眼看出目的地） */
  endDotRadius: number;
}

/** 底部功能按钮（数据见 configs/bottomNav.bottomNavItems，这里补上点击回调——回调是代码不是配置） */
export interface BottomNavBarButton extends BottomNavItem {
  /** 点击回调 */
  onClick: () => void;
}

/** 碰撞范围显示类别（决定配色：静态障碍 / 角色自身） */
export type ColliderRangeKind = "obstacle" | "role";

//#endregion

//#region 碰撞范围显示（调试）

/** 范围标注样式（线宽/填充透明度/名称字号与尺寸 + 三套配色，见 configs/debug 的 rangeStyle） */
const rangeStyle = debugConfig.rangeStyle;

//#endregion

//#region 战魂

/** 战魂弹窗布局（卡片列表 / 动画 / 信息 / 属性 / 绑定元宝 / 升级按钮，统一见 configs/hudLayout.warSoulDialogLayout） */
const soul = warSoulDialogLayout;

//#endregion

//#region 装备详情显示

/** 详情弹窗内的标签行样式（标签行尺寸/颜色/字号/间距与左右留白，见 configs/hudLayout.goodDetailLayout.tag） */
const goodTag = goodDetailLayout.tag;

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

  /** 创建网格排列容器（从左到右排满换行、从上到下；高度为 0 时按内容自适应且锚点顶对齐） */
  static createGrid(name: string, spacingX: number, spacingY: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createGrid(name, spacingX, spacingY, position, size);
  }

  /** 创建滚动视图（内容纵向排列、可上下滑动） */
  static createScrollView(name: string, position: Vec2, size: Size) {
    return UiHelper.createScrollView(name, position, size);
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
    const background = UiHelper.createSprite("input_background", uiImages.loginInputBackground, position, size);
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
    node.addChild(UiHelper.createSprite("combat_icon", uiImages.combatIcon, new Vec2(), iconSize));
    const labelX = iconSize.width / 2 + labelGap;
    const labelNode = UiHelper.createLabel("combat_number", role.combat.toString(), Color.WHITE, 20, new Vec2(labelX, 0), new Size(200, iconSize.height), Label.HorizontalAlign.LEFT);
    labelNode.getComponent(UITransform).setAnchorPoint(0, 0.5);
    const combatLabel = labelNode.getComponent(Label);
    resources.load(uiImages.combatFont, LabelAtlas, (error, atlas) => {
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
  static createEquipmentSlot(type: EQUIPMENT_TYPE, imageSrc: string, size: Size = equipmentSlotLayout.slotSize) {
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
   * 创建角色预览效果（选角界面的站立帧动画，图集帧循环播放；帧率见 layouts/scenes 的 roleSelectorLayout.previewFrameRate）
   * 帧动画走 AnimationHelper：素材是 TexturePacker 图集（plist），按帧名末尾序号排序后循环播放
   * 帧加载是异步的（已缓存时微任务内即完成），装载完成时节点已销毁/已标记销毁则静默跳过
   * @param name 预览名（同时作为动画节点名前缀）
   * @param level 等级（预览动画与等级无关，保留参数以兼容调用方）
   * @param occupation 职业
   * @param sex 性别
   */
  static createRolePreview(name: string, level: number, occupation: string = "1", sex: string = "1", position: Vec2 = new Vec2(), size: Size = new Size()) {
    const role = UiHelper.createEmptyNode(name, position, size);
    const animationName = name ? `${name}_animation` : "role_preview_animation";
    const node = UiHelper.createSprite(animationName, "");
    node.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    node.getComponent(Sprite).trim = false;
    role.addChild(node);
    AnimationHelper.loadFramesFromAtlas(createRolePreviewImage(occupation, sex)).then((frames) => {
      // 严格模式判据：角色列表/创建弹窗刷新会销毁旧预览，isValid 默认不查「待销毁」，当帧会漏判
      if (!isValid(node, true)) return;
      AnimationHelper.playLoopWithFrames(animationName, node, frames, roleSelectorLayout.previewFrameRate);
    });
    // 角色预览本身是可点元素（选角列表点击切换角色），鼠标通道补一次命中拦截
    blockClickThrough(role);
    return role;
  }

  //#endregion

  //#region 选角开关组零件

  /** 创建性别选择开关组（选中值为节点名 "1"/"2"；位置与开关几何见 configs/hudLayout.roleSelectorLayout.createDialog.sexToggle） */
  static createSexToggleGroup(position: Vec2 = roleSelectorLayout.createDialog.sexToggle.position) {
    const { spacing, toggleSize } = roleSelectorLayout.createDialog.sexToggle;
    return UiHelper.createToggleGroup(
      "role_sex_toggle_group",
      [
        UiHelper.createToggle("1", uiImages.sexToggle.boy.on, uiImages.sexToggle.boy.off, new Vec2(), toggleSize),
        UiHelper.createToggle("2", uiImages.sexToggle.girl.on, uiImages.sexToggle.girl.off, new Vec2(), toggleSize),
      ],
      spacing,
      position,
    );
  }

  /** 创建职业选择开关组（选中值为 OECCUPATION 枚举；位置与开关几何见 configs/hudLayout.roleSelectorLayout.createDialog.occupationToggle） */
  static createOccupationToggleGroup(position: Vec2 = roleSelectorLayout.createDialog.occupationToggle.position) {
    const { spacing, toggleSize } = roleSelectorLayout.createDialog.occupationToggle;
    return UiHelper.createToggleGroup(
      "role_occupation_toggle_group",
      [
        UiHelper.createToggle(OECCUPATION.ZHAN, uiImages.occupationToggle.zhan.on, uiImages.occupationToggle.zhan.off, new Vec2(), toggleSize),
        UiHelper.createToggle(OECCUPATION.FA, uiImages.occupationToggle.fa.on, uiImages.occupationToggle.fa.off, new Vec2(), toggleSize),
        UiHelper.createToggle(OECCUPATION.DAO, uiImages.occupationToggle.dao.on, uiImages.occupationToggle.dao.off, new Vec2(), toggleSize),
      ],
      spacing,
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
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截，避免点底部栏时穿透到下层 UI
    blockClickThrough(node);
    return sprite;
  }

  /**
   * 为已有节点施加自动挂机开关按钮样式（组件自身即按钮时使用）
   * 圆形图标随挂机状态切换（关闭=收剑 / 开启=举剑），位置在底部栏中段（快捷键栏与功能按键区之间的空档），
   * 图标下方带「挂机」文字；图标资源见 uiImages.autoFightOff / autoFightOn，切换由组件调 updateNodeIcon
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
    this.updateNodeIcon(node, uiImages.autoFightOff);
    node.addChild(UiHelper.createLabel("auto_fight_label", layout.label.text, Color.WHITE, layout.label.fontSize, layout.label.position, layout.label.size));
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截
    blockClickThrough(node);
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
    return this.createBar(name, progress, "", uiImages.expBarFill, position, size);
  }

  /** 创建血条（底图与填充图见 uiImages.hpBarBackground / hpBarFill） */
  static createHpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return this.createBar(name, progress, uiImages.hpBarBackground, uiImages.hpBarFill, position, size, Color.RED);
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

  /**
   * 创建头部信息（返回纵向弹性容器：角色名称 / 血条 / 血量文字；
   * 称号名牌动画由 RoleDisplay.updateTitleShow 插进同一个容器的最上方，故后续读件一律按名字而不是按下标）
   */
  static createHead(name: string, label: string, hp: number, maxHp: number) {
    /** 头部信息栏父节点 */
    const head = UiHelper.createFlexCol(name, 3, new Vec2(0, 100), new Size(100, 0));
    head.getComponent(UITransform).setAnchorPoint(0.5, 0);
    /** 角色名称显示节点 */
    const roleName = UiHelper.createLabel("role_name", label, Color.WHITE, 10, new Vec2(), new Size(100, 10));
    head.addChild(roleName);
    /** 血量进度条（两个字面名与 RoleDisplay.updateHead 的取件口径成对，改动请同步） */
    const roleHp = this.createHpBar("role_hp_bar", hp / maxHp, new Vec2(), new Size(80, 4));
    head.addChild(roleHp);
    /** 血量文字显示 */
    const roleHpText = UiHelper.createLabel("role_hp_text", `${hp} / ${maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(roleHpText);
    return head;
  }

  //#endregion

  //#region 提示

  /**
   * 创建错误提示（红色飘字）
   * @param name 文案 key（configs/texts 的 uiTexts）
   * @param params 模板参数（文案里写 {key}，这里给值）
   */
  static createErrorTip(name: string, params?: TextParams) {
    this.createFloatingTip(name, params, tipsLayout.errorColor, tipsLayout.errorMoveDuration, tipsLayout.errorFadeDuration);
  }

  /**
   * 创建提示（普通飘字）
   * @param name 文案 key（configs/texts 的 uiTexts）
   * @param params 模板参数（文案里写 {key}，这里给值）
   */
  static createTip(name: string, params?: TextParams) {
    this.createFloatingTip(name, params, tipsLayout.messageColor, tipsLayout.messageMoveDuration, tipsLayout.messageFadeDuration);
  }

  /**
   * 飘字公共实现（提示与错误提示只有配色与时长不同）
   * 文案一律取自 configs/texts（核心代码不写面向玩家的中文）
   */
  private static createFloatingTip(name: string, params: TextParams | undefined, color: Color, moveDuration: number, fadeDuration: number) {
    const tip = UiHelper.createTipLabel(name, getText(name, params), color, tipsLayout.fontSize, tipsLayout.size);
    // 飘字是临时装饰（屏幕中间上浮 1~3 秒，拾取/提示时高频出现），标为点击穿透：不遮挡世界点击
    markClickThrough(tip);
    const uiOpacity = tip.addComponent(UIOpacity);
    tween(tip)
      .to(moveDuration, { position: new Vec3(0, tipsLayout.risePositionY, 0) })
      .start();
    tween(uiOpacity)
      .to(fadeDuration, { opacity: 0 })
      .call(() => {
        tip.destroy();
      })
      .start();
    LayerManager.addToUILayer(tip);
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
    const style = uiTheme.floatingText.damage;
    // 受伤为红色扣血飘字，未命中（伤害 <= 0）为白色 MISS
    const text = damage > 0 ? getText("label_damage", { value: damage }) : getText("label_damage_miss");
    const damageText = UiHelper.createLabel("damage_text", text, damage > 0 ? style.color : Color.WHITE, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(damageText);
    // 位置与受伤物体保持一致
    damageText.setWorldPosition(target.getWorldPosition());
    const uiOpacity = damageText.addComponent(UIOpacity);
    tween(damageText)
      .to(style.riseDuration, { position: new Vec3(damageText.position.x, damageText.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
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
    const style = uiTheme.floatingText.skill;
    const skillTip = UiHelper.createLabel("skill_tip", getText("label_skill_release", { skill: skillName }), style.color, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(skillTip);
    // 位置在释放者头顶（上移角色身高的一半）
    const casterPosition = caster.getWorldPosition();
    skillTip.setWorldPosition(casterPosition.x, casterPosition.y + style.spawnOffsetY, casterPosition.z);
    const uiOpacity = skillTip.addComponent(UIOpacity);
    tween(skillTip)
      .to(style.riseDuration, { position: new Vec3(skillTip.position.x, skillTip.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
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
    const style = uiTheme.floatingText.exp;
    const expText = UiHelper.createLabel("exp_gain_text", getText("label_exp_gain", { exp }), style.color, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(expText);
    // 位置在被击杀怪物头顶
    const targetPosition = target.getWorldPosition();
    expText.setWorldPosition(targetPosition.x, targetPosition.y + style.spawnOffsetY, targetPosition.z);
    const uiOpacity = expText.addComponent(UIOpacity);
    tween(expText)
      .to(style.riseDuration, { position: new Vec3(expText.position.x, expText.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
      .call(() => {
        expText.destroy();
      })
      .start();
  }

  //#endregion

  //#region 悬停详情弹窗（状态/技能悬停详情的样式零件，拼装见 ui/components/dialogs/HoverTipDialog）

  /**
   * 为已有节点施加悬停详情弹窗主体样式（尺寸/背景/内边距见 configs/layout/dialogs 的 hoverTipLayout）
   * 节点自身即背景精灵（CUSTOM 模式跟随内容尺寸），纵向 Layout 容器按内容自适应高度
   */
  static applyHoverTipBodyStyle(node: Node) {
    const transform = node.addComponent(UITransform);
    transform.setContentSize(hoverTipLayout.size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    UiHelper.loadSprite(hoverTipLayout.background, (spriteFrame) => {
      if (!isValid(node) || !sprite.isValid) return;
      sprite.spriteFrame = spriteFrame;
    });
    const layout = node.addComponent(Layout);
    layout.type = Layout.Type.VERTICAL;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.padding = hoverTipLayout.padding;
    layout.spacingY = hoverTipLayout.rowSpacing;
  }

  /** 创建悬停详情标题行（左图标 + 加粗标题；无图标时标题独占整行） */
  static createHoverTipTitle(text: string, icon?: string): Node {
    const layout = hoverTipLayout.title;
    const header = this.createRow("hover_tip_header", 8, new Vec2(), new Size(hoverTipLayout.row.size.width, layout.iconSize.height));
    if (icon) header.addChild(UiHelper.createSprite("hover_tip_icon", icon, new Vec2(), layout.iconSize));
    const iconWidth = icon ? layout.iconSize.width + 8 : 0;
    const title = UiHelper.createLabel("hover_tip_title", text, Color.WHITE, layout.fontSize, new Vec2(), new Size(hoverTipLayout.row.size.width - iconWidth, layout.iconSize.height), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
    title.getComponent(Label).isBold = true;
    header.addChild(title);
    return header;
  }

  /** 创建悬停详情信息行（「名称：值」单行左对齐） */
  static createHoverTipRow(text: string): Node {
    const layout = hoverTipLayout.row;
    return UiHelper.createLabel("hover_tip_row", text, Color.WHITE, layout.fontSize, new Vec2(), layout.size, Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
  }

  /** 创建悬停详情描述（自动换行，高度按内容自适应） */
  static createHoverTipDescription(text: string): Node {
    const layout = hoverTipLayout.description;
    const node = UiHelper.createLabel("hover_tip_description", text, Color.WHITE, layout.fontSize, new Vec2(), layout.size, Label.HorizontalAlign.LEFT, Label.VerticalAlign.TOP);
    const label = node.getComponent(Label)!;
    label.lineHeight = layout.lineHeight;
    label.overflow = Label.Overflow.RESIZE_HEIGHT;
    label.enableWrapText = true;
    return node;
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
  static createDialogBg(name: string, position: Vec2 = new Vec2(), size: Size = dialogFrame.size) {
    const dialog = UiHelper.createSprite(name, dialogFrame.background, position, size);
    dialog.name = name;
    dialog.addComponent(Draggable);
    // 弹窗面板整体在鼠标通道上拦截：弹窗打开时点它任意位置（含空白处）都不再穿透到下层的 HUD
    // （关闭按钮这类只走 touch 通道的 Button 对 mouse 通道不可见，详见 utils/input/UiHit.blockClickThrough）
    blockClickThrough(dialog);
    return dialog;
  }

  /**
   * 创建游戏通用弹窗标题
   */
  static createDialogTitle(name: string, title: string, position: Vec2 = dialogFrame.title.defaultPosition) {
    return UiHelper.createLabel(name, title, dialogFrame.title.color, dialogFrame.title.fontSize, position, dialogFrame.title.defaultSize);
  }

  /**
   * 创建游戏通用关闭按钮
   */
  static createCloseButton(name: string, position: Vec2 = new Vec2(), size: Size = dialogFrame.closeButton.size) {
    return UiHelper.createButton(name, dialogFrame.closeImage, position, size);
  }

  /**
   * 创建通用弹窗
   */
  static createDialog(name: string, title: string, position: Vec2 = new Vec2(), size: Size = dialogFrame.size) {
    // 弹窗
    const dialog = this.createDialogBg(name, position, size);
    // 关闭弹窗按钮
    const inset = dialogFrame.closeButton.inset;
    const closeButton = UiHelper.createButton(`${name}_close_button`, dialogFrame.closeImage, new Vec2(size.width / 2 - inset, size.height / 2 - inset), dialogFrame.closeButton.size);
    dialog.addChild(closeButton);
    // 弹窗标题
    const titleHeight = dialogFrame.title.height;
    const dialogTitle = UiHelper.createLabel(
      `${name}_title`,
      title,
      dialogFrame.title.color,
      dialogFrame.title.fontSize,
      new Vec2(0, size.height / 2 - dialogFrame.title.insetTop),
      new Size(size.width - dialogFrame.title.widthPadding, titleHeight),
    );
    dialog.addChild(dialogTitle);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  }

  /**
   * 创建游戏大按钮
   */
  static createBigButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const bigButton = UiHelper.createButton(name, uiImages.bigButtonBackground, position, uiSize.bigButtonSize);
    bigButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, uiSize.bigButtonFontSize, new Vec2(), uiSize.bigButtonSize);
    bigButton.addChild(label);
    return bigButton;
  }

  /** 创建游戏中按钮 */
  static createMiddleButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const middleButton = UiHelper.createButton(name, uiImages.middleButtonBackground, position, uiSize.middleButtonSize);
    middleButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, uiSize.middleButtonFontSize, new Vec2(), uiSize.middleButtonSize);
    middleButton.addChild(label);
    return middleButton;
  }

  /** 创建游戏小按钮 */
  static createSmallButtion(name: string, text: string, position: Vec2 = new Vec2()) {
    const button = UiHelper.createButton(name, uiImages.smallButtonBackground, position, uiSize.smallButtonSize);
    button.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, uiSize.smallButtonFontSize, new Vec2(), uiSize.smallButtonSize);
    button.addChild(label);
    return button;
  }

  //#endregion

  //#region 战魂

  /**
   * 创建战魂等级卡片（左侧列表行）：等级 + 名称 + 激活状态，选中加金色描边
   * @param config 该等级的战魂配置
   * @param currentLevel 角色当前战魂等级（决定激活状态）
   * @param selected 是否为当前选中项
   * @param onClick 点击回调（切换选中预览）
   */
  static createSoulCard(config: SoulLevelConfig, currentLevel: number, selected: boolean, onClick: () => void) {
    const activated = config.level <= currentLevel;
    const card = UiHelper.createNode(`soul_card_${config.level}`, new Vec2(), soul.list.cardSize);
    const button = card.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 选中描边（后添加绘制在文字之下，故先加描边再加文字）
    if (selected) {
      const border = new Node("soul_card_border");
      const graphics = border.addComponent(Graphics);
      graphics.lineWidth = 2;
      graphics.strokeColor = soul.list.selectedColor;
      graphics.rect(-soul.list.cardSize.width / 2, -soul.list.cardSize.height / 2, soul.list.cardSize.width, soul.list.cardSize.height);
      graphics.stroke();
      card.addChild(border);
    }
    const nameColor = selected ? soul.list.selectedColor : activated ? Color.WHITE : soul.list.lockedColor;
    card.addChild(
      UiHelper.createLabel(
        "soul_card_label",
        `${config.level} 阶 · ${config.label}`,
        nameColor,
        soul.list.cardFontSize,
        new Vec2(-8, 0),
        new Size(soul.list.cardSize.width - 70, soul.list.cardSize.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    card.addChild(
      UiHelper.createLabel(
        "soul_card_state",
        activated ? getText("label_soul_active") : getText("label_soul_locked"),
        activated ? soul.list.activeColor : soul.list.lockedColor,
        soul.list.stateFontSize,
        new Vec2(soul.list.cardSize.width / 2 - 36, 0),
        new Size(52, soul.list.cardSize.height),
      ),
    );
    card.on(Node.EventType.TOUCH_END, onClick, this);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton），鼠标通道同样补一次命中拦截
    blockClickThrough(card);
    return card;
  }

  /**
   * 创建战魂属性列表（右侧面板）：标题 + 各属性行（有下一级时附带绿色增量）
   * @param config 展示的战魂等级配置
   * @param next 下一级配置（没有传 null，如已满级）
   */
  static createSoulAttributeList(config: SoulLevelConfig, next: SoulLevelConfig | null) {
    const column = UiHelper.createFlexCol("soul_attribute_list", soul.attribute.spacing, new Vec2(), new Size(soul.attribute.width, 0));
    column.addChild(UiHelper.createLabel("soul_attribute_title", `${config.level} 阶 · ${config.label}`, soul.attribute.titleColor, 15, new Vec2(), new Size(soul.attribute.width, 22)));
    const rows: Array<{ label: string; get: (attributes: SoulAttributes) => number | [number, number] }> = soulAttributeLabels.map((item) => ({
      label: item.label,
      get: (attributes) => attributes[item.key],
    }));
    rows.forEach((row, index) => {
      const line = UiHelper.createFlexRow(`soul_attribute_row_${index}`, 0, new Vec2(), new Size(soul.attribute.width, 18));
      line.addChild(UiHelper.createLabel("name", row.label, soul.attribute.rowNameColor, soul.attribute.fontSize, new Vec2(), new Size(40, 18), Label.HorizontalAlign.LEFT));
      const value = row.get(config.attributes);
      const diff = next ? this.formatSoulAttributeDiff(value, row.get(next.attributes)) : "";
      // 带下一级增量时整行值用绿色（白色 = 当前无增量可看）
      const text = `${this.formatSoulAttributeValue(value)}${diff ? `  ${diff}` : ""}`;
      const valueLabel = UiHelper.createLabel("value", text, diff ? soul.attribute.rowDiffColor : Color.WHITE, soul.attribute.fontSize, new Vec2(), new Size(soul.attribute.width - 40, 18), Label.HorizontalAlign.LEFT);
      line.addChild(valueLabel);
      column.addChild(line);
    });
    return column;
  }

  /** 属性值文案：数值直接显示，区间属性显示为「min ~ max」 */
  private static formatSoulAttributeValue(value: number | [number, number]) {
    return typeof value === "number" ? `${value}` : `${value[0]} ~ ${value[1]}`;
  }

  /** 下一级增量文案：数值「+N」，区间「+min~+max」（数值/区间混用时按区间补齐两侧） */
  private static formatSoulAttributeDiff(current: number | [number, number], next: number | [number, number]) {
    if (typeof current === "number" && typeof next === "number") return `+${next - current}`;
    const c = typeof current === "number" ? [current, current] : current;
    const n = typeof next === "number" ? [next, next] : next;
    return `+${n[0] - c[0]}~+${n[1] - c[1]}`;
  }

  /**
   * 创建战魂动画节点（异步加载散图帧目录后循环播放）
   * @param config 战魂等级配置
   * @param size 节点尺寸（缺省用弹窗中间展示尺寸；挂到主角身上的外显传小尺寸）
   */
  static createSoulAnimation(config: SoulLevelConfig, size: Size = soul.animation.size) {
    const node = UiHelper.createNode("soul_animation", new Vec2(), size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    AnimationHelper.loadFrames(config.animation).then((frames) => {
      if (!isValid(node) || !frames.length) return;
      AnimationHelper.playLoopWithFrames("soul_stand", node, frames, config.animationFrameRate);
    });
    return node;
  }

  /**
   * 创建战魂外显勾选框（小方框 + 对勾 + 「外显」文字；点击回调带回切换后的状态）
   * 勾选状态由调用方传入（弹窗整体刷新式重建，状态以角色数据 role.soulShow 为准）
   */
  static createSoulShowToggle(checked: boolean, onClick: (checked: boolean) => void) {
    const toggle = soul.info.toggle;
    const half = toggle.boxSize / 2;
    const node = UiHelper.createNode("soul_show_toggle", new Vec2(), toggle.size);
    const button = node.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 勾选框（小方框，勾选时填充金色并画对勾）
    const box = new Node("soul_show_box");
    box.addComponent(UITransform).setContentSize(toggle.boxSize, toggle.boxSize);
    box.setPosition(-toggle.size.width / 2 + half, 0);
    const graphics = box.addComponent(Graphics);
    graphics.lineWidth = 1.5;
    graphics.strokeColor = checked ? soul.list.selectedColor : soul.list.lockedColor;
    graphics.fillColor = checked ? soul.list.selectedColor : Color.WHITE;
    graphics.rect(-half, -half, toggle.boxSize, toggle.boxSize);
    graphics.fill();
    graphics.stroke();
    if (checked) {
      box.addChild(UiHelper.createLabel("soul_show_check", "✓", Color.WHITE, toggle.fontSize, new Vec2(), new Size(toggle.boxSize, toggle.boxSize)));
    }
    node.addChild(box);
    node.addChild(UiHelper.createLabel("soul_show_text", toggle.text, Color.WHITE, toggle.fontSize, new Vec2(toggle.textGap, 0), new Size(60, toggle.size.height), Label.HorizontalAlign.LEFT));
    node.on(Node.EventType.TOUCH_END, () => onClick(!checked), this);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton），鼠标通道同样补一次命中拦截
    blockClickThrough(node);
    return node;
  }

  //#endregion

  //#region 称号

  /**
   * 创建称号等级卡片（左侧列表行）：等级 + 名称 + 激活状态，选中加金色描边（与战魂卡片同一套样式）
   * @param config 该等级的称号配置
   * @param currentLevel 角色当前称号等级（决定激活状态）
   * @param selected 是否为当前选中项
   * @param onClick 点击回调（切换选中预览）
   */
  static createTitleCard(config: TitleLevelConfig, currentLevel: number, selected: boolean, onClick: () => void) {
    const activated = config.level <= currentLevel;
    const card = UiHelper.createNode(`title_card_${config.level}`, new Vec2(), titleUpgradeDialogLayout.list.cardSize);
    const button = card.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 选中描边（后添加绘制在文字之下，故先加描边再加文字）
    if (selected) {
      const border = new Node("title_card_border");
      const graphics = border.addComponent(Graphics);
      graphics.lineWidth = 2;
      graphics.strokeColor = titleUpgradeDialogLayout.list.selectedColor;
      graphics.rect(-titleUpgradeDialogLayout.list.cardSize.width / 2, -titleUpgradeDialogLayout.list.cardSize.height / 2, titleUpgradeDialogLayout.list.cardSize.width, titleUpgradeDialogLayout.list.cardSize.height);
      graphics.stroke();
      card.addChild(border);
    }
    const nameColor = selected ? titleUpgradeDialogLayout.list.selectedColor : activated ? Color.WHITE : titleUpgradeDialogLayout.list.lockedColor;
    card.addChild(
      UiHelper.createLabel(
        "title_card_label",
        `${config.level} 阶 · ${config.label}`,
        nameColor,
        titleUpgradeDialogLayout.list.cardFontSize,
        new Vec2(-8, 0),
        new Size(titleUpgradeDialogLayout.list.cardSize.width - 70, titleUpgradeDialogLayout.list.cardSize.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    card.addChild(
      UiHelper.createLabel(
        "title_card_state",
        activated ? getText("label_title_active") : getText("label_title_locked"),
        activated ? titleUpgradeDialogLayout.list.activeColor : titleUpgradeDialogLayout.list.lockedColor,
        titleUpgradeDialogLayout.list.stateFontSize,
        new Vec2(titleUpgradeDialogLayout.list.cardSize.width / 2 - 36, 0),
        new Size(52, titleUpgradeDialogLayout.list.cardSize.height),
      ),
    );
    card.on(Node.EventType.TOUCH_END, onClick, this);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton），鼠标通道同样补一次命中拦截
    blockClickThrough(card);
    return card;
  }

  /**
   * 创建称号属性列表（右侧面板）：标题 + 各属性行（有下一级时附带绿色增量），与战魂属性表同一套格式
   * @param config 展示的称号等级配置
   * @param next 下一级配置（没有传 null，如已满级）
   */
  static createTitleAttributeList(config: TitleLevelConfig, next: TitleLevelConfig | null) {
    const column = UiHelper.createFlexCol("title_attribute_list", titleUpgradeDialogLayout.attribute.spacing, new Vec2(), new Size(titleUpgradeDialogLayout.attribute.width, 0));
    column.addChild(UiHelper.createLabel("title_attribute_title", `${config.level} 阶 · ${config.label}`, titleUpgradeDialogLayout.attribute.titleColor, 15, new Vec2(), new Size(titleUpgradeDialogLayout.attribute.width, 22)));
    const rows: Array<{ label: string; get: (attributes: TitleAttributes) => number | [number, number] }> = titleAttributeLabels.map((item) => ({
      label: item.label,
      get: (attributes) => attributes[item.key],
    }));
    rows.forEach((row, index) => {
      const line = UiHelper.createFlexRow(`title_attribute_row_${index}`, 0, new Vec2(), new Size(titleUpgradeDialogLayout.attribute.width, 18));
      line.addChild(UiHelper.createLabel("name", row.label, titleUpgradeDialogLayout.attribute.rowNameColor, titleUpgradeDialogLayout.attribute.fontSize, new Vec2(), new Size(40, 18), Label.HorizontalAlign.LEFT));
      const value = row.get(config.attributes);
      const diff = next ? this.formatSoulAttributeDiff(value, row.get(next.attributes)) : "";
      // 带下一级增量时整行值用绿色（白色 = 当前无增量可看）
      const text = `${this.formatSoulAttributeValue(value)}${diff ? `  ${diff}` : ""}`;
      const valueLabel = UiHelper.createLabel("value", text, diff ? titleUpgradeDialogLayout.attribute.rowDiffColor : Color.WHITE, titleUpgradeDialogLayout.attribute.fontSize, new Vec2(), new Size(titleUpgradeDialogLayout.attribute.width - 40, 18), Label.HorizontalAlign.LEFT);
      line.addChild(valueLabel);
      column.addChild(line);
    });
    return column;
  }

  /**
   * 创建称号动画节点（异步加载散图帧目录后循环播放；头顶外显与弹窗中间展示共用）
   * 名牌帧带字（如「飞龙在天」）且各称号宽窄不一，一律**按素材原始尺寸显示（不缩放）**：
   * 头顶那份交给头部信息栏的纵向布局排位置，弹窗那份直接放进动画槽位
   * @param config 称号等级配置
   * @param size 节点初始尺寸（RAW 模式加载首帧后会被原始尺寸覆盖，仅占位）
   */
  static createTitleAnimation(config: TitleLevelConfig, size: Size = titleUpgradeDialogLayout.animation.size) {
    const node = UiHelper.createNode("title_animation", new Vec2(), size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    AnimationHelper.loadFrames(config.animation).then((frames) => {
      if (!isValid(node) || !frames.length) return;
      AnimationHelper.playLoopWithFrames("title_loop", node, frames, config.animationFrameRate);
    });
    return node;
  }

  //#endregion

  //#region 物品

  // 在某个格子上创建物品
  static createGood(cell: Node, good: Goods) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    cell.addChild(sprite);
    // 装备边框（前后缀决定的品质光效，背包与身上装备槽同一入口）：挂在**图标**节点上而不是格子下——
    // 拖动压暗源格图标时边框一起变暗（边框是图标的子节点、随 UIOpacity 一起变淡），
    // 格子刷新销毁图标时边框也随子节点一起销毁，不必单独清理
    this.applyEquipmentBorder(sprite, good);
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        // 摆放坐标由 createGoodDetailDialog 按「格子世界坐标 − UI 层世界坐标」现算（屏幕中心系）
        const detailDialog = this.createGoodDetailDialog(good, cell);
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
   * 给物品图标挂上装备边框（仅装备有；前后缀 → 边框的映射与特殊装备的自定义表在 configs/border）
   *
   * 边框是循环播放的图集帧动画（resources/borders），挂在物品图标节点上、画在图标之上；
   * 各边框图集的原始尺寸不一（6 个尺寸家族），帧加载完成后按首帧原始宽高把节点缩进统一的外框
   * （equipmentBorderLayout.size，contain 保持各自宽高比），再交给 playLoopAtlas 循环播放
   *
   * @param icon 物品图标节点（边框作为它的子节点：随图标一起被压暗/销毁）
   * @param good 物品数据（非装备或没分配到边框时不显示）
   */
  static applyEquipmentBorder(icon: Node, good: Goods) {
    if (!isEquipment(good)) return;
    const borderKey = getEquipmentBorderKey(good);
    const resource = borderKey ? borders.get(borderKey) : null;
    if (!resource) return;
    const border = this.createEquipmentBorder(borderKey);
    icon.addChild(border);
    // 帧异步加载：加载完成后先定尺寸再播放（期间节点可能已被销毁——背包刷新、弹窗关闭都会重建边框）
    AnimationHelper.loadFramesFromAtlas(resource.atlas).then((frames) => {
      if (!isValid(border) || !frames.length) return;
      this.fitNodeToBox(border, frames[0], equipmentBorderLayout.size);
      AnimationHelper.playLoopAtlas(border.name, border, resource.atlas, equipmentBorderLayout.frameRate);
    });
  }

  /**
   * 创建装备边框零件（空精灵 + 动画组件，帧由 applyEquipmentBorder 异步装载）
   *
   * trim 必须为 true：这批边框图集「未裁剪但每帧 offset 全部非 0」，而 offset 只在 trim=false 的
   * 逆向补边路径里生效（引擎 simple 装配器按 trimmedBorder 平移整帧画面，非 0 的 offset 会把
   * 边框整体挪出节点框）；trim=true 时画面取 rect 全帧、完全不看 offset，未裁剪素材的 rect
   * 尺寸 == 原始尺寸，正好铺满节点框且不会变形（test-equipment-border.cjs 有断言盯住这一点）
   */
  static createEquipmentBorder(borderKey: string) {
    const border = UiHelper.createSprite(`${equipmentBorderLayout.namePrefix}${borderKey}`, "", new Vec2(), equipmentBorderLayout.size);
    const sprite = border.getComponent(Sprite)!;
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = true;
    border.addComponent(Animation);
    return border;
  }

  /**
   * 把节点的内容尺寸按 contain 缩进外框（保持素材宽高比，最长的边贴到外框）
   * 用于原始尺寸各异的图集动画（边框 6 个尺寸家族共用一个显示口径，见 configs/layout/borders）
   */
  static fitNodeToBox(node: Node, frame: SpriteFrame, box: Size) {
    const source = frame.originalSize;
    const transform = node.getComponent(UITransform);
    if (!source.width || !source.height || !transform) return;
    const scale = Math.min(box.width / source.width, box.height / source.height);
    transform.setContentSize(source.width * scale, source.height * scale);
  }

  /**
   * 给装备详情弹窗挂上背景动画（仅装备有；前后缀 → 背景的映射与特殊装备的自定义表在 configs/background）
   *
   * 背景是循环播放的帧序列目录动画（resources/backgrounds），直接换**弹窗自身**的 spriteFrame：
   * 不是子节点 —— 弹窗是 Layout 容器，背景若作为子节点会被当成一行参与排版、还会撑高容器；
   * 换自身帧则完全不吃排版，且弹窗尺寸由内容自适应（ResizeMode.CONTAINER）、
   * 精灵 sizeMode 为 CUSTOM，背景始终铺满整个面板。
   * 精灵的 trim 必须保持 createSprite 的缺省 false：这批帧按 auto-trim 导入（裁剪 + 非 0 offset），
   * trim=false 时引擎按 offset 把裁剪内容贴回原始画布 —— 各帧画布一致（单测有断言）、画面帧间不跳；
   * 若改成 trim=true 则只画裁剪矩形并拉伸到面板，每帧裁剪范围不同会导致画面抖动。
   * 加载完成前先显示静态底图（创建时已设），
   * 未分配到背景的装备（含非装备物品）保持静态底图不变
   *
   * @param dialog 详情弹窗节点
   * @param good 物品数据（非装备或没分配到背景时不显示）
   */
  static applyEquipmentDetailBackground(dialog: Node, good: Goods) {
    if (!isEquipment(good)) return;
    const backgroundKey = getEquipmentDetailBackgroundKey(good);
    const resource = backgroundKey ? detailBackgrounds.get(backgroundKey) : null;
    if (!resource) return;
    AnimationHelper.playLoopDir(`${equipmentDetailBackgroundLayout.namePrefix}${backgroundKey}`, dialog, resource.dir, equipmentDetailBackgroundLayout.frameRate);
  }

  /**
   * 创建物品详情弹窗（鼠标悬停在物品上时显示，背包格子与身上装备槽共用）
   *
   * 摆放：位置一律用**屏幕中心系坐标**（锚点世界坐标 − UI 层世界坐标，与 UI 层各常驻组件同口径），
   * 再交给 `ScreenLayout.getPopupPosition` 算 —— 竖直与物品同高居中、水平放物品靠屏幕中间那一侧、
   * 最后整块夹进可见区（弹窗比物品大得多，贴外侧摆会被裁掉一半）。
   * 这里**不能**用相机 worldToScreen 的像素坐标减设计分辨率：两个口径差一个 view 缩放系数，
   * 算出来的位置会严重偏移（这个 bug 修过一次，见 utils/layout/ScreenLayout.getPopupPosition 的注释）。
   *
   * 弹窗自身高度由 Layout 自适应（ResizeMode.CONTAINER），首帧量到的是配置里的占位高度，
   * 内容撑开后才准，所以尺寸一变就用最终尺寸重算一次位置（幂等，内容稳定后不再动）。
   *
   * @param good 物品数据
   * @param anchor 物品格节点（摆放与尺寸都以它为准）
   */
  static createGoodDetailDialog(good: Goods, anchor: Node) {
    const dialog = UiHelper.createSprite(goodDetailLayout.name, goodDetailLayout.background, new Vec2(), goodDetailLayout.size);
    // 装备详情背景（前后缀决定的品质背景动画）：换弹窗自身精灵的帧，加载完成前先显示静态底图
    this.applyEquipmentDetailBackground(dialog, good);

    const layout = dialog.addComponent(Layout);
    layout.type = Layout.Type.GRID;
    layout.alignHorizontal = true;
    layout.spacingY = goodDetailLayout.rowSpacing;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.padding = goodDetailLayout.padding;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;

    // 头部
    const contentHeader = UiHelper.createFlexRow("header", goodDetailLayout.headerSpacing, new Vec2(), new Size(220, 40));
    // 图标
    const goodImage = UiHelper.createSprite("good_image", good.icon, new Vec2(), new Size(40, 40));
    // 标题（装备 = 前缀 + 名称 + 后缀 三段着色：前缀/名称用前缀色、后缀用后缀色；其他物品单行白字）
    let title: Node;
    if (isEquipment(good)) {
      const parts = getEquipmentNameParts(good);
      const titleRow = UiHelper.createFlexRow("good_detail_title", 2, new Vec2(), new Size(goodDetailLayout.title.size.width, goodDetailLayout.title.size.height));
      const mkTitleLabel = (name: string, text: string, color: Color) => {
        const node = UiHelper.createLabel(name, text, color, goodDetailLayout.title.fontSize, new Vec2(), new Size(10, goodDetailLayout.title.size.height), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
        const label = node.getComponent(Label)!;
        // 宽度随文字自适应（Overflow.NONE），由横向 Layout 依次排开；行高 40 保持与图标垂直居中
        label.overflow = Label.Overflow.NONE;
        label.isBold = true;
        return node;
      };
      titleRow.addChild(mkTitleLabel("good_detail_title_prefix", parts.prefix.label, parts.prefix.color));
      titleRow.addChild(mkTitleLabel("good_detail_title_name", parts.label, parts.prefix.color));
      titleRow.addChild(mkTitleLabel("good_detail_title_suffix", parts.suffix.label, parts.suffix.color));
      title = titleRow;
    } else {
      title = UiHelper.createLabel(
        "good_detail_title",
        good.label,
        Color.WHITE,
        goodDetailLayout.title.fontSize,
        new Vec2(),
        new Size(goodDetailLayout.title.size.width, goodDetailLayout.title.size.height),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.TOP,
      );
      const titleLabel = title.getComponent(Label)!;
      titleLabel.enableWrapText = true;
      titleLabel.lineHeight = goodDetailLayout.title.lineHeight;
      titleLabel.isBold = true;
    }

    contentHeader.addChild(goodImage);
    contentHeader.addChild(title);

    // 基础信息行（装备专属：穿戴等级与部位；前后缀变体与基础件同等级，门槛一致）
    const infoLayout = goodDetailLayout.info;
    const contentInfo = isEquipment(good)
      ? UiHelper.createLabel(
          "good_detail_info",
          getText("label_good_detail_info", { level: good.level, slot: equipmentSlots.get(good.slot)?.label ?? getText("label_good_slot_fallback") }),
          infoLayout.color,
          infoLayout.fontSize,
          new Vec2(),
          infoLayout.size,
          Label.HorizontalAlign.LEFT,
          Label.VerticalAlign.CENTER,
        )
      : null;

    // 回收价行（装备专属：背包「一键回收」按它结算，货币为绑定元宝；前后缀变体的价已随倍率缩放）
    const recycleLayout = goodDetailLayout.recycle;
    const contentRecycle = isEquipment(good)
      ? UiHelper.createLabel(
          "good_detail_recycle",
          getText("label_good_detail_recycle", { price: getRecyclePrice(good) }),
          recycleLayout.color,
          recycleLayout.fontSize,
          new Vec2(),
          recycleLayout.size,
          Label.HorizontalAlign.LEFT,
          Label.VerticalAlign.CENTER,
        )
      : null;

    // 标签行（装备专属：显示在名称正下方，与其他物品区分开）
    const contentTags = isEquipment(good) ? this.createGoodTagRow(good.tags ?? []) : null;

    // 介绍
    const descLayout = goodDetailLayout.description;
    const contentDescription = UiHelper.createLabel("content_description", good.description, Color.WHITE, descLayout.fontSize, new Vec2(), descLayout.size);
    const descLabel = contentDescription.getComponent(Label);
    descLabel.lineHeight = descLayout.lineHeight;
    descLabel.enableWrapText = true;
    descLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    descLabel.overflow = Label.Overflow.RESIZE_HEIGHT;

    // 属性列表（装备按槽位显示战斗属性）
    const contentBody = UiHelper.createFlexCol("content_body", 3, new Vec2(), new Size(220, 220));
    contentBody.getComponent(Layout).resizeMode = Layout.ResizeMode.CONTAINER;
    if (isEquipment(good)) {
      (goodShowAttributes.get(good.slot) ?? []).forEach((attr) => {
        contentBody.addChild(this.createAttributeLabel(attr, good[attr]));
      });
    }

    dialog.addChild(contentHeader);
    if (contentInfo) dialog.addChild(contentInfo);
    if (contentRecycle) dialog.addChild(contentRecycle);
    if (contentTags) dialog.addChild(contentTags);
    dialog.addChild(contentDescription);
    dialog.addChild(contentBody);

    // 脚步图标（图片来源与尺寸见 configs/layout/dialogs.goodDetailLayout.footerLogo）
    const footerLogo = UiHelper.createSprite("logo", goodDetailLayout.footerLogo.image, new Vec2(), goodDetailLayout.footerLogo.size);
    dialog.addChild(footerLogo);

    // 摆放：锚点恒为 0.5/0.5（内容排版交给上面的 Layout，动锚点会让 Layout 按新锚点重排而错位）
    const anchorWorld = anchor.getWorldPosition();
    const layerWorld = LayerManager.UILayer.getWorldPosition();
    const anchorCenter = new Vec2(anchorWorld.x - layerWorld.x, anchorWorld.y - layerWorld.y);
    const anchorSize = anchor.getComponent(UITransform)?.contentSize ?? goodDetailLayout.size;
    this.placeGoodDetailDialog(dialog, anchorCenter, anchorSize);
    // 自适应高度撑开后按最终尺寸复夹一次（可能来两三帧，每次都按当前尺寸重算，内容稳定后不再变）
    dialog.on(
      Node.EventType.SIZE_CHANGED,
      () => {
        if (isValid(dialog)) this.placeGoodDetailDialog(dialog, anchorCenter, anchorSize);
      },
      this,
    );
    return dialog;
  }

  /**
   * 把物品详情弹窗摆到物品旁（尽量靠屏幕中间且整块都在可见区内，规则见 ScreenLayout.getPopupPosition）
   * 独立成方法是为了「首帧按占位高度摆 + Layout 撑开后再按最终尺寸复夹」两处共用同一套算法
   */
  private static placeGoodDetailDialog(dialog: Node, anchorCenter: Vec2, anchorSize: Size) {
    const transform = dialog.getComponent(UITransform);
    if (!transform) return;
    const position = getPopupPosition(
      anchorCenter,
      anchorSize,
      transform.contentSize,
      getVisibleSize(),
      goodDetailLayout.placement.gap,
      goodDetailLayout.placement.screenMargin,
    );
    dialog.setPosition(position.x, position.y, 0);
  }

  /**
   * 创建属性标签
   * @param value 属性值：装备是固定值 [v, v]、角色等级属性是浮动区间 [min, max]
   */
  static createAttributeLabel(key: keyof BattleAttributes, value: readonly number[] | number, size: Size = new Size(220, 20)) {
    const attributeLabel = UiHelper.createFlexRow(key, 10, new Vec2(), size);

    const icon = UiHelper.createSprite("icon", uiImages.dot, new Vec2(), new Size(10, 10));
    attributeLabel.addChild(icon);

    const label = UiHelper.createLabel(key, goodShowAttributesLabel.get(key), Color.WHITE, 12, new Vec2(), new Size(50, size.height));
    label.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    attributeLabel.addChild(label);

    const attribute = UiHelper.createLabel(key, this.formatAttributeValue(value), Color.WHITE, 12, new Vec2(), new Size(size.width - 20 - 50 - 10, size.height));
    attributeLabel.addChild(attribute);

    return attributeLabel;
  }

  /**
   * 属性值格式化
   * 区间两端相同时只显示一个数（装备是固定值，显示「120 - 120」没有意义），
   * 两端不同才显示区间（角色等级属性是 [上限×0.7, 上限] 的浮动区间）
   */
  static formatAttributeValue(value: readonly number[] | number): string {
    if (typeof value === "number") return String(value);
    return value[0] === value[1] ? String(value[0]) : `${value[0]} - ${value[1]}`;
  }

  /**
   * 创建装备标签行（标签逐条横排，占名称下方一整行）
   * 无标签时返回空行：保持"名称下方固定有一行标签"的排版位置不随标签有无而跳动
   */
  static createGoodTagRow(tags: string[], size: Size = goodTag.rowSize) {
    const row = UiHelper.createFlexRow("good_tags", goodTag.spacing, new Vec2(), size);
    tags.forEach((tag, index) => {
      // 每条标签按字数给宽（中文字宽≈字号），避免长标签被 CLAMP 截断
      const width = Math.max(goodTag.minWidth, tag.length * goodTag.fontSize + goodTag.paddingX);
      row.addChild(UiHelper.createLabel(`good_tag_${index}`, tag, goodTag.color, goodTag.fontSize, new Vec2(), new Size(width, size.height)));
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
  static applyRoleAttributeListStyle(node: Node, role: Role, position: Vec2 = roleAttributeListLayout.position, size: Size = roleAttributeListLayout.size) {
    const layout = this.applyColumnStyle(node, roleAttributeListLayout.spacing, position, size);
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    layout.padding = roleAttributeListLayout.padding;
    node.getComponent(UITransform).setAnchorPoint(0.5, 1);
    // 重复调用即刷新（装备穿脱等改变属性后重建条目，旧条目真正销毁）
    clearChildren(node);
    node.addChild(this.createText("role_basic_attributes", getText("label_attributes_base"), 14, new Vec2(), new Size(size.width, roleAttributeListLayout.titleHeight)));
    for (const element of goodShowAttributesLabel.keys()) {
      node.addChild(this.createAttributeLabel(element, role[element], new Size(size.width, roleAttributeListLayout.rowHeight)));
    }
    node.addChild(this.createText("role_special_attributes", getText("label_attributes_special"), 14, new Vec2(), new Size(size.width, roleAttributeListLayout.titleHeight)));
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
    AnimationHelper.playOnceWithDir("upgrade", upgrade, uiImages.upgradeEffect, 1);
    return upgrade;
  }

  //#endregion

  //#region 背包

  /** 创建背包格子 */
  static createRoleBagCell(row: number, col: number) {
    return UiHelper.createSprite(`bag_slot_${row}_${col}`, bagGridLayout.cellImage, new Vec2(), bagGridLayout.cellSize);
  }

  /** 创建背包格子行（在 parent 下逐行生成格子并返回 [行][列] 索引） */
  static createRoleBagCellRow(parent: Node) {
    const cells = [];
    for (let row = 0; row < bagRow; row++) {
      cells[row] = [];
      const rowNode = UiHelper.createFlexRow(`bag_row_${row}`, bagGridLayout.rowSpacing, new Vec2(0, 0), bagGridLayout.rowSize);
      parent.addChild(rowNode);
      for (let col = 0; col < bagCol; col++) {
        const cell = this.createRoleBagCell(row, col);
        rowNode.addChild(cell);
        cells[row][col] = cell;
      }
    }
    return cells;
  }

  /**
   * 创建拖动时跟随指针的「幽灵」图标（半透明，表示这是被提起来的一个影子）
   * 标为点击穿透：它跟着指针盖在界面上，不该参与「点是否落在 UI 上」的判定（见 utils/input/UiHit）
   */
  static createBagDragGhost(icon: string) {
    const style = bagGridLayout.drag;
    const ghost = UiHelper.createSprite("bag_drag_ghost", icon, new Vec2(), style.ghostSize);
    this.setNodeOpacity(ghost, style.ghostOpacity);
    markClickThrough(ghost);
    return ghost;
  }

  /** 创建拖动落点高亮框（描边空框；拖动中被摆到指针下的格子上，取消/落子后连同节点销毁） */
  static createBagDragHighlight() {
    const style = bagGridLayout.drag;
    const node = UiHelper.createNode("bag_drag_highlight", new Vec2(), style.highlightSize);
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = style.highlightLineWidth;
    graphics.strokeColor = style.highlightColor;
    // 描边从尺寸边缘内缩，免得和格子底图的外框重叠
    const halfWidth = style.highlightSize.width / 2 - style.highlightInset;
    const halfHeight = style.highlightSize.height / 2 - style.highlightInset;
    graphics.rect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
    graphics.stroke();
    markClickThrough(node);
    return node;
  }

  /**
   * 让节点跟随屏幕坐标（把屏幕点换算成 node 父节点坐标系下的位置再赋给 node）
   * 用于拖动中的幽灵图标：它挂在弹窗（或其子容器）下，而弹窗自己也可能被拖过，所以一律走世界坐标换算
   * @param node 要跟随的节点（必须已在场景里，即已有父节点）
   * @param screenPoint 屏幕坐标（与 UITransform.hitTest 同一口径，见 utils/input/Pointer）
   */
  static followScreenPoint(node: Node, screenPoint: Vec3) {
    const parent = node.parent;
    if (!parent || !isValid(parent)) return;
    const transform = parent.getComponent(UITransform);
    if (!transform) return;
    const local = transform.convertToNodeSpaceAR(GameHelper.screenPositionToWorldPosition(screenPoint), new Vec3());
    node.setPosition(local.x, local.y);
  }

  /** 把节点摆到目标节点的位置上（同一父节点坐标系；拖动落点高亮用） */
  static alignNodeToNode(node: Node, target: Node) {
    const parent = node.parent;
    if (!parent || !isValid(target)) return;
    const transform = parent.getComponent(UITransform);
    if (!transform) return;
    const local = transform.convertToNodeSpaceAR(target.getWorldPosition(), new Vec3());
    node.setPosition(local.x, local.y);
  }

  /** 设置节点不透明度（没有 UIOpacity 就补一个；拖动压暗源格物品与恢复都用它） */
  static setNodeOpacity(node: Node | null, opacity: number) {
    if (!node || !isValid(node)) return;
    const uiOpacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    uiOpacity.opacity = opacity;
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
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截
    blockClickThrough(node);
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

  /** 为已有节点施加底部栏主体样式（尺寸与背景见 hudLayout.bottomBar），节点由底部栏组件自身充当 */
  static applyBottomBarBodyStyle(node: Node) {
    node.addComponent(UITransform).setContentSize(bottomBarLayout.size);
    this.setBottomBarPosition(node);
    node.addChild(UiHelper.createSprite("bottom_nav_bar_background", uiImages.bottomBarBackground, new Vec2(), bottomBarLayout.size));
  }

  /** 底部栏贴边定位（贴屏幕底部居中；窗口尺寸变化时可重复调用，见 ui/utils/layout/ScreenLayout） */
  static setBottomBarPosition(node: Node) {
    const { anchor } = bottomBarLayout;
    const position = getAnchoredPosition(bottomBarLayout.size, getVisibleSize(), anchor.edge, anchor.marginX, anchor.marginY);
    node.setPosition(position.x, position.y, 0);
  }

  /** 创建血量/魔法值文字零件（位置与尺寸见 hudLayout.bottomBar.hpText / mpText） */
  static createHpText(text: string, position: Vec2 = new Vec2(), size: Size = bottomBarLayout.hpText.size, name = "hp_text") {
    return UiHelper.createLabel(name, text, Color.WHITE, bottomBarLayout.hpText.fontSize, position, size);
  }

  /**
   * 创建圆形血量/魔法值显示零件（底图 + 竖向进度条）
   * 返回底图节点与其内部的进度条节点，位置与尺寸见 hudLayout.bottomBar.hpOrb / mpOrb
   * 底图见 uiImages.hpOrbBase；填充图缺省为 uiImages.hpOrbFill，魔法球传 uiImages.mpOrbFill
   */
  static createRoundHpBar(progress: number, position: Vec2 = new Vec2(), size: Size = bottomBarLayout.hpOrb.size, fillImage: string = uiImages.hpOrbFill): { barSprite: Node; hpBar: Node } {
    const barSprite = UiHelper.createSprite("hp_bar_sprite", uiImages.hpOrbBase, position, size);
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

  /**
   * 创建怪物头顶信息栏（只有血条与血量文字；名称单独显示在身体正中心，见 createMonsterName）
   * 位置在怪物上缘之外一点：怪物节点锚点居中（即身体中心），按 contentSize 高度的一半上移
   * 结构固定：children[0]=血条 children[1]=血量文字（MonsterManager.updateHead 按此刷新）
   */
  static createMonsterHead(monster: Monster) {
    const head = UiHelper.createFlexCol("monster_head", 3, new Vec2(0, monster.contentSize.height / 2 + 14), new Size(100, 0));
    head.getComponent(UITransform).setAnchorPoint(0.5, 0);
    const hpBar = this.createHpBar("monster_hp_bar", monster.hp / monster.maxHp, new Vec2(), new Size(80, 4));
    head.addChild(hpBar);
    const hpText = UiHelper.createLabel("monster_hp_text", `${monster.hp} / ${monster.maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(hpText);
    return head;
  }

  /**
   * 创建怪物名称（显示在怪物正中心：怪物节点锚点居中，名称挂在原点即身体中心）
   * 主动攻击的怪物红色、不主动攻击的黄色（aggressive，见 types/monster）
   */
  static createMonsterName(monster: Monster) {
    const color = monster.aggressive ? Color.RED : Color.YELLOW;
    return UiHelper.createLabel("monster_name", monster.label, color, 12, new Vec2(), new Size(120, 14));
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
    const color = kind === "role" ? rangeStyle.roleColor : rangeStyle.obstacleColor;
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
    return this.drawRange(node, uiTransform.contentSize, new Vec2(), rangeStyle.areaColor, name ?? node.name);
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
    graphics.lineWidth = rangeStyle.lineWidth;
    graphics.strokeColor = color;
    graphics.fillColor = new Color(color.r, color.g, color.b, rangeStyle.fillAlpha);
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
          rangeStyle.nameFontSize,
          new Vec2(),
          rangeStyle.nameSize,
        ),
      );
    return view;
  }

  //#endregion

  //#region 怪物信息面板

  /**
   * 为已有节点施加怪物信息面板主体样式（尺寸、位置与背景见 hudLayout.monsterInfoPanel），节点由面板组件自身充当
   * 背景资源见 uiImages.monsterInfoBackground
   */
  static applyMonsterInfoBodyStyle(node: Node) {
    node.addComponent(UITransform).setContentSize(monsterInfoPanelLayout.size);
    node.setPosition(monsterInfoPanelLayout.position.x, monsterInfoPanelLayout.position.y, 0);
    node.addChild(UiHelper.createSprite("monster_info_background", uiImages.monsterInfoBackground, new Vec2(), monsterInfoPanelLayout.size));
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
   * 为已有节点施加小地图主体样式（尺寸见 hudLayout.smallMap），节点由小地图组件自身充当
   * 尺寸需容纳「左侧功能按钮列 + 名称条/地图/标签/坐标条」整块内容（子节点位置以地图内容区中心为原点）
   */
  static applySmallMapBodyStyle(node: Node) {
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(smallMapLayout.size);
    this.setSmallMapPosition(node);
  }

  /** 小地图贴边定位（贴屏幕右上角；窗口尺寸变化时可重复调用，见 ui/utils/layout/ScreenLayout） */
  static setSmallMapPosition(node: Node) {
    const { anchor } = smallMapLayout;
    const position = getAnchoredPosition(smallMapLayout.size, getVisibleSize(), anchor.edge, anchor.marginX, anchor.marginY);
    node.setPosition(position.x, position.y, 0);
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

  /**
   * 创建路线指示线绘制层（自动寻路时的路线；小地图与预览弹窗共用，坐标为相对内容区中心）
   * 与坐标点层分开：路线每帧变（角色在移动），点位有各自的刷新节奏，两者互不干扰
   */
  static createSmallMapRouteLayer(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_route", position, size);
    return node.addComponent(Graphics);
  }

  /**
   * 在绘制层上重绘路线指示线（传入已换算到本绘制层的坐标点，起点即角色所在点）
   * 画法为「点状线」：沿折线按弧长等距铺一串圆点，最后在终点画一个更大的圆点；
   * 跨折点用「余量结转」保证两段交界处的点间距与本段一致，不会在拐角处挤成一坨；
   * 每个圆点内部自带 moveTo（引擎 helper.ellipse 实现），所以点与点之间不会被连成多边形
   * @param points 路线坐标点（本绘制层坐标系，至少 1 个点）
   * @param style 样式（颜色 / 点半径 / 点间距 / 终点半径）
   */
  static drawRouteLine(graphics: Graphics, points: Vec2[], style: RouteLineStyle) {
    graphics.clear();
    if (points.length === 0) return;
    const radius = Math.max(0.5, style.dotRadius);
    // 间距至少为点直径 + 1，避免配置写小了把点状线画成一条实线
    const gap = Math.max(style.dotGap, radius * 2 + 1);
    graphics.fillColor = style.color;
    if (points.length > 1) {
      /** 本段第一个点距段首的距离（跨段结转，保证折点两侧的点间距均匀） */
      let carried = 0;
      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length <= 0) continue;
        // 本段比待走的距离还短：一个点都放不下，把待走距离扣掉后直接进下一段
        if (carried > length) {
          carried -= length;
          continue;
        }
        for (let offset = carried; offset <= length; offset += gap) {
          const ratio = offset / length;
          graphics.circle(from.x + dx * ratio, from.y + dy * ratio, radius);
          graphics.fill();
        }
        // 段末距本段最后一个点的余量 → 折算成下一段从段首起多远放点
        carried = gap - ((length - carried) % gap);
      }
    }
    // 终点圆点：比途中的点大一圈，标出目的地
    const end = points[points.length - 1];
    graphics.circle(end.x, end.y, style.endDotRadius);
    graphics.fill();
  }

  //#endregion

  /**
   * 创建小地图静态标记层（占满内容区的空节点，作为预览图的子节点）
   * 与坐标点层分开：标记（NPC 白点 + 名称、刷怪区名称）只随地图变化建一次，
   * 坐标点（角色/怪物）每帧节流重绘，互不干扰；标记永远盖在动态点上
   */
  static createSmallMapMarkerLayer(position: Vec2, size: Size) {
    return UiHelper.createNode("small_map_markers", position, size);
  }

  /**
   * 创建小地图底图视口（内容区大小的裁剪容器，常驻 HUD 用）
   * Mask 的裁剪范围即本节点内容尺寸：底图可远大于内容区（整张地图预览图），
   * 但只露出角色周围一块，不会溢出到名称条/功能按钮上
   */
  static createSmallMapMapView(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_view", position, size);
    node.addComponent(Mask);
    return node;
  }

  /**
   * 创建小地图底图（真实地图预览图）
   * 节点尺寸先按传入值建立，实际显示尺寸由组件按「地图像素尺寸 × 小地图缩放」实时设置，
   * 因此节点自带 UITransform 且 sprite 为 CUSTOM 尺寸模式，方便逐帧改尺寸与缩放
   */
  static createSmallMapMapImage(size: Size) {
    return UiHelper.createSprite("small_map_image", "", new Vec2(), size);
  }

  //#endregion

  //#region 路线指示线（自动寻路）

  /**
   * 创建大地图上的路线指示线绘制层（自动寻路时画在地面之上的路线）
   * 挂在地图节点下：本地坐标即地图节点坐标系（见 core/RouteIndicator 的坐标换算），
   * 画出的线贴在地面上、位于角色与怪物之下（地图层的渲染顺序先于怪物层/特效层），换图时随旧地图节点一起销毁
   * @param map 地图节点（挂载的宿主）
   */
  static createRouteLineLayer(map: Node) {
    const node = UiHelper.createNode("route_line", new Vec2(), new Size(1, 1));
    map.addChild(node);
    // 地图节点挂在 MAP 层，动态新增的子节点要对齐图层才可见（LayerManager 的监听之外再显式一次，避免依赖时序）
    LayerManager.setNodeToLayer(node, map.layer);
    return node.addComponent(Graphics);
  }

  //#endregion

  //#region 技能列表

  /** 创建技能列表滚动区（几何见 configs/hudLayout.skillListDialogLayout.list） */
  static createSkillListView(): Node {
    const list = skillListDialogLayout.list;
    return UiHelper.createScrollView(list.name, list.position, list.size);
  }

  /** 创建单个技能行（未学习置灰；已学习点击触发回调） */
  static createSkillItem(role: Role, skillId: SkillId, onOpenShortcutKey: () => void): Node {
    const skillConfig = skills.get(skillId);
    const node = UiHelper.createFlexRow(skillId, 5, new Vec2(), new Size(250, 50));
    const skillIcon = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2(), new Size(40, 40));
    if (!role.skills[skillId]) skillIcon.getComponent(Sprite).grayscale = true;
    if (role.skills[skillId]) {
      skillIcon.on(Node.EventType.TOUCH_END, onOpenShortcutKey, this);
      // 可点的技能图标（不走 UiHelper.createButton），鼠标通道补一次命中拦截
      blockClickThrough(skillIcon);
    }
    node.addChild(skillIcon);
    const description = UiHelper.createFlexCol(`${skillId}_desc`, 3, new Vec2(), new Size(205, 40));
    const skillLabel = UiHelper.createLabel(
      "skill_label",
      `${skillConfig.label} (${role.skills[skillId] ? getText("label_skill_level", { level: role.skills[skillId] }) : getText("label_skill_unlearned")})`,
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
    return node;
  }

  //#endregion
}
