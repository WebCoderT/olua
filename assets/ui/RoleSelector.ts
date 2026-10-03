import { _decorator, Component, EditBox, EventHandler, Label, Node, Size, Sprite, ToggleContainer, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import { occupations } from "../configs/role";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { OECCUPATION, SEX } from "../types/role";
import { applyScreenPolicy } from "./utils/layout/ScreenLayout";
const { ccclass } = _decorator;

/** 选角主视图引用（本组件拼装并持有） */
interface RoleSelectorMainView {
  beginGameButton: Node;
  selectedRoleName: Node;
  selectedRoleLevel: Node;
  ownerRoleNodes: Node[];
}

/** 创建角色弹窗视图引用（本组件拼装并持有） */
interface RoleSelectorCreateView {
  backButton: Node;
  dialog: Node;
  nameInput: Node;
  sexToggleGroup: Node;
  occupationToggleGroup: Node;
  createButton: Node;
  occupationDescription: Node | null;
  occupationPreview: Node | null;
}

/** 角色预览默认站位（最多3个角色） */
const rolePositions = [new Vec2(-485, -25), new Vec2(-250, -75), new Vec2(-10, -40)];

@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createView: RoleSelectorCreateView | null = null;
  private ownerRoleSelectedId: string | null = null;

  start() {
    // 屏幕适配：铺满窗口（无黑边），与游戏内一致（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    this.mainView = this.createMainView();
    this.showOwnerRolesUI();
  }

  beginGame() {
    if (this.ownerRoleSelectedId) {
      StorageManager.onlineRole(this.ownerRoleSelectedId);
      SceneManager.loadScene("Game");
    }
  }

  /** 拼装选角主视图 */
  private createMainView(): RoleSelectorMainView {
    // 背景与底部栏
    this.node.addChild(GameUiHelper.createFullScreenImage("role_selector_background", "create_role/bg"));
    const bottomBar = GameUiHelper.createImage("role_selector_bottom_bar", "create_role/bg_bottom", new Vec2(0, -305), new Size(1624, 139));
    this.node.addChild(bottomBar);
    // 开始游戏按钮（默认置灰，选中角色后可用）
    const beginGameButton = GameUiHelper.createTexturedButton("begin_game_button", "create_role/start_btn", "", new Vec2(0, -40), new Size(190, 48));
    beginGameButton.getComponent(Sprite).grayscale = true;
    beginGameButton.on(Node.EventType.TOUCH_END, () => this.beginGame());
    bottomBar.addChild(beginGameButton);
    // 创建角色按钮
    const createRoleButton = GameUiHelper.createTexturedButton("show_create_role_button", "create_role/new_role", "", new Vec2(-740, 300), new Size(75, 79));
    createRoleButton.on(Node.EventType.TOUCH_END, () => this.createRoleUI());
    this.node.addChild(createRoleButton);
    // 管理角色按钮
    this.node.addChild(GameUiHelper.createTexturedButton("manage_role_button", "create_role/manage", "", new Vec2(-740, 200), new Size(75, 79)));
    // 选中角色信息框
    const selectedInfoBox = GameUiHelper.createImage("selected_role_info_background", "create_role/idlv", new Vec2(-435, -335), new Size(345, 26));
    selectedInfoBox.addChild(GameUiHelper.createText("selected_role_name", "---", 20, new Vec2(-35, 0), new Size(160, 30)));
    selectedInfoBox.addChild(GameUiHelper.createText("selected_role_level", "-", 16, new Vec2(147, 0), new Size(40, 30)));
    this.node.addChild(selectedInfoBox);
    return {
      beginGameButton,
      selectedRoleName: selectedInfoBox.getChildByName("selected_role_name"),
      selectedRoleLevel: selectedInfoBox.getChildByName("selected_role_level"),
      ownerRoleNodes: [],
    };
  }

  /** 展示已有角色预览列表 */
  showOwnerRolesUI() {
    this.mainView.ownerRoleNodes.forEach((node) => node.destroy());
    this.mainView.ownerRoleNodes.length = 0;
    StorageManager.getRoles().forEach((role, index) => {
      const node = GameUiHelper.createRolePreview(role.id, 1, role.occupation, role.sex, rolePositions[index] ?? new Vec2(), new Size(200, 360));
      node.on(Node.EventType.TOUCH_END, () => this.onlineRole(role.id));
      this.node.addChild(node);
      this.mainView.ownerRoleNodes.push(node);
    });
  }

  private onlineRole(roleId: string) {
    this.ownerRoleSelectedId = roleId;
    const role = StorageManager.findRoleById(this.ownerRoleSelectedId);
    if (!role) return;
    // 开始游戏按钮可用，并更新名字与等级显示
    this.mainView.beginGameButton.getComponent(Sprite).grayscale = false;
    this.mainView.selectedRoleName.getComponent(Label).string = role.name;
    this.mainView.selectedRoleLevel.getComponent(Label).string = role.level.toString();
  }

  createRoleUI() {
    if (this.createView) return;
    this.createView = this.createCreateRoleView();
  }

  /** 拼装创建角色弹窗视图 */
  private createCreateRoleView(): RoleSelectorCreateView {
    // 返回按钮
    const backButton = GameUiHelper.createTexturedButton("cancel_create_role_button", "create_role/back_btn", "", new Vec2(-740, -210), new Size(75, 79));
    this.node.addChild(backButton);
    backButton.on(Node.EventType.TOUCH_END, () => this.cancelCreateRoleUI());
    // 弹窗主体与标题
    const dialog = GameUiHelper.createImage("create_role_dialog", "create_role/bg_dialog", new Vec2(630, 35), new Size(320, 580));
    this.node.addChild(dialog);
    dialog.addChild(GameUiHelper.createImage("create_role_dialog_title", "create_role/label_title", new Vec2(0, 242), new Size(128, 28)));
    dialog.addChild(GameUiHelper.createImage("gender_label", "create_role/label_1", new Vec2(0, 190), new Size(56, 25)));
    // 性别开关组
    const sexToggleGroup = GameUiHelper.createSexToggleGroup();
    dialog.addChild(sexToggleGroup);
    dialog.addChild(GameUiHelper.createImage("occupation_label", "create_role/label_2", new Vec2(0, 100), new Size(56, 25)));
    // 职业开关组
    const occupationToggleGroup = GameUiHelper.createOccupationToggleGroup();
    dialog.addChild(occupationToggleGroup);
    // 名称输入框
    const nameInput = GameUiHelper.createInputField("输入角色名称", new Vec2(0, -26), new Size(240, 60));
    dialog.addChild(nameInput.node);
    // 创建按钮（默认置灰，输入名称后可用）
    const createButton = GameUiHelper.createTexturedButton("confirm_create_role_button", "create_role/start_btn", "", new Vec2(0, -238), new Size(190, 48));
    createButton.getComponent(Sprite).grayscale = true;
    createButton.on(Node.EventType.TOUCH_END, () => this.createRole());
    dialog.addChild(createButton);
    // 职业/性别变更事件（通过场景组件回调）
    const eventHandler = new EventHandler();
    eventHandler.target = this.node;
    eventHandler.component = "RoleSelector";
    eventHandler.handler = "onOccupationChanged";
    occupationToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);
    sexToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);

    const view: RoleSelectorCreateView = {
      backButton,
      dialog,
      nameInput: nameInput.input,
      sexToggleGroup,
      occupationToggleGroup,
      createButton,
      occupationDescription: null,
      occupationPreview: null,
    };
    this.updateOccupationSelection();
    return view;
  }

  /** 根据当前选中的职业与性别更新职业描述和预览 */
  onOccupationChanged() {
    if (this.createView) this.updateOccupationSelection();
  }

  private updateOccupationSelection() {
    const view = this.createView;
    if (!view) return;
    const occupationId = view.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const sex = view.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const occupation = occupationId && occupations.get(occupationId as OECCUPATION);
    if (!occupation || !sex) return;

    view.occupationDescription?.destroy();
    view.occupationPreview?.destroy();

    view.occupationDescription = GameUiHelper.createImage("occupation_description", occupation.description, new Vec2(0, -142), occupation.descriptionSize);
    view.dialog.addChild(view.occupationDescription);
    view.occupationPreview = GameUiHelper.createRolePreview("role_creation_preview", 0, occupationId, sex, new Vec2(-245, -95), new Size(200, 360));
    view.dialog.addChild(view.occupationPreview);
  }

  cancelCreateRoleUI() {
    if (!this.createView) return;
    this.createView.dialog.destroy();
    this.createView.backButton.destroy();
    this.createView = null;
  }

  createRole() {
    if (!this.createView) return;
    // 读取表单（职业与性别取自选中开关的节点名称，即枚举值）
    const occupation = (this.createView.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as OECCUPATION;
    const sex = (this.createView.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as SEX;
    const name = this.createView.nameInput.getComponent(EditBox).string;
    if (!name) return;
    StorageManager.createRole(name, occupation, sex);
    this.cancelCreateRoleUI();
    this.showOwnerRolesUI();
  }

  update() {
    // 名称输入同步创建按钮可用状态
    if (this.createView) this.createView.createButton.getComponent(Sprite).grayscale = !Boolean(this.createView.nameInput.getComponent(EditBox).string);
  }
}
