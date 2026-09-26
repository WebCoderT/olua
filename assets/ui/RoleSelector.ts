import { _decorator, Color, Component, EditBox, EventHandler, Input, Label, Node, NodeEventType, Size, Sprite, ToggleContainer, UI, Vec2 } from "cc";
import UiHelper from "./helpers/UiHelper";
import { OECCUPATION, Role, roles } from "../configs";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageHelper from "./helpers/StorageHelper";
import SceneManager from "./SceneManager";
const { ccclass } = _decorator;

@ccclass("RoleSelector")
export class RoleSelector extends Component {
  // 是否创建角色中
  isCreateRole: boolean = false;
  // 开始游戏按钮
  beginGameButton: Node;

  start() {
    // 角色选择界面
    this.node.addChild(UiHelper.createFullScreenNode("role_selector_background", "create_role/bg"));
    // 创建角色时开始游戏按钮
    const bottomBar = UiHelper.createSprite("role_selector_bottom_bar", "create_role/bg_bottom", new Vec2(0, -305), new Size(1624, 139));
    this.node.addChild(bottomBar);
    // 开始游戏按钮
    this.beginGameButton = UiHelper.createButton("begin_game_button", "create_role/start_btn", new Vec2(0, -40), new Size(190, 48));
    this.beginGameButton.getComponent(Sprite).grayscale = true;
    this.beginGameButton.on(Node.EventType.TOUCH_END, this.beginGame, this);
    bottomBar.addChild(this.beginGameButton);
    // 创建角色按钮
    const createRoleButton = UiHelper.createButton("show_create_role_button", "create_role/new_role", new Vec2(-740, 300), new Size(75, 79));
    this.node.addChild(createRoleButton);
    createRoleButton.on(Node.EventType.TOUCH_END, this.createRoleUI, this);
    // 管理角色按钮
    const manageRoleButton = UiHelper.createButton("manage_role_button", "create_role/manage", new Vec2(-740, 200), new Size(75, 79));
    this.node.addChild(manageRoleButton);
    // 展示已有角色
    this.showOwnerRolesUI();
    // 已选角色ui
    this.selectedRoleInfoUI();
  }

  // 开始游戏
  beginGame() {
    if (this.ownerRoleSelectedId) {
      StorageHelper.selectRole(this.ownerRoleSelectedId);
      SceneManager.loadScene("Game");
    }
  }

  // 已有角色展示位置
  ownerRolePositions = [new Vec2(-485, -25), new Vec2(-250, -75), new Vec2(-10, -40)];
  // 已有角色展示的节点列表
  ownerRoleNodes: Node[] = [];

  // 展示已有角色UI
  showOwnerRolesUI() {
    this.ownerRoleNodes.forEach((n) => n.destroy());
    this.ownerRoleNodes.length = 0;
    const roles = StorageHelper.getRoles();
    roles.forEach((role, index) => {
      const node = GameUiHelper.createRolePreview(role.id, 1, role.occupation, role.sex, this.ownerRolePositions[index], new Size(200, 360));
      this.ownerRoleNodes.push(node);
      this.node.addChild(node);
      node.on(Node.EventType.TOUCH_END, this.ownerRoleSelect, this);
    });
  }

  // 已选择的角色id
  ownerRoleSelectedId: string | null = null;

  // 已有角色选择
  ownerRoleSelect(event: TouchEvent) {
    const node = event.target as unknown as Node;
    this.ownerRoleSelectedId = node.name;
    const role = StorageHelper.findRoleById(this.ownerRoleSelectedId);
    this.beginGameButton.getComponent(Sprite).grayscale = false;
    this.updateSelectRoleInfoUI(role);
  }

  // 创建角色弹窗
  createRoleDialog: Node;
  // 返回按钮，结束创建角色
  backButton: Node;
  // 创建角色时名称输入框
  roleNameInput: Node;
  // 创建角色时性别选择框
  roleSexToggleGroup: Node;
  // 创建角色时职业选择框
  roleOccupationToggleGroup: Node;
  // 确认创建角色时按钮
  createRoleButton: Node;
  // 职业文字介绍
  occupationDescription: Node;

  // 创建角色时UI
  createRoleUI() {
    if (this.isCreateRole) return;
    this.isCreateRole = true;
    // 返回按钮
    this.backButton = UiHelper.createButton("cancel_create_role_button", "create_role/back_btn", new Vec2(-740, -210), new Size(75, 79));
    this.node.addChild(this.backButton);
    this.createRoleDialogUI();
    this.backButton.on(Node.EventType.TOUCH_END, this.cancelCreateRoleUI, this);
  }

