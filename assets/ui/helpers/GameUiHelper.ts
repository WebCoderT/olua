import { AnimationClip, Button, Color, Label, LabelAtlas, Layout, math, Node, ProgressBar, resources, size, Size, Sprite, tween, UIOpacity, UITransform, Vec2, Vec3, Vertex } from "cc";
import UiHelper from "./UiHelper";
import { AnimationPlayer } from "../../scripts/AnimationPlayer";
import { Draggable } from "../utils/Draggable";
import { RoleInfoFramePositionsMap } from "../../configs/game";
import { Role } from "../../configs/role";
import { BattleAttributes, Goods } from "../../types/common";
import GameHelper from "../utils/GameHelper";
import AnimationHelper from "./AnimationHelper";
import { goodShowAttributes, goodShowAttributesLabel } from "../../configs/good";
import LayerManager from "../utils/LayerManager";

export interface BottomNavBarButton {
  label: string;
  icon: string;
  openLevel: number;
  onClick: () => void;
  name: string;
  shortcutKey: string;
}

const GameUiHelper = {
  /**
   * 创建角色预览效果
   * @param occupation 职业
   * @param sex 性别
   */
  createRolePreview: (name: string, level: number, occupation: string = "1", sex: string = "1", position: Vec2 = new Vec2(), size: Size = new Size()) => {
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
  },
  /**
   * 创建角色信息头像框
   * @param role 角色信息
   */
  createRoleInfoFrame(role: Role) {
    const node = UiHelper.createSprite("role_info_frame", "common/user-info-frame", RoleInfoFramePositionsMap.get(role.relationShip), new Size(300, 70));
    // 昵称
    const name = UiHelper.createLabel("role_name", role.name, Color.WHITE, 16, new Vec2(17, 24), new Size(190, 24));
    name.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    node.addChild(name);
    // 等级
    const level = UiHelper.createLabel("role_level", role.level.toString(), Color.WHITE, 16, new Vec2(-138, -17.5), new Size(24, 24));
    node.addChild(level);
    // 头像
    const avatar = UiHelper.createSprite("role_avatar", `avatars/${role.occupation}-${role.sex}`, new Vec2(-109.5, 7.5), new Size(51, 60));
    node.addChild(avatar);
    // 元宝
    const goldIcon = UiHelper.createSprite("gold_icon", "money/gold", new Vec2(-68, -20), new Size(15, 10));
    node.addChild(goldIcon);
    // 元宝数量
    const goldCount = UiHelper.createLabel("gold_count", role.gold.toString(), Color.WHITE, 12, new Vec2(-45, -20), new Size(30, 10));
    goldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    goldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    node.addChild(goldCount);
    // 绑定元宝
    const bindGoldIcon = UiHelper.createSprite("bind_gold_icon", "money/bind-gold", new Vec2(-22, -20), new Size(15, 10));
    node.addChild(bindGoldIcon);
    // 绑定元宝数量
    const bindGoldCount = UiHelper.createLabel("bind_gold_count", role.bindGold.toString(), Color.WHITE, 12, new Vec2(1, -20), new Size(30, 10));
    bindGoldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    bindGoldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    node.addChild(bindGoldCount);
    // 银子
    const silverIcon = UiHelper.createSprite("silver_icon", "money/silver", new Vec2(24, -20), new Size(15, 10));
    node.addChild(silverIcon);
    // 银子数量
    const silverCount = UiHelper.createLabel("silver_count", role.bindGold.toString(), Color.WHITE, 12, new Vec2(47, -20), new Size(30, 10));
    silverCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    silverCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    node.addChild(silverCount);
    // 站斗力
    const combatIcon = UiHelper.createSprite("combat_icon", "common/combat", new Vec2(-44, 2), new Size(75, 41));
    node.addChild(combatIcon);
    // 战斗力数字
    const combatNumber = UiHelper.createLabel("combat_number", role.combat.toString(), Color.WHITE, 20, new Vec2(-3.5, 4), new Size(200, 30));
    combatNumber.getComponent(UITransform).setAnchorPoint(0, 0.5);
    const label = combatNumber.getComponent(Label);
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    resources.load("fonts/combat", LabelAtlas, (err, atlas) => {
      if (err) {
        console.error("战斗力字体加载失败");
        return;
      }
      label.font = atlas;
      node.addChild(combatNumber);
    });
    // vip按钮
    const vipButton = UiHelper.createButton("vip_button", "money/vip", new Vec2(110, 30), new Size(75, 25));
    node.addChild(vipButton);
    return { node, combatNumber, level };
  },
  /**
   * 创建底部导航功能区域按键
   * @param button BottomBarNavButton
   * @return node Node
   */
  createBottomNavBarButton(button: BottomNavBarButton, role: Role) {
    const node = UiHelper.createButton(`bottom_nav_${button.icon.replace(/\//g, "_")}`, button.icon, new Vec2(0, 0), new Size(40, 40));
    const shortcutKey = UiHelper.createLabel("shortcut_key", button.shortcutKey, Color.WHITE, 10, new Vec2(15, -15), new Size(20, 20));
    node.addChild(shortcutKey);
    // 判断是否解锁
    if (button.openLevel > role.level) node.getComponent(Sprite).grayscale = true;
    return node;
  },
  /**
   * 创建底部功能区域
   * @param spacex 横向距离
   * @param position 位置
   * @param size 尺寸
   */
  createBottomNavBar(spacex: number, position: Vec2, size: Size) {
    const node = UiHelper.createFlexRow("bottom_nav_bar", spacex, position, size);
    return node;
  },

  /**
   * 创建游戏经验条
   * @param name 元素名称
   * @param progress 进度
   * @param position 位置
   * @param size 尺寸
   * @return 经验条
   */
  createExpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const expBar = UiHelper.createProgressBar(name, progress, "", position, size);
    const expProgress = UiHelper.createSprite(`${name}_progress`, "bottom-nav-bar/exp", new Vec2(), size);
    expBar.addChild(expProgress);
    expBar.getComponent(ProgressBar).barSprite = expProgress.getComponent(Sprite);
    return expBar;
  },

  /** 创建血条 */
  createHpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const hpBar = UiHelper.createProgressBar(name, progress, "common/bg_gray", position, size);
    const hpProgress = UiHelper.createSprite(`${name}_progress`, "common/bg_white", new Vec2(), size);
    hpProgress.getComponent(Sprite).color = Color.RED;
    hpBar.addChild(hpProgress);
    hpBar.getComponent(ProgressBar).barSprite = hpProgress.getComponent(Sprite);
    return hpBar;
  },

  /** 创建头部信息 */
  createHead(name: string, label: string, hp: number, maxHp: number) {
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
    const roleHp = GameUiHelper.createHpBar("", hp / maxHp, new Vec2(), new Size(80, 4));
    head.addChild(roleHp);
    /** 血量文字显示 */
    const roleHpText = UiHelper.createLabel("role_name", `${hp} / ${maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(roleHpText);
    return head;
  },

  /**
   * 创建错误提示
   * @param error 错误信息
   */
  createErrorTip(name: string, error: string) {
    const errorTip = UiHelper.createErrorTip(name, error);
    const uiOpacity = errorTip.addComponent(UIOpacity);
    tween(errorTip)
      .to(0.3, { position: new Vec3(0, 40, 0) })
      .start();
    tween(uiOpacity)
      .to(1.5, { opacity: 0 })
      .call(() => {
        errorTip.destroy();
      })
      .start();
    LayerManager.addToUILayer(errorTip);
  },

  /**
   * 创建提示
   */
  createTip(name: string, text: string) {
    const errorTip = UiHelper.createTip(name, text);
    const uiOpacity = errorTip.addComponent(UIOpacity);
    tween(errorTip)
      .to(0.5, { position: new Vec3(0, 40, 0) })
      .start();
    tween(uiOpacity)
      .to(3, { opacity: 0 })
      .call(() => {
        errorTip.destroy();
      })
      .start();
    LayerManager.addToUILayer(errorTip);
  },

  /**
   * 创建游戏通用弹窗背景
   */
  createDialogBg(name: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 500)) {
    const dialog = UiHelper.createSprite(name, "common/popup-bg", position, size);
    dialog.name = name;
    dialog.addComponent(Draggable);
    return dialog;
  },

  /**
   * 创建游戏通用弹窗标题
   */
  createDialogTitle(name: string, title: string, position: Vec2 = new Vec2(0, 228)) {
    const dialogTitle = UiHelper.createLabel(name, title, math.color("#FF8B8B"), 14, position, new Size(300, 30));
    return dialogTitle;
  },

  /**
   * 创建游戏通用关闭按钮
   */
  createCloseButton(name: string, position: Vec2 = new Vec2(), size: Size = new Size(30, 30)) {
    const closeButton = UiHelper.createButton(name, "common/close-button", position, size);
    return closeButton;
  },

  /**
   * 创建通用弹窗
   */
  createDialog(name: string, title: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 500)) {
    // 弹窗
    const dialog = GameUiHelper.createDialogBg(name, position, size);
    // 关闭弹窗按钮
    const closeButton = UiHelper.createButton(`${name}_close_button`, "common/close-button", new Vec2(size.width / 2 - 15, size.height / 2 - 15), new Size(30, 30));
    dialog.addChild(closeButton);
    // 弹窗标题
    const dialogTitle = UiHelper.createLabel(`${name}_title`, title, math.color("#FF8B8B"), 14, new Vec2(0, size.height / 2 - 15), new Size(size.width - 60, 30));
    dialog.addChild(dialogTitle);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  },

  /**
   * 创建游戏大按钮
   */
  createBigButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const bigButton = UiHelper.createButton(name, "common/big-button", position, new Size(129, 54));
    bigButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, 20, new Vec2(), new Size(129, 54));
    bigButton.addChild(label);
    return bigButton;
  },

  // 在某个格子上创建物品
  createGood(cell: Node, good: Goods) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    cell.addChild(sprite);
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        const screenPosition = GameHelper.worldPositionToScreenPosition(cell.getWorldPosition());
        const detailDialog = GameUiHelper.createGoodDetailDialog(good, cell.getComponent(UITransform).contentSize, screenPosition);
        LayerManager.addToUILayer(detailDialog);
        sprite.once(Node.EventType.MOUSE_LEAVE, () => detailDialog.destroy(), this);
      },
      this,
    );
  },

  /**
   * 创建物品详情弹窗
   */
  createGoodDetailDialog(good: Goods, contentSize: Size, screenPosition: Vec3 = new Vec3()) {
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
    layout.paddingLeft = 10;
    layout.paddingRight = 10;
    layout.paddingBottom = 10;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;

    // 头部
    const contentHeader = UiHelper.createFlexRow("header", 10, new Vec2(), new Size(220, 40));
    // 图标
    const goodImage = UiHelper.createSprite("good_image", good.icon, new Vec2(), new Size(40, 40));
    // 标题
    const title = UiHelper.createLabel("good_detail_title", good.label, Color.WHITE, 14, new Vec2(), new Size(170, 40));
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

    // 介绍
    const contentDescription = UiHelper.createLabel("content_description", good.description, Color.WHITE, 12, new Vec2(), new Size(220, 50));
    const descLabel = contentDescription.getComponent(Label);
    descLabel.lineHeight = 16;
    descLabel.enableWrapText = true;
    descLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    descLabel.overflow = Label.Overflow.RESIZE_HEIGHT;

    // 属性列表
    const contentBody = UiHelper.createFlexCol("content_body", 3, new Vec2(), new Size(220, 220));
    contentBody.getComponent(Layout).resizeMode = Layout.ResizeMode.CONTAINER;
    goodShowAttributes.get(good.type).forEach((attr) => {
      contentBody.addChild(GameUiHelper.createAttributeLabel(attr, good[attr].toString()));
    });

    dialog.addChild(contentHeader);
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
  },

  /**
   * 创建属性标签
   */
  createAttributeLabel(key: keyof BattleAttributes, value: string, size: Size = new Size(220, 20)) {
    const attributeLabel = UiHelper.createFlexRow(key, 10, new Vec2(), size);

    const icon = UiHelper.createSprite("icon", "common/dot", new Vec2(), new Size(10, 10));
    attributeLabel.addChild(icon);

    const label = UiHelper.createLabel(key, goodShowAttributesLabel.get(key), Color.WHITE, 12, new Vec2(), new Size(50, size.height));
    label.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    attributeLabel.addChild(label);

    const attribute = UiHelper.createLabel(key, value.replace(",", " - "), Color.WHITE, 12, new Vec2(), new Size(size.width - 20 - 50 - 10, size.height));
    attributeLabel.addChild(attribute);

    return attributeLabel;
  },

  /**
   * 创建角色衣服内观
   */
  createRoleClothInShow(role: Role, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const clothInShow = UiHelper.createSprite("cloth_in_show", "", position, size);
    clothInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    AnimationHelper.playLoopWithDir("cloth_in_show", clothInShow, role.equipments.cloth.in, 1);
    return clothInShow;
  },

  /** 创建角色武器内观 */
  createRoleWeaponInshow(role: Role, position: Vec2 = new Vec2(), size: Size = new Size()) {
    // 内观偏移
    position.x += role.equipments.weapon.inOffset.x;
    position.y += role.equipments.weapon.inOffset.y;
    const weaponInShow = UiHelper.createSprite("weapon_in_show", "", position, size);
    weaponInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    AnimationHelper.playLoopWithDir("weapon_in_show", weaponInShow, role.equipments.weapon.in, 1);
    return weaponInShow;
  },
};

export default GameUiHelper;
