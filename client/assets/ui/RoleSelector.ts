import { _decorator, Color, Component, EditBox, EventHandler, isValid, Label, Node, Size, Sprite, ToggleContainer, UITransform, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import { maxRoleCount, occupations } from "../configs/role";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { OECCUPATION, SEX } from "../types/role";
import { applyScreenPolicy, getAnchoredPosition, getStageScale, getVisibleSize, onWindowResize } from "./utils/layout/ScreenLayout";
import { roleSelectorLayout, uiImages } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { Role } from "../entities/Role";
import { RoleApi } from "./utils/net/Api";
import type { RoleSummary } from "./utils/net/Api";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
const { ccclass } = _decorator;

/** 删除角色按钮的节点名前缀（按钮文字挂在 `<节点名>_label` 上，改文案时按它取；节点名带角色 id 便于排查） */
const DELETE_ROLE_BUTTON_PREFIX = "delete_role_";

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
 * 角色数据**以服务端为准**：进场景拉一次角色列表（概要），选角色时才拉完整数据写进本地缓存
 * （游戏内各处读角色是同步的，所以必须有一份本地完整数据，见 StorageManager.cacheRole）。
 * 协议见 ui/utils/net —— 本组件不写路径、不拼地址、不管令牌。
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
  /** 舞台容器（除背景与底部栏外的所有元素都挂这里，整体按可见尺寸等比缩放；见 applyStageLayout） */
  private stage: Node | null = null;
  /**
   * 底部栏（不在舞台内）：横跨可见宽 + 贴屏幕底边，位置/缩放由 applyStageLayout 实时算
   * （素材带牌匾装饰不可拉伸变形，只能等比缩放；跟舞台缩会两侧露背景、且不贴屏幕底边）
   */
  private bottomBar: Node | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;
  /** 是否处于管理模式（「管理」按钮开关，开启后各角色站位上方出现删除按钮） */
  private manageMode = false;
  /** 管理模式的临时节点（提示条 + 各角色的删除按钮）：退出管理模式或刷新列表时统一销毁 */
  private manageNodes: Node[] = [];
  /** 待确认删除的角色 id（两步确认的第一步之后有值，见 onDeleteRoleClick） */
  private pendingDeleteId: string | null = null;
  /** 待确认删除按钮（复位文案要改它） */
  private pendingDeleteButton: Node | null = null;
  /** 待确认状态的超时定时器（到点自动复位） */
  private deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** 服务端返回的角色列表（本场景的展示来源；本地角色缓存只在进游戏时才写） */
  private roleSummaries: RoleSummary[] = [];
  /** 是否有请求在途（创建 / 进游戏），避免连点重复提交 */
  private busy = false;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
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
    // 角色列表来自服务端（拉取失败由网络层统一提示，列表保持空）
    void this.loadRoles();
  }

  /** 场景卸载：取消窗口尺寸监听（监听挂在 screen 单例上，不随节点销毁），并清掉待确认定时器 */
  onDestroy() {
    this.offWindowResize?.();
    this.offWindowResize = null;
    this.cancelDeleteConfirm();
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
   * 舞台与底部栏适配（窗口尺寸变化时可重复调用）
   *
   * 铺满窗口的适配策略下，窗口宽高比与设计（1624×750）不一致时必然有一边被裁：
   * 窗口偏窄（如 1024×768 → 可见区仅 1000×750）会裁掉左右，写死坐标的贴边元素
   * （左侧创建/管理/返回按钮、右侧创建角色弹窗）就整体跑到屏幕外看不见了；
   * 这里把整块舞台按 contain 比例缩小（只缩不放），构图恒完整落在可见区内。
   *
   * 底部栏不进舞台（见 roleSelectorLayout.bottomBar 注释）：它按**可见宽**等比缩放
   * （素材不可拉伸，等比才不变形；铺满窗口策略下可见宽恒 ≤ 设计宽 1624，系数恒 ≤ 1
   * 不会放大模糊），再贴屏幕底边 —— 任何分辨率下都横跨整屏、紧贴下边缘
   */
  applyStageLayout() {
    const stage = this.stage;
    if (!stage || !isValid(stage, true)) return;
    const visible = getVisibleSize();
    const scale = getStageScale(roleSelectorLayout.stageSize, visible);
    stage.setScale(scale, scale, 1);
    const bar = this.bottomBar;
    if (!bar || !isValid(bar, true)) return;
    const barLayout = roleSelectorLayout.bottomBar;
    const barScale = visible.width / barLayout.size.width;
    const visual = new Size(barLayout.size.width * barScale, barLayout.size.height * barScale);
    // 贴底：bottom-center 语义 = 区块中心到屏幕下边缘 = 缩放后高度的一半（setPosition 不吃 Vec2，拆开传）
    const position = getAnchoredPosition(visual, visible, "bottom-center", 0, visual.height / 2);
    bar.setScale(barScale, barScale, 1);
    bar.setPosition(position.x, position.y, 0);
  }

  /** 「开始游戏」：把选中角色同步到服务端（成为该账号的在线角色）并拉完整数据，然后进游戏场景 */
  beginGame() {
    if (this.ownerRoleSelectedId) void this.enterGame(this.ownerRoleSelectedId);
  }

  /**
   * 拉取角色列表（服务端为准）
   *
   * 成功时顺手清掉本地缓存里服务端已经没有的角色（例如换账号登录、或在别处被删过），
   * 避免进游戏时读到一个已不存在的角色；失败时**不清缓存**（网络抖动不该毁本地存档）。
   */
  private async loadRoles() {
    let summaries: RoleSummary[];
    try {
      summaries = await RoleApi.list();
    } catch (error) {
      console.warn(`[RoleSelector] 角色列表加载失败：${describeError(error)}`);
      this.roleSummaries = [];
      this.showOwnerRolesUI();
      return;
    }
    this.roleSummaries = summaries;
    const ids = summaries.map((item) => item.id);
    StorageManager.getRoles().forEach((role) => {
      if (ids.indexOf(role.id) === -1) StorageManager.deleteRole(role.id);
    });
    this.showOwnerRolesUI();
  }

  /**
   * 进入游戏
   *
   * 一次请求做两件事：服务端把该角色记为该账号的在线角色，并返回**完整角色数据**；
   * 把完整数据写进本地缓存后，游戏内所有同步读取（findOnlineRole/getRoles）照旧可用。
   */
  private async enterGame(roleId: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      const detail = await RoleApi.select(roleId);
      // 服务端返回的完整数据（含修订号）写进本地缓存；数据不完整就停在选角界面，别进一个没有角色的游戏
      if (!StorageManager.cacheServerRole(detail)) return;
      StorageManager.onlineRole(roleId);
      SceneManager.loadScene("Game");
    } catch (error) {
      console.warn(`[RoleSelector] 进入角色失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /** 拼装选角主视图（元素全部挂舞台，坐标见 configs/hudLayout.roleSelectorLayout） */
  private createMainView(): RoleSelectorMainView {
    // 位置/尺寸与用图统一见 configs/hudLayout.roleSelectorLayout
    const layout = roleSelectorLayout;
    // 底部栏（不在舞台内，挂场景根；位置/缩放见 applyStageLayout —— 初次位置由它算，这里不用摆）
    const bottomBar = GameUiHelper.createImage(layout.bottomBar.name, layout.bottomBar.image, undefined, layout.bottomBar.size);
    this.node.addChild(bottomBar);
    this.bottomBar = bottomBar;
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
    // 管理角色按钮（管理模式的开关：开启后各角色站位上方出现删除按钮，见 toggleManageRole）
    const manageLayout = layout.manageRoleButton;
    const manageRoleButton = GameUiHelper.createTexturedButton(manageLayout.name, manageLayout.image, "", manageLayout.position, manageLayout.size);
    manageRoleButton.on(Node.EventType.TOUCH_END, () => this.toggleManageRole());
    this.stage!.addChild(manageRoleButton);
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

  /** 按服务端角色列表重建站位预览（列表变化：进场景 / 新建 / 删除后调用） */
  showOwnerRolesUI() {
    this.mainView.ownerRoleNodes.forEach((node) => {
      if (isValid(node)) node.destroy();
    });
    this.mainView.ownerRoleNodes.length = 0;
    this.roleSummaries.forEach((role, index) => {
      const node = GameUiHelper.createRolePreview(role.id, 1, role.occupation, role.sex, roleSelectorLayout.rolePositions[index] ?? new Vec2(), roleSelectorLayout.previewSize);
      node.on(Node.EventType.TOUCH_END, () => this.onlineRole(role.id));
      this.stage!.addChild(node);
      this.mainView.ownerRoleNodes.push(node);
    });
    // 管理模式下列表变了（如刚删掉一个角色）→ 删除按钮按新列表重建
    if (this.manageMode) this.refreshManageControls();
  }

  //#region 角色管理（删除）

  /**
   * 「管理」按钮：进入 / 退出管理模式
   * 管理模式 = 各角色站位上方出现删除按钮（挂舞台，不在角色预览子树里 —— 预览自带 TOUCH_END 选中事件，
   * 按钮挂在它下面会被冒泡吞掉，点删除会连带选中该角色）
   */
  private toggleManageRole() {
    if (this.manageMode) {
      this.manageMode = false;
      this.cancelDeleteConfirm();
      this.clearManageNodes();
      return;
    }
    this.manageMode = true;
    this.refreshManageControls();
    GameUiHelper.createTip("role_delete_mode_tip");
  }

  /** 按当前角色列表重建管理模式的提示条与删除按钮（进入管理模式、删除角色后刷新列表时调用） */
  private refreshManageControls() {
    this.clearManageNodes();
    if (!this.manageMode || !this.stage) return;
    const layout = roleSelectorLayout.manageRole;
    // 提示条（文案见 configs/texts.label_role_delete_hint）
    const hint = GameUiHelper.createText(layout.hint.name, getText("label_role_delete_hint"), layout.hint.fontSize, layout.hint.position, layout.hint.size, layout.hint.color);
    this.stage.addChild(hint);
    this.manageNodes.push(hint);
    // 每个角色站位上方一个删除按钮（位置由站位 + 偏移推导，角色数量变化时跟着重建）
    this.roleSummaries.forEach((role, index) => {
      const stand = roleSelectorLayout.rolePositions[index];
      if (!stand) return;
      const button = GameUiHelper.createTexturedButton(
        `${DELETE_ROLE_BUTTON_PREFIX}${role.id}`,
        uiImages.middleRedButtonBackground,
        getText("label_role_delete"),
        new Vec2(stand.x + layout.deleteButtonOffset.x, stand.y + layout.deleteButtonOffset.y),
        layout.deleteButtonSize,
        Color.WHITE,
        layout.deleteButtonFontSize,
      );
      button.on(Node.EventType.TOUCH_END, () => this.onDeleteRoleClick(role.id, button), this);
      this.stage!.addChild(button);
      this.manageNodes.push(button);
    });
  }

  /** 销毁管理模式的临时节点（提示条 + 删除按钮） */
  private clearManageNodes() {
    this.manageNodes.forEach((node) => {
      if (isValid(node)) node.destroy();
    });
    this.manageNodes.length = 0;
  }

  /**
   * 删除按钮点击：两步确认（与背包「一键回收」同一套口径）
   *
   * 删除角色不可恢复，所以不让一次点击就生效：
   * 1. 第一次点击：不改数据，只把要删的角色名报给玩家，按钮文案变「确认删除」；
   * 2. 期间再点同一个按钮：调服务端真删（服务端成功后才动本地缓存与列表）；
   * 3. 超时（manageRole.confirmTimeout）、点了别的角色的删除按钮、退出管理模式或关场景：文案复位，
   *    下次点击重新从第 1 步开始。
   * 不弹确认框的原因与背包回收一致：不新增节点与鼠标监听，也就没有层级与点击穿透的坑
   */
  private onDeleteRoleClick(roleId: string, button: Node) {
    // 点了别的角色的删除按钮 → 先放弃上一个待确认状态（避免两个按钮同时挂着「确认删除」）
    if (this.pendingDeleteId && this.pendingDeleteId !== roleId) this.cancelDeleteConfirm();
    if (this.pendingDeleteId !== roleId) {
      const summary = this.roleSummaries.find((item) => item.id === roleId);
      if (!summary) {
        GameUiHelper.createTip("role_delete_missing_tip");
        this.refreshManageControls();
        return;
      }
      this.pendingDeleteId = roleId;
      this.pendingDeleteButton = button;
      this.setDeleteButtonText(button, getText("label_role_delete_confirm"));
      GameUiHelper.createTip("role_delete_confirm_tip", { name: summary.name });
      // 到点自动复位：免得「确认删除」一直挂着被无意点掉
      this.deleteConfirmTimer = setTimeout(() => this.cancelDeleteConfirm(), roleSelectorLayout.manageRole.confirmTimeout);
      return;
    }
    // 第二步：确认删除（先复位按钮与定时器，再发请求）
    void this.confirmDeleteRole(roleId);
  }

  /** 真删：服务端成功 → 本地缓存与列表同步更新；失败则列表保持原样（提示由网络层给出） */
  private async confirmDeleteRole(roleId: string) {
    const roleName = this.roleSummaries.find((item) => item.id === roleId)?.name ?? "";
    this.cancelDeleteConfirm();
    try {
      await RoleApi.remove(roleId);
    } catch (error) {
      console.warn(`[RoleSelector] 删除角色失败：${describeError(error)}`);
      this.refreshManageControls();
      return;
    }
    StorageManager.deleteRole(roleId);
    // 删掉的正是当前选中的角色 → 名称/等级与「开始游戏」按钮一起复位，否则留下一个打不开的选中态
    if (this.ownerRoleSelectedId === roleId) this.clearSelectedRole();
    GameUiHelper.createTip("role_delete_done_tip", { name: roleName });
    await this.loadRoles();
  }

  /** 退出待确认状态：清定时器、按钮文案复位（删除成功后按钮已随列表销毁，只清状态） */
  private cancelDeleteConfirm() {
    if (this.deleteConfirmTimer !== null) {
      clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = null;
    }
    const button = this.pendingDeleteButton;
    if (this.pendingDeleteId && button && isValid(button)) this.setDeleteButtonText(button, getText("label_role_delete"));
    this.pendingDeleteId = null;
    this.pendingDeleteButton = null;
  }

  /** 改删除按钮文案（按钮工厂把文字放在 `<按钮名>_label` 子节点上） */
  private setDeleteButtonText(button: Node, text: string) {
    const label = button.getChildByName(`${button.name}_label`)?.getComponent(Label);
    if (label) label.string = text;
  }

  /** 复位角色选中态：名称/等级回占位文案、「开始游戏」按钮置灰（选中角色被删除后调用） */
  private clearSelectedRole() {
    const info = roleSelectorLayout.selectedInfo;
    this.ownerRoleSelectedId = null;
    this.mainView.beginGameButton.getComponent(Sprite).grayscale = true;
    this.mainView.selectedRoleName.getComponent(Label).string = info.nameLabel.text;
    this.mainView.selectedRoleLevel.getComponent(Label).string = info.levelLabel.text;
  }

  //#endregion

  private onlineRole(roleId: string) {
    this.ownerRoleSelectedId = roleId;
    const summary = this.roleSummaries.find((item) => item.id === roleId);
    if (!summary) return;
    // 开始游戏按钮可用，并更新名字与等级显示
    this.mainView.beginGameButton.getComponent(Sprite).grayscale = false;
    this.mainView.selectedRoleName.getComponent(Label).string = summary.name;
    this.mainView.selectedRoleLevel.getComponent(Label).string = summary.level.toString();
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
    createButton.on(Node.EventType.TOUCH_END, () => void this.createRole());
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

  /**
   * 创建角色
   *
   * 角色数据由**客户端按自身配置**生成（新手装备、初始金币、背包格、快捷键都在 configs/role），
   * 服务端只校验结构、归属、数量上限与重名 —— 于是游戏侧改配置不必同步改服务端。
   */
  async createRole() {
    if (!this.createView || this.busy) return;
    // 数量上限：服务端才是权威（server/.env 的 ROLE_MAX_PER_ACCOUNT），这里先拦一道省一次往返
    // —— 站位只有 roleSelectorLayout.rolePositions 那么几个，超出的角色在界面上根本没地方显示
    if (this.roleSummaries.length >= maxRoleCount) {
      GameUiHelper.createTip("role_create_limit_tip", { max: maxRoleCount });
      return;
    }
    // 读取表单（职业与性别取自选中开关的节点名称，即枚举值）
    const occupation = (this.createView.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as OECCUPATION;
    const sex = (this.createView.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "") as SEX;
    const name = this.createView.nameInput.getComponent(EditBox).string.trim();
    if (!name) return;
    this.busy = true;
    try {
      // 角色对象是 entities/Role 的实例；服务端只把它当不透明文档（结构 / 索引字段由服务端校验）
      const detail = await RoleApi.create({ data: new Role(name, occupation, sex) as unknown as Record<string, unknown> });
      StorageManager.cacheServerRole(detail);
      GameUiHelper.createTip("role_create_success_tip");
      this.cancelCreateRoleUI();
      await this.loadRoles();
    } catch (error) {
      console.warn(`[RoleSelector] 创建角色失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  update() {
    // 名称输入同步创建按钮可用状态
    if (this.createView) this.createView.createButton.getComponent(Sprite).grayscale = !Boolean(this.createView.nameInput.getComponent(EditBox).string);
  }
}
