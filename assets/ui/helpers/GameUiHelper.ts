import { AnimationClip, Color, EditBox, EventHandler, Label, LabelAtlas, Layout, math, Node, ProgressBar, resources, Size, Sprite, ToggleContainer, tween, UIOpacity, UITransform, Vec2, Vec3 } from "cc";
import UiHelper from "./UiHelper";
import AnimationHelper from "./AnimationHelper";
import { AnimationPlayer } from "../../scripts/AnimationPlayer";
import { Draggable } from "../utils/Draggable";
import { bagRow, bagCol } from "../../configs/game";
import { Role } from "../../configs/role";
import { BattleAttributes, Goods, OECCUPATION, RoleOccupationInfo, SEX, SpeedRate } from "../../types/common";
import GameHelper from "../core/GameHelper";
import { goodShowAttributes, goodShowAttributesLabel } from "../../configs/good";
import LayerManager from "../core/LayerManager";

//#region 类型定义

export interface BottomNavBarButton {
  label: string;
  icon: string;
  openLevel: number;
  onClick: () => void;
  name: string;
  shortcutKey: string;
}

export interface RoleSelectorMainView {
  beginGameButton: Node;
  selectedRoleName: Node;
  selectedRoleLevel: Node;
  ownerRoleNodes: Node[];
}

export interface RoleSelectorCreateView {
  backButton: Node;
  dialog: Node;
  nameInput: Node;
  sexToggleGroup: Node;
  occupationToggleGroup: Node;
  createButton: Node;
  occupationDescription: Node | null;
  occupationPreview: Node | null;
}

interface RoleSelectorCallbacks {
  onCreateRole: () => void;
  onCancelCreateRole: () => void;
  onOccupationChanged: () => void;
}

/** 角色预览默认站位（最多3个角色） */
const rolePositions = [new Vec2(-485, -25), new Vec2(-250, -75), new Vec2(-10, -40)];

//#endregion

/**
 * 游戏UI工厂（静态类）
 * 在 UiHelper 基础组件之上固化游戏内的 UI 样式：角色信息框、血条经验条、
 * 弹窗、物品详情、背包、升级特效、角色内观、选角界面等
 */
export default class GameUiHelper {
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

  //#region 底部导航

  /**
   * 创建底部导航功能区域按键
   * @param button BottomNavBarButton
   * @return node Node
   */
  static createBottomNavBarButton(button: BottomNavBarButton, role: Role) {
    const node = UiHelper.createButton(`bottom_nav_${button.icon.replace(/\//g, "_")}`, button.icon, new Vec2(0, 0), new Size(40, 40));
    const shortcutKey = UiHelper.createLabel("shortcut_key", button.shortcutKey, Color.WHITE, 10, new Vec2(15, -15), new Size(20, 20));
    node.addChild(shortcutKey);
    // 判断是否解锁
    if (button.openLevel > role.level) node.getComponent(Sprite).grayscale = true;
    return node;
  }

  /**
   * 创建底部功能区域
   * @param spacex 横向距离
   * @param position 位置
   * @param size 尺寸
   */
  static createBottomNavBar(spacex: number, position: Vec2, size: Size) {
    return UiHelper.createFlexRow("bottom_nav_bar", spacex, position, size);
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
    return this.createBar(name, progress, "", "bottom-nav-bar/exp", position, size);
  }

