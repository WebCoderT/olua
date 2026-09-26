import { AnimationClip, Button, Color, Label, LabelAtlas, Node, ProgressBar, resources, Size, Sprite, tween, UIOpacity, UITransform, Vec2, Vec3, Vertex } from "cc";
import UiHelper from "./UiHelper";
import { AnimationPlayer } from "../../scripts/AnimationPlayer";
import LayerHelper from "./LayerHelper";
import { Draggable } from "../utils/Draggable";
import { RoleInfoFramePositionsMap } from "../../configs/game";
import { goodsDialogSize } from "../../configs/equipments";
import { Role } from "../../configs/role";
import { Goods } from "../../types/common";
import GameHelper from "../utils/GameHelper";
import AnimationHelper from "./AnimationHelper";

export interface BottomNavBarButton {
  label: string;
  icon: string;
  openLevel: number;
  onClick: () => void;
  name: string;
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
    LayerHelper.setLayerToUILayer(name);
    node.addChild(name);
    // 等级
    const level = UiHelper.createLabel("role_level", role.level.toString(), Color.WHITE, 16, new Vec2(-138, -17.5), new Size(24, 24));
    LayerHelper.setLayerToUILayer(level);
    node.addChild(level);
    // 头像
    const avatar = UiHelper.createSprite("role_avatar", `avatars/${role.occupation}-${role.sex}`, new Vec2(-109.5, 7.5), new Size(51, 60));
    LayerHelper.setLayerToUILayer(avatar);
    node.addChild(avatar);
    // 元宝
    const goldIcon = UiHelper.createSprite("gold_icon", "money/gold", new Vec2(-68, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(goldIcon);
    node.addChild(goldIcon);
    // 元宝数量
    const goldCount = UiHelper.createLabel("gold_count", role.gold.toString(), Color.WHITE, 12, new Vec2(-45, -20), new Size(30, 10));
    goldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    goldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(goldCount);
    node.addChild(goldCount);
    // 绑定元宝
    const bindGoldIcon = UiHelper.createSprite("bind_gold_icon", "money/bind-gold", new Vec2(-22, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(bindGoldIcon);
    node.addChild(bindGoldIcon);
    // 绑定元宝数量
    const bindGoldCount = UiHelper.createLabel("bind_gold_count", role.bindGold.toString(), Color.WHITE, 12, new Vec2(1, -20), new Size(30, 10));
    bindGoldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    bindGoldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(bindGoldCount);
    node.addChild(bindGoldCount);
    // 银子
    const silverIcon = UiHelper.createSprite("silver_icon", "money/silver", new Vec2(24, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(silverIcon);
    node.addChild(silverIcon);
    // 银子数量
    const silverCount = UiHelper.createLabel("silver_count", role.bindGold.toString(), Color.WHITE, 12, new Vec2(47, -20), new Size(30, 10));
    silverCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    silverCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(silverCount);
    node.addChild(silverCount);
    // 站斗力
    const combatIcon = UiHelper.createSprite("combat_icon", "common/combat", new Vec2(-44, 2), new Size(75, 41));
    LayerHelper.setLayerToUILayer(combatIcon);
    node.addChild(combatIcon);
    // 战斗力数字
    const combatNumber = UiHelper.createLabel("combat_number", role.combat.toString(), Color.WHITE, 20, new Vec2(-7, 4), new Size(200, 30));
    combatNumber.getComponent(UITransform).setAnchorPoint(0, 0.5);
    const label = combatNumber.getComponent(Label);
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    resources.load("fonts/combat", LabelAtlas, (err, atlas) => {
      if (err) {
        console.error("战斗力字体加载失败");
        return;
      }
      label.font = atlas;
      LayerHelper.setLayerToUILayer(combatNumber);
      node.addChild(combatNumber);
    });
    // vip按钮
    const vipButton = UiHelper.createButton("vip_button", "money/vip", new Vec2(110, 30), new Size(75, 25));
    LayerHelper.setLayerToUILayer(vipButton);
    node.addChild(vipButton);
    return { node, combatNumber, level };
  },
  /**
   * 创建底部导航功能区域按键
   * @param button BottomBarNavButton
   * @return node Node
   */
  createBottomNavBarButton(button: BottomNavBarButton, role: Role) {
    const node = UiHelper.createButton(`bottom_nav_${button.icon.replace(/\//g, "_")}`, button.icon, new Vec2(0, 0), new Size(44, 44));
    LayerHelper.setLayerToUILayer(node);
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
    LayerHelper.setLayerToUILayer(node);
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
    LayerHelper.setLayerToUILayer(expBar);
    const expProgress = UiHelper.createSprite(`${name}_progress`, "bottom-nav-bar/exp", new Vec2(), size);
    LayerHelper.setLayerToUILayer(expProgress);
    expBar.addChild(expProgress);
    expBar.getComponent(ProgressBar).barSprite = expProgress.getComponent(Sprite);
    return expBar;
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
    LayerHelper.addToUILayer(errorTip);
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
    LayerHelper.addToUILayer(errorTip);
  },

  /**
   * 创建游戏通用弹窗背景
   */
  createDialogBg(name: string, position: Vec2 = new Vec2(), size: Size = new Size(600, 500)) {
    const dialog = UiHelper.createSprite(name, "common/popup-bg", position, size);
    dialog.name = name;
    dialog.addComponent(Draggable);
    LayerHelper.setLayerToUILayer(dialog);
    return dialog;
  },

  /**
   * 创建游戏通用弹窗标题
   */
  createDialogTitle(name: string, title: string, position: Vec2 = new Vec2(0, 228)) {
    const dialogTitle = UiHelper.createLabel(name, title, Color.WHITE, 18, position, new Size(300, 30));
    LayerHelper.setLayerToUILayer(dialogTitle);
    return dialogTitle;
  },

  /**
   * 创建游戏通用关闭按钮
   */
  createCloseButton(name: string, position: Vec2 = new Vec2(), size: Size = new Size(30, 30)) {
    const closeButton = UiHelper.createButton(name, "common/close-button", position, size);
    LayerHelper.setLayerToUILayer(closeButton);
    return closeButton;
  },

  /**
   * 创建通用弹窗
   */
  createDialog(name: string, title: string) {
    // 弹窗
    const dialog = GameUiHelper.createDialogBg(name);
    // 弹窗标题
    const dialogTitle = GameUiHelper.createDialogTitle("dialog_title", title);
    dialog.addChild(dialogTitle);
    // 关闭弹窗按钮
    const closeButton = GameUiHelper.createCloseButton("close_button", new Vec2(280, 230));
    dialog.addChild(closeButton);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  },

  /**
   * 创建游戏大按钮
   */
  createBigButton(name: string, text: string, position: Vec2 = new Vec2()) {
    const bigButton = UiHelper.createButton(name, "common/bg-button", position, new Size(129, 54));
    bigButton.name = name;
    LayerHelper.setLayerToUILayer(bigButton);
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, 30, new Vec2(), new Size(129, 54));
    LayerHelper.setLayerToUILayer(label);
    bigButton.addChild(label);
    return bigButton;
  },

  // 在某个格子上创建物品
  createGood(cell: Node, good: Goods) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    LayerHelper.setLayerToUILayer(sprite);
    cell.addChild(sprite);
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        const screenPosition = GameHelper.worldPositionToScreenPosition(cell.getWorldPosition());
        const detailDialog = GameUiHelper.createGoodDetailDialog(good, cell.getComponent(UITransform).contentSize, screenPosition);
        LayerHelper.addToUILayer(detailDialog);
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
    const dialog = UiHelper.createSprite("good_detail", "common/bg", position, goodsDialogSize.get(good.type));
    LayerHelper.setLayerToUILayer(dialog);
    // 物品在左侧
    if (screenPosition.x < screenSize.width / 2) {
      position.x += contentSize.width / 2;
      dialog.getComponent(UITransform).anchorX = 0;
    }
    // 物品在右侧
    if (screenPosition.x > screenSize.width / 2) {
      dialog.getComponent(UITransform).anchorX = 1;
    }
    // 物品在上册
    if (screenPosition.y > screenSize.height / 2) {
      position.y += contentSize.height / 2;
      dialog.getComponent(UITransform).anchorY = 1;
    }
    // 物品在下册
    if (screenPosition.y < screenSize.height / 2) {
      position.y -= contentSize.height / 2;
      dialog.getComponent(UITransform).anchorY = 0;
    }
    dialog.setPosition(position.x, position.y, 0);
    return dialog;
  },

  /**
   * 创建角色衣服内观
   */
  createRoleClothInShow(role: Role, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const clothInShow = UiHelper.createSprite("cloth_in_show", "", position, size);
    LayerHelper.setLayerToUILayer(clothInShow);
    AnimationHelper.playLoopWithDir("cloth_in_show", clothInShow, role.equipments.cloth.in, 1);
    return clothInShow;
  },
};

export default GameUiHelper;
