import { AnimationClip, Button, Color, Label, Node, ProgressBar, Size, Sprite, tween, UIOpacity, UITransform, Vec2, Vec3 } from "cc";
import UiHelper from "./UiHelper";
import { AnimationPlayer } from "../scripts/AnimationPlayer";
import { BottomNavBarButton, Role, RoleInfoFramePositionsMap } from "../configs";
import LayerHelper from "./LayerHelper";

const GameUiHelper = {
  /**
   * 创建角色预览效果
   * @param occupation 职业
   * @param sex 性别
   */
  createRolePreview: (name: string, level: number, occupation: string = "1", sex: string = "1", position: Vec2 = new Vec2(), size: Size = new Size()) => {
    const role = UiHelper.createEmptyNode(name, position, size);
    const node = UiHelper.createSprite("");
    node.name = name;
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
    const node = UiHelper.createSprite("common/user-info-frame", RoleInfoFramePositionsMap.get(role.relationShip), new Size(300, 70));
    // 昵称
    const name = UiHelper.createLabel(role.name, Color.WHITE, 16, new Vec2(25, 2.5), new Size(190, 24));
    name.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    LayerHelper.setLayerToUILayer(name);
    node.addChild(name);
    // 等级
    const level = UiHelper.createLabel(role.level.toString(), Color.WHITE, 16, new Vec2(-138, -17.5), new Size(24, 24));
    LayerHelper.setLayerToUILayer(level);
    node.addChild(level);
    // 头像
    const avatar = UiHelper.createSprite(`avatars/${role.occupation}-${role.sex}`, new Vec2(-109.5, 7.5), new Size(51, 60));
    LayerHelper.setLayerToUILayer(avatar);
    node.addChild(avatar);
    // 元宝
    const goldIcon = UiHelper.createSprite("money/gold", new Vec2(-68, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(goldIcon);
    node.addChild(goldIcon);
    // 元宝数量
    const goldCount = UiHelper.createLabel(role.gold.toString(), Color.WHITE, 12, new Vec2(-45, -20), new Size(30, 10));
    goldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    goldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(goldCount);
    node.addChild(goldCount);
    // 绑定元宝
    const bindGoldIcon = UiHelper.createSprite("money/bind-gold", new Vec2(-22, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(bindGoldIcon);
    node.addChild(bindGoldIcon);
    // 绑定元宝数量
    const bindGoldCount = UiHelper.createLabel(role.bindGold.toString(), Color.WHITE, 12, new Vec2(1, -20), new Size(30, 10));
    bindGoldCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    bindGoldCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(bindGoldCount);
    node.addChild(bindGoldCount);
    // 银子
    const silverIcon = UiHelper.createSprite("money/silver", new Vec2(24, -20), new Size(15, 10));
    LayerHelper.setLayerToUILayer(silverIcon);
    node.addChild(silverIcon);
    // 银子数量
    const silverCount = UiHelper.createLabel(role.bindGold.toString(), Color.WHITE, 12, new Vec2(47, -20), new Size(30, 10));
    silverCount.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    silverCount.getComponent(Label).verticalAlign = Label.VerticalAlign.TOP;
    LayerHelper.setLayerToUILayer(silverCount);
    node.addChild(silverCount);
    return node;
  },
  /**
   * 创建底部导航功能区域按键
   * @param button BottomBarNavButton
   * @return node Node
   */
  createBottomNavBarButton(button: BottomNavBarButton, role: Role) {
    const node = UiHelper.createButton(button.icon, new Vec2(0, 0), new Size(44, 44));
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
    const node = UiHelper.createFlexRow(spacex, position, size);
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
    const expProgress = UiHelper.createSprite("bottom-nav-bar/exp", new Vec2(), size);
    LayerHelper.setLayerToUILayer(expProgress);
    expBar.addChild(expProgress);
    expBar.getComponent(ProgressBar).barSprite = expProgress.getComponent(Sprite);
    return expBar;
  },

  /**
   * 创建错误提示
   * @param error 错误信息
   */
  createErrorTip(error: string) {
    const errorTip = UiHelper.createErrorTip(error);
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
};

export default GameUiHelper;
