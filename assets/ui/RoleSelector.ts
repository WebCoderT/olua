import { _decorator, Component, EditBox, EventHandler, isValid, Label, Node, Sprite, ToggleContainer, UITransform, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import { occupations } from "../configs/role";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { OECCUPATION, SEX } from "../types/role";
import { applyScreenPolicy, getStageScale, onWindowResize } from "./utils/layout/ScreenLayout";
import { roleSelectorLayout } from "../configs/hudLayout";
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

/**
 * 选角场景（登录后的角色列表 + 创建角色弹窗）
 *
 * 结构：铺满窗口的背景（始终盖住整个窗口）+ 一块固定设计尺寸的「舞台」，
 * 其余元素全部挂在舞台下并按设计坐标摆放（坐标以舞台中心为原点）。
 * 舞台由 applyStageLayout 按当前可见尺寸等比缩放（contain、只缩不放），
 * 所以窗口宽高比与设计不一致（窄屏会裁左右 / 宽屏会裁上下）时构图依旧完整可见，
 * 新增元素只需按设计画布摆坐标，不必关心窗口尺寸。
 * 位置/尺寸/用图统一见 configs/hudLayout.roleSelectorLayout
 */
@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createView: RoleSelectorCreateView | null = null;
  private ownerRoleSelectedId: string | null = null;
  /** 舞台容器（除背景外的所有元素都挂这里，整体按可见尺寸等比缩放；见 applyStageLayout） */
  private stage: Node | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;

  start() {
    // 屏幕适配：铺满窗口（无黑边），与游戏内一致（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    // 背景（不在舞台内：铺满可见区，始终盖住整个窗口；舞台等比缩小后四周留白由它兜底）
    this.node.addChild(GameUiHelper.createFullScreenImage("role_selector_background", roleSelectorLayout.background));
    // 舞台容器：各元素按设计坐标摆在它下面（见 configs/hudLayout.roleSelectorLayout）
    this.stage = this.createStage();
    this.mainView = this.createMainView();
    // 按当前可见尺寸适配舞台，并在窗口尺寸变化时重排
    this.applyStageLayout();
    this.offWindowResize = onWindowResize(() => this.applyStageLayout());
    this.showOwnerRolesUI();
  }

  /** 场景卸载：取消窗口尺寸监听（监听挂在 screen 单例上，不随节点销毁） */
  onDestroy() {
    this.offWindowResize?.();
    this.offWindowResize = null;
  }

  /**
   * 创建舞台容器：尺寸为设计分辨率，各元素坐标以舞台中心为原点（与布局配置一致）
   */
  private createStage() {
    const stage = new Node("role_selector_stage");
    stage.addComponent(UITransform).setContentSize(roleSelectorLayout.stageSize);
    this.node.addChild(stage);
    return stage;
  }

  /**
   * 舞台适配（窗口尺寸变化时可重复调用）：按可见尺寸等比缩放整块舞台并居中
   *
   * 铺满窗口的适配策略下，窗口宽高比与设计（1624×750）不一致时必然有一边被裁：
   * 窗口偏窄（如 1024×768 → 可见区仅 1000×750）会裁掉左右，写死坐标的贴边元素
   * （左侧创建/管理/返回按钮、右侧创建角色弹窗）就整体跑到屏幕外看不见了；
   * 这里把整块舞台按 contain 比例缩小（只缩不放），构图恒完整落在可见区内
   */
  applyStageLayout() {
    const stage = this.stage;
    if (!stage || !isValid(stage, true)) return;
    const scale = getStageScale(roleSelectorLayout.stageSize);
    stage.setScale(scale, scale, 1);
  }

  beginGame() {
    if (this.ownerRoleSelectedId) {
      StorageManager.onlineRole(this.ownerRoleSelectedId);
      SceneManager.loadScene("Game");
    }
  }

  /** 拼装选角主视图（元素全部挂舞台，坐标见 configs/hudLayout.roleSelectorLayout） */
  private createMainView(): RoleSelectorMainView {
    // 位置/尺寸与用图统一见 configs/hudLayout.roleSelectorLayout
    const layout = roleSelectorLayout;
    // 底部栏
    const bottomBar = GameUiHelper.createImage(layout.bottomBar.name, layout.bottomBar.image, layout.bottomBar.position, layout.bottomBar.size);
    this.stage!.addChild(bottomBar);
    // 开始游戏按钮（默认置灰，选中角色后可用）
    const beginLayout = layout.beginGameButton;
    const beginGameButton = GameUiHelper.createTexturedButton(beginLayout.name, beginLayout.image, "", beginLayout.position, beginLayout.size);
    beginGameButton.getComponent(Sprite).grayscale = true;
    beginGameButton.on(Node.EventType.TOUCH_END, () => this.beginGame());
    bottomBar.addChild(beginGameButton);
    // 创建角色按钮
    const createLayout = layout.createRoleButton;
    const createRoleButton = GameUiHelper.createTexturedButton(createLayout.name, createLayout.image, "", createLayout.position, createLayout.size);
    createRoleButton.on(Node.EventType.TOUCH_END, () => this.createRoleUI());
    this.stage!.addChild(createRoleButton);
    // 管理角色按钮
    const manageLayout = layout.manageRoleButton;
    this.stage!.addChild(GameUiHelper.createTexturedButton(manageLayout.name, manageLayout.image, "", manageLayout.position, manageLayout.size));
    // 选中角色信息框（名称 + 等级）
    const infoLayout = layout.selectedInfo;
    const selectedInfoBox = GameUiHelper.createImage(infoLayout.name, infoLayout.image, infoLayout.position, infoLayout.size);
    selectedInfoBox.addChild(GameUiHelper.createText(infoLayout.nameLabel.name, infoLayout.nameLabel.text, infoLayout.nameLabel.fontSize, infoLayout.nameLabel.position, infoLayout.nameLabel.size));
    selectedInfoBox.addChild(GameUiHelper.createText(infoLayout.levelLabel.name, infoLayout.levelLabel.text, infoLayout.levelLabel.fontSize, infoLayout.levelLabel.position, infoLayout.levelLabel.size));
    this.stage!.addChild(selectedInfoBox);
    return {
      beginGameButton,
      selectedRoleName: selectedInfoBox.getChildByName(infoLayout.nameLabel.name),
      selectedRoleLevel: selectedInfoBox.getChildByName(infoLayout.levelLabel.name),
      ownerRoleNodes: [],
    };
  }

  /** 展示已有角色预览列表 */
  showOwnerRolesUI() {
    this.mainView.ownerRoleNodes.forEach((node) => node.destroy());
    this.mainView.ownerRoleNodes.length = 0;
    StorageManager.getRoles().forEach((role, index) => {
      const node = GameUiHelper.createRolePreview(role.id, 1, role.occupation, role.sex, roleSelectorLayout.rolePositions[index] ?? new Vec2(), roleSelectorLayout.previewSize);
      node.on(Node.EventType.TOUCH_END, () => this.onlineRole(role.id));
      this.stage!.addChild(node);
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

  /** 拼装创建角色弹窗视图（位置/尺寸与用图见 configs/hudLayout.roleSelectorLayout.createDialog） */
  private createCreateRoleView(): RoleSelectorCreateView {
    const layout = roleSelectorLayout.createDialog;
    // 返回按钮
    const backLayout = roleSelectorLayout.backButton;
    const backButton = GameUiHelper.createTexturedButton(backLayout.name, backLayout.image, "", backLayout.position, backLayout.size);
    this.stage!.addChild(backButton);
    backButton.on(Node.EventType.TOUCH_END, () => this.cancelCreateRoleUI());
    // 弹窗主体与标题
    const dialog = GameUiHelper.createImage(layout.name, layout.image, layout.position, layout.size);
    this.stage!.addChild(dialog);
    dialog.addChild(GameUiHelper.createImage(layout.title.name, layout.title.image, layout.title.position, layout.title.size));
    dialog.addChild(GameUiHelper.createImage(layout.genderLabel.name, layout.genderLabel.image, layout.genderLabel.position, layout.genderLabel.size));
    // 性别开关组
    const sexToggleGroup = GameUiHelper.createSexToggleGroup();
    dialog.addChild(sexToggleGroup);
    dialog.addChild(GameUiHelper.createImage(layout.occupationLabel.name, layout.occupationLabel.image, layout.occupationLabel.position, layout.occupationLabel.size));
    // 职业开关组
    const occupationToggleGroup = GameUiHelper.createOccupationToggleGroup();
    dialog.addChild(occupationToggleGroup);
    // 名称输入框
    const nameInput = GameUiHelper.createInputField(layout.nameInput.placeholder, layout.nameInput.position, layout.nameInput.size);
    dialog.addChild(nameInput.node);
    // 创建按钮（默认置灰，输入名称后可用）
    const createLayout = layout.createButton;
    const createButton = GameUiHelper.createTexturedButton(createLayout.name, createLayout.image, "", createLayout.position, createLayout.size);
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

    const descLayout = roleSelectorLayout.createDialog.occupationDescription;
    view.occupationDescription = GameUiHelper.createImage("occupation_description", occupation.description, descLayout.position, occupation.descriptionSize);
    view.dialog.addChild(view.occupationDescription);
    const previewLayout = roleSelectorLayout.createDialog.occupationPreview;
    view.occupationPreview = GameUiHelper.createRolePreview("role_creation_preview", 0, occupationId, sex, previewLayout.position, previewLayout.size);
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