  /** 创建血条 */
  static createHpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return this.createBar(name, progress, "common/bg_gray", "common/bg_white", position, size, Color.RED);
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
  }

  /**
   * 创建提示
   */
  static createTip(name: string, text: string) {
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
    const bigButton = UiHelper.createButton(name, "common/big-button", position, new Size(129, 54));
    bigButton.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, 20, new Vec2(), new Size(129, 54));
    bigButton.addChild(label);
    return bigButton;
  }

  /** 创建游戏小按钮 */
  static createSmallButtion(name: string, text: string, position: Vec2 = new Vec2()) {
    const button = UiHelper.createButton(name, "common/small-button", position, new Size(50, 48));
    button.name = name;
    const label = UiHelper.createLabel(`${name}_label`, text, Color.WHITE, 20, new Vec2(), new Size(50, 48));
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
        sprite.once(Node.EventType.MOUSE_LEAVE, () => detailDialog.destroy(), this);
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
      contentBody.addChild(this.createAttributeLabel(attr, good[attr].toString()));
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

  //#endregion

  //#region 角色内观与特效

  /**
   * 创建角色衣服内观
   */
  static createRoleClothInShow(role: Role, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const clothInShow = UiHelper.createSprite("cloth_in_show", "", position, size);
    clothInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    AnimationHelper.playLoopWithDir("cloth_in_show", clothInShow, role.equipments.cloth.in, 1);
    return clothInShow;
  }

  /** 创建角色武器内观 */
  static createRoleWeaponInshow(role: Role, position: Vec2 = new Vec2(), size: Size = new Size()) {
    // 内观偏移
    position.x += role.equipments.weapon.inOffset.x;
    position.y += role.equipments.weapon.inOffset.y;
    const weaponInShow = UiHelper.createSprite("weapon_in_show", "", position, size);
    weaponInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    AnimationHelper.playLoopWithDir("weapon_in_show", weaponInShow, role.equipments.weapon.in, 1);
    return weaponInShow;
  }

  /**
   * 创建升级特效
   */
  static createUpgradeEffect(position: Vec2 = new Vec2()) {
    const upgrade = UiHelper.createSprite("upgrade_effect", "", new Vec2(0, 90), new Size(284, 380));
    AnimationHelper.playOnceWithDir("upgrade", upgrade, "effect/upgrade", 1);
    return upgrade;
  }

  //#endregion

  //#region 背包

  /** 创建背包格子 */
  static createRoleBagCell(row: number, col: number) {
    return UiHelper.createSprite(`bag_slot_${row}_${col}`, "common/grid", new Vec2(), new Size(50, 50));
  }

  /** 创建背包格子行 */
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

  /** 创建背包格子行列 */
  static createRoleBagCells() {
    const bagGrid = UiHelper.createFlexCol("bag_grid", 3, new Vec2(0, 17), new Size(580, 368));
    const cells = this.createRoleBagCellRow(bagGrid);
    return { bagGrid, cells };
  }

  /** 创建背包UI */
  static createRoleBag() {
    const dialog = this.createDialog("bag_dialog", "背包");
    const { bagGrid, cells } = this.createRoleBagCells();
    dialog.addChild(bagGrid);
    return { dialog, cells };
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

  //#region 选角界面

  /** 创建选角界面主视图 */
  static createMainView(parent: Node, onBeginGame: () => void, onCreateRole: () => void): RoleSelectorMainView {
    parent.addChild(UiHelper.createFullScreenNode("role_selector_background", "create_role/bg"));

    const bottomBar = UiHelper.createSprite("role_selector_bottom_bar", "create_role/bg_bottom", new Vec2(0, -305), new Size(1624, 139));
    parent.addChild(bottomBar);

    const beginGameButton = UiHelper.createButton("begin_game_button", "create_role/start_btn", new Vec2(0, -40), new Size(190, 48));
    beginGameButton.getComponent(Sprite).grayscale = true;
    beginGameButton.on(Node.EventType.TOUCH_END, onBeginGame);
    bottomBar.addChild(beginGameButton);

    const createRoleButton = UiHelper.createButton("show_create_role_button", "create_role/new_role", new Vec2(-740, 300), new Size(75, 79));
    createRoleButton.on(Node.EventType.TOUCH_END, onCreateRole);
    parent.addChild(createRoleButton);

    parent.addChild(UiHelper.createButton("manage_role_button", "create_role/manage", new Vec2(-740, 200), new Size(75, 79)));

    const selectedInfoBox = UiHelper.createSprite("selected_role_info_background", "create_role/idlv", new Vec2(-435, -335), new Size(345, 26));
    selectedInfoBox.addChild(UiHelper.createLabel("selected_role_name", "---", Color.WHITE, 20, new Vec2(-35, 0), new Size(160, 30)));
    selectedInfoBox.addChild(UiHelper.createLabel("selected_role_level", "-", Color.WHITE, 16, new Vec2(147, 0), new Size(40, 30)));
    parent.addChild(selectedInfoBox);

    return {
      beginGameButton,
      selectedRoleName: selectedInfoBox.getChildByName("selected_role_name"),
      selectedRoleLevel: selectedInfoBox.getChildByName("selected_role_level"),
      ownerRoleNodes: [],
    };
  }

  /** 更新选角界面角色预览列表 */
  static updateRolePreviews(view: RoleSelectorMainView, parent: Node, roles: Role[], ononlineRole: (roleId: string) => void): void {
    this.destroyNodes(view.ownerRoleNodes);
    view.ownerRoleNodes = roles.map((role, index) => {
      const node = this.createRolePreview(role.id, 1, role.occupation, role.sex, rolePositions[index] ?? new Vec2(), new Size(200, 360));
      node.on(Node.EventType.TOUCH_END, () => ononlineRole(role.id));
      parent.addChild(node);
      return node;
    });
  }

  /** 批量销毁节点并清空数组 */
  static destroyNodes(nodes: Node[]): void {
    nodes.forEach((node) => node.destroy());
    nodes.length = 0;
  }

  /** 设置"开始游戏"按钮可用状态 */
  static setBeginGameEnabled(view: RoleSelectorMainView, enabled: boolean): void {
    view.beginGameButton.getComponent(Sprite).grayscale = !enabled;
  }

  /** 更新选中角色的名字与等级显示 */
  static updateSelectedRole(view: RoleSelectorMainView, role: Role): void {
    view.selectedRoleName.getComponent(Label).string = role.name;
    view.selectedRoleLevel.getComponent(Label).string = role.level.toString();
  }

  /** 创建创建角色弹窗视图 */
  static createRoleView(parent: Node, callbacks: RoleSelectorCallbacks, occupations: Map<OECCUPATION, RoleOccupationInfo>): RoleSelectorCreateView {
    const backButton = UiHelper.createButton("cancel_create_role_button", "create_role/back_btn", new Vec2(-740, -210), new Size(75, 79));
    parent.addChild(backButton);
    backButton.on(Node.EventType.TOUCH_END, callbacks.onCancelCreateRole);

    const dialog = UiHelper.createSprite("create_role_dialog", "create_role/bg_dialog", new Vec2(630, 35), new Size(320, 580));
    parent.addChild(dialog);
    dialog.addChild(UiHelper.createSprite("create_role_dialog_title", "create_role/label_title", new Vec2(0, 242), new Size(128, 28)));
    dialog.addChild(UiHelper.createSprite("gender_label", "create_role/label_1", new Vec2(0, 190), new Size(56, 25)));

    const sexToggleGroup = UiHelper.createToggleGroup(
      "role_sex_toggle_group",
      [UiHelper.createToggle("1", "create_role/1_1", "create_role/1_0", new Vec2(), new Size(48, 48)), UiHelper.createToggle("2", "create_role/2_1", "create_role/2_0", new Vec2(), new Size(48, 48))],
      30,
      new Vec2(0, 148),
    );
    dialog.addChild(sexToggleGroup);

    dialog.addChild(UiHelper.createSprite("occupation_label", "create_role/label_2", new Vec2(0, 100), new Size(56, 25)));
    const occupationToggleGroup = UiHelper.createToggleGroup(
      "role_occupation_toggle_group",
      [
        UiHelper.createToggle(OECCUPATION.ZHAN, "create_role/3_1", "create_role/3_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle(OECCUPATION.FA, "create_role/4_1", "create_role/4_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle(OECCUPATION.DAO, "create_role/5_1", "create_role/5_0", new Vec2(), new Size(48, 48)),
      ],
      30,
      new Vec2(0, 52),
    );
    dialog.addChild(occupationToggleGroup);

    const nameInputBackground = UiHelper.createSprite("role_name_input_background", "login/input_bg", new Vec2(0, -26), new Size(240, 60));
    const nameInput = UiHelper.createInputBox("role_name_input", "输入角色名称", new Vec2(0, -6), new Vec2(200, 60));
    nameInputBackground.addChild(nameInput);
    dialog.addChild(nameInputBackground);

    const createButton = UiHelper.createButton("confirm_create_role_button", "create_role/start_btn", new Vec2(0, -238), new Size(190, 48));
    createButton.getComponent(Sprite).grayscale = true;
    createButton.on(Node.EventType.TOUCH_END, callbacks.onCreateRole);
    dialog.addChild(createButton);

    const view: RoleSelectorCreateView = {
      backButton,
      dialog,
      nameInput,
      sexToggleGroup,
      occupationToggleGroup,
      createButton,
      occupationDescription: null,
      occupationPreview: null,
    };

    const eventHandler = new EventHandler();
    eventHandler.target = parent;
    eventHandler.component = "RoleSelector";
    eventHandler.handler = "onOccupationChanged";
    occupationToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);
    sexToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);

    this.updateOccupationSelection(view, occupations);
    return view;
  }

  /** 根据当前选中的职业与性别更新职业描述和预览 */
  static updateOccupationSelection(view: RoleSelectorCreateView, occupations: Map<OECCUPATION, RoleOccupationInfo>): void {
    const occupationId = view.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const sex = view.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const occupation = occupationId && occupations.get(occupationId as OECCUPATION);
    if (!occupation || !sex) return;

    view.occupationDescription?.destroy();
    view.occupationPreview?.destroy();

    view.occupationDescription = UiHelper.createSprite("occupation_description", occupation.description, new Vec2(0, -142), occupation.descriptionSize);
    view.dialog.addChild(view.occupationDescription);
    view.occupationPreview = this.createRolePreview("role_creation_preview", 0, occupationId, sex, new Vec2(-245, -95), new Size(200, 360));
    view.dialog.addChild(view.occupationPreview);
  }

  /** 读取创建角色表单（职业与性别取自选中开关的节点名称，即枚举值） */
  static readRoleForm(view: RoleSelectorCreateView): { name: string; occupation: OECCUPATION; sex: SEX } {
    const occupation = (view.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as OECCUPATION;
    const sex = (view.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as SEX;
    return {
      name: view.nameInput.getComponent(EditBox).string,
      occupation,
      sex,
    };
  }

  /** 根据名称输入同步创建按钮可用状态 */
  static syncCreateButtonState(view: RoleSelectorCreateView): void {
    view.createButton.getComponent(Sprite).grayscale = !Boolean(view.nameInput.getComponent(EditBox).string);
  }

  /** 关闭创建角色弹窗 */
  static closeRoleView(view: RoleSelectorCreateView): void {
    view.dialog.destroy();
    view.backButton.destroy();
  }

  //#endregion
}