  // 创建角色弹窗
  createRoleDialogUI() {
    // 创建事件处理器
    const eventHandler = new EventHandler();
    eventHandler.target = this.node; // 脚本挂载的节点
    eventHandler.component = "RoleSelector"; // 脚本类名
    eventHandler.handler = "occupationDescriptionUI"; // 回调函数名

    // 创建角色弹窗
    this.createRoleDialog = UiHelper.createSprite("create_role_dialog", "create_role/bg_dialog", new Vec2(630, 35), new Size(320, 580));
    this.node.addChild(this.createRoleDialog);
    // 标题
    this.createRoleDialog.addChild(UiHelper.createSprite("create_role_dialog_title", "create_role/label_title", new Vec2(0, 242), new Size(128, 28)));
    // 性别
    this.createRoleDialog.addChild(UiHelper.createSprite("gender_label", "create_role/label_1", new Vec2(0, 190), new Size(56, 25)));
    // 性别选择
    this.roleSexToggleGroup = UiHelper.createToggleGroup(
      "role_sex_toggle_group",
      [
        UiHelper.createToggle("1", "create_role/1_1", "create_role/1_0", new Vec2(0, 0), new Size(48, 48)),
        UiHelper.createToggle("2", "create_role/2_1", "create_role/2_0", new Vec2(0, 0), new Size(48, 48)),
      ],
      30,
      new Vec2(0, 148),
    );
    this.roleSexToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);
    this.createRoleDialog.addChild(this.roleSexToggleGroup);
    // 职业
    this.createRoleDialog.addChild(UiHelper.createSprite("occupation_label", "create_role/label_2", new Vec2(0, 100), new Size(56, 25)));
    this.roleOccupationToggleGroup = UiHelper.createToggleGroup(
      "role_occupation_toggle_group",
      [
        UiHelper.createToggle("1", "create_role/3_1", "create_role/3_0", new Vec2(0, 0), new Size(48, 48)),
        UiHelper.createToggle("2", "create_role/4_1", "create_role/4_0", new Vec2(0, 0), new Size(48, 48)),
        UiHelper.createToggle("3", "create_role/5_1", "create_role/5_0", new Vec2(0, 0), new Size(48, 48)),
      ],
      30,
      new Vec2(0, 52),
    );
    this.roleOccupationToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);
    this.createRoleDialog.addChild(this.roleOccupationToggleGroup);

    // 职业介绍
    this.occupationDescriptionUI();

    // 职业预览
    this.occupationPreviewUI();

    // 角色名称输入框
    const roleNameInputBg = UiHelper.createSprite("role_name_input_background", "login/input_bg", new Vec2(0, -26), new Size(240, 60));
    this.roleNameInput = UiHelper.createInputBox("role_name_input", "输入角色名称", new Vec2(0, -6), new Vec2(200, 60));
    roleNameInputBg.addChild(this.roleNameInput);
    this.createRoleDialog.addChild(roleNameInputBg);

    // 创建角色按钮
    this.createRoleButton = UiHelper.createButton("confirm_create_role_button", "create_role/start_btn", new Vec2(0, -238), new Size(190, 48));
    this.createRoleButton.getComponent(Sprite).grayscale = true;
    this.createRoleButton.on(Node.EventType.TOUCH_END, this.createRole, this);
    this.createRoleDialog.addChild(this.createRoleButton);
  }

  // 职业文字介绍
  occupationDescriptionUI() {
    this.occupationDescription?.destroy();
    const activeOccupationId = this.roleOccupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0].node.name;
    const activeOccupation = roles.get(activeOccupationId as unknown as OECCUPATION);
    this.occupationDescription = UiHelper.createSprite("occupation_description", activeOccupation.description, new Vec2(0, -142), activeOccupation.descriptionSize);
    this.createRoleDialog.addChild(this.occupationDescription);
    // 职业文字更换后，同时更换预览效果
    this.occupationPreviewUI();
  }

  // 职业预览
  occupationPreview: Node;
  // 职业效果预览UI
  occupationPreviewUI() {
    this.occupationPreview?.destroy();
    const activeOccupation = this.roleOccupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0].node.name;
    const activeSex = this.roleSexToggleGroup.getComponent(ToggleContainer).activeToggles()[0].node.name;
    this.occupationPreview = GameUiHelper.createRolePreview("", 0, activeOccupation, activeSex, new Vec2(-245, -95), new Size(200, 360));
    this.createRoleDialog.addChild(this.occupationPreview);
  }

  // 取消创建角色
  cancelCreateRoleUI() {
    this.createRoleDialog.destroy();
    this.backButton.destroy();
    this.isCreateRole = false;
  }

  // 确认创建角色
  createRole() {
    const name = this.roleNameInput.getComponent(EditBox).string;
    const activeOccupation = this.roleOccupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0].node.name;
    const activeSex = this.roleSexToggleGroup.getComponent(ToggleContainer).activeToggles()[0].node.name;
    StorageHelper.createRole(name, activeOccupation, activeSex);
    this.cancelCreateRoleUI();
    this.showOwnerRolesUI();
  }

  // 已选择的角色名称
  roleSelectedName: Node;
  // 已选择的角色等级
  roleSelectedLevel: Node;
  // 已选择的角色UI
  selectedRoleInfoUI() {
    const selectedInfoBox = UiHelper.createSprite("selected_role_info_background", "create_role/idlv", new Vec2(-435, -335), new Size(345, 26));
    this.node.addChild(selectedInfoBox);
    this.roleSelectedName = UiHelper.createLabel("selected_role_name", "---", Color.WHITE, 20, new Vec2(-35, 0), new Size(160, 30));
    this.roleSelectedLevel = UiHelper.createLabel("selected_role_level", "-", Color.WHITE, 16, new Vec2(147, 0), new Size(40, 30));
    selectedInfoBox.addChild(this.roleSelectedName);
    selectedInfoBox.addChild(this.roleSelectedLevel);
  }

  // 修改已选择的信息
  updateSelectRoleInfoUI(role: Role) {
    this.roleSelectedName.getComponent(Label).string = role.name;
    this.roleSelectedLevel.getComponent(Label).string = role.level.toString();
  }

  update(deltaTime: number) {
    // 判断创建角色按钮是否可用
    this.isCreateRole && (this.createRoleButton.getComponent(Sprite).grayscale = !Boolean(this.roleNameInput.getComponent(EditBox).string));
  }
}
