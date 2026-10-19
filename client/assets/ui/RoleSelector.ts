import { _decorator, Color, Component, EditBox, isValid, Label, Node, Toggle, UITransform, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { OECCUPATION, SEX } from "../types/role";
import { applyScreenPolicy, getStageScale, getVisibleSize, onWindowResize } from "./utils/layout/ScreenLayout";
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
  manageRoleButton: Node;
  selectedRoleName: Node;
  selectedRoleLevel: Node;
}

/** 创建态零件（只在「没有角色」时显示：右侧职业/性别选择组、名字输入框、骰子） */
interface RoleSelectorCreateParts {
  occupationPicker: Node;
  sexPicker: Node;
  nameInput: Node;
  diceButton: Node;
}

/**
 * 选角场景（**单角色**，issue #149）
 *
 * 一个账号只有一个角色，所以这里没有角色列表、也没有创建弹窗，只有两种状态：
 * - **创建态**（账号下没有角色）：右侧选职业、右侧下方选性别、中间是跟着切换的大号站立动画，
 *   名字输入在「创建角色」按钮下方；点一次即建号并直接进游戏；
 * - **游戏态**（已有角色）：只留该角色的动画 + 名牌 + 「进入游戏」，职业/性别/名字输入全部隐藏。
 *
 * 角色数据**以服务端为准**：进场景拉一次角色列表（概要，单角色时最多一条），进游戏时才拉完整数据
 * 写进本地缓存（游戏内各处读角色是同步的，所以必须有一份本地完整数据，见 StorageManager.cacheRole）。
 * 协议见 ui/utils/net —— 本组件不写路径、不拼地址、不管令牌。
 *
 * 结构：铺满窗口的背景（始终盖住整个窗口）+ 一块固定设计尺寸的「舞台」，
 * 其余元素全部挂在舞台下并按设计坐标摆放（坐标以舞台中心为原点）。
 * 舞台由 applyStageLayout 按当前可见尺寸等比缩放（contain、只缩不放），
 * 所以窗口宽高比与设计不一致（窄屏会裁左右 / 宽屏会裁上下）时构图依旧完整可见，
 * 新增元素只需按设计画布摆坐标，不必关心窗口尺寸。
 * 位置/尺寸/用图统一见 configs/layout/scenes.roleSelectorLayout
 */
@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createParts: RoleSelectorCreateParts | null = null;
  /** 当前账号的角色（单角色：最多一个；null = 账号下还没有角色） */
  private role: RoleSummary | null = null;
  /** 创建态里当前选中的职业与性别（点右侧钮即改，中间预览跟着换） */
  private draftOccupation: OECCUPATION = OECCUPATION.ZHAN;
  private draftSex: SEX = SEX.BOY;
  /** 创建态是否已经预填过随机名（只在第一次进入创建态时填一次，之后尊重玩家的输入） */
  private nameSeeded = false;
  /** 角色动画预览节点（创建态与游戏态共用同一个位置，内容随选择/角色切换） */
  private preview: Node | null = null;
  /** 舞台容器（除背景外的所有元素都挂这里，整体按可见尺寸等比缩放；见 applyStageLayout） */
  private stage: Node | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;
  /** 是否处于管理模式（「管理」按钮开关，开启后角色头顶出现删除按钮） */
  private manageMode = false;
  /** 管理模式的临时节点（提示条 + 删除按钮）：退出管理模式或角色变化时统一销毁 */
  private manageNodes: Node[] = [];
  /** 待确认删除的角色 id（两步确认的第一步之后有值，见 onDeleteRoleClick） */
  private pendingDeleteId: string | null = null;
  /** 待确认删除按钮（复位文案要改它） */
  private pendingDeleteButton: Node | null = null;
  /** 待确认状态的超时定时器（到点自动复位） */
  private deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.createParts = this.createCreateParts();
    // 按当前可见尺寸适配舞台，并在窗口尺寸变化时重排
    this.applyStageLayout();
    this.offWindowResize = onWindowResize(() => this.applyStageLayout());
    // 角色来自服务端（拉取失败由网络层统一提示；拿不到就当没有角色，至少还能建号）
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
   * 舞台适配（窗口尺寸变化时可重复调用）：按可见尺寸等比缩放整块舞台并居中
   * （与登录场景同一套做法，缩放算法见 ui/utils/layout/ScreenLayout.getStageScale）
   */
  applyStageLayout() {
    const stage = this.stage;
    if (!stage || !isValid(stage, true)) return;
    const scale = getStageScale(roleSelectorLayout.stageSize, getVisibleSize());
    stage.setScale(scale, scale, 1);
  }

  /** 拼装选角主视图（元素全部挂舞台，坐标见 configs/layout/scenes.roleSelectorLayout） */
  private createMainView(): RoleSelectorMainView {
    const layout = roleSelectorLayout;
    // 左上「管理」按钮（只在有角色时显示：管理模式的开关，开启后角色头顶出现删除按钮）
    const manageLayout = layout.manageRoleButton;
    const manageRoleButton = GameUiHelper.createTexturedButton(manageLayout.name, manageLayout.image, "", manageLayout.position, manageLayout.size);
    manageRoleButton.on(Node.EventType.TOUCH_END, () => this.toggleManageRole());
    this.stage!.addChild(manageRoleButton);
    // 角色名牌（名称 + 等级）
    const infoLayout = layout.selectedInfo;
    const selectedInfoBox = GameUiHelper.createImage(infoLayout.name, infoLayout.image, infoLayout.position, infoLayout.size);
    selectedInfoBox.addChild(GameUiHelper.createText(infoLayout.nameLabel.name, infoLayout.nameLabel.text, infoLayout.nameLabel.fontSize, infoLayout.nameLabel.position, infoLayout.nameLabel.size, infoLayout.nameLabel.color));
    selectedInfoBox.addChild(GameUiHelper.createText(infoLayout.levelLabel.name, infoLayout.levelLabel.text, infoLayout.levelLabel.fontSize, infoLayout.levelLabel.position, infoLayout.levelLabel.size, infoLayout.levelLabel.color));
    this.stage!.addChild(selectedInfoBox);
    // 主按钮（创建态「创建角色」/ 游戏态「进入游戏」，文案由 applyRoleState 切换）
    const beginLayout = layout.beginGameButton;
    const beginGameButton = GameUiHelper.createTexturedButton(beginLayout.name, beginLayout.image, beginLayout.text, beginLayout.position, beginLayout.size, beginLayout.textColor, beginLayout.fontSize);
    beginGameButton.on(Node.EventType.TOUCH_END, () => void this.onMainButtonClick());
    this.stage!.addChild(beginGameButton);
    return {
      beginGameButton,
      manageRoleButton,
      selectedRoleName: selectedInfoBox.getChildByName(infoLayout.nameLabel.name),
      selectedRoleLevel: selectedInfoBox.getChildByName(infoLayout.levelLabel.name),
    };
  }

  /**
   * 拼装创建态零件：右侧职业组、右侧下方性别组、名字输入框、骰子
   *
   * 建好就绑定点击（点一下 = 选中 + 换预览）；显隐由 applyRoleState 统一控制，
   * 有角色时整组隐藏 —— 不销毁，删掉角色后能原样复用
   */
  private createCreateParts(): RoleSelectorCreateParts {
    const layout = roleSelectorLayout;
    // 右侧职业钮（3 个菱形）：点击即选职业，中间大预览立刻换人
    const occupationPicker = GameUiHelper.createOccupationPicker((key) => this.selectOccupation(key as OECCUPATION));
    this.stage!.addChild(occupationPicker);
    // 右侧下方性别钮（男 / 女）
    const sexPicker = GameUiHelper.createSexPicker((key) => this.selectSex(key as SEX));
    this.stage!.addChild(sexPicker);
    // 名字输入框（主按钮下方）
    const inputLayout = layout.nameInput;
    const nameField = GameUiHelper.createInputField(inputLayout.placeholder, inputLayout.position, inputLayout.size);
    this.stage!.addChild(nameField.node);
    // 骰子：掷一个随机名填进输入框（不用打开任何弹窗）
    const diceLayout = layout.diceButton;
    const diceButton = GameUiHelper.createTexturedButton(diceLayout.name, diceLayout.image, "", diceLayout.position, diceLayout.size);
    diceButton.on(Node.EventType.TOUCH_END, () => this.rollRandomName());
    this.stage!.addChild(diceButton);
    // 默认选中「战 / 男」，与预览一致
    this.syncPickerSelection();
    return { occupationPicker, sexPicker, nameInput: nameField.node, diceButton };
  }

  /** 把两个选择组的选中态同步成 draft（编程式改 isChecked 不会触发 ToggleContainer 事件，必须自己保证一致） */
  private syncPickerSelection() {
    const parts = this.createParts;
    if (!parts) return;
    const sync = (picker: Node, selected: string) => {
      picker.children.forEach((toggle) => {
        const component = toggle.getComponent(Toggle);
        if (component) component.isChecked = toggle.name === selected;
      });
    };
    sync(parts.occupationPicker, this.draftOccupation);
    sync(parts.sexPicker, this.draftSex);
  }

  /** 点职业钮：改草稿职业 → 中间预览换成这个职业的站立动画 */
  private selectOccupation(occupation: OECCUPATION) {
    if (this.role || this.draftOccupation === occupation) return;
    this.draftOccupation = occupation;
    this.syncPickerSelection();
    this.refreshPreview();
  }

  /** 点性别钮：改草稿性别 → 中间预览换人 */
  private selectSex(sex: SEX) {
    if (this.role || this.draftSex === sex) return;
    this.draftSex = sex;
    this.syncPickerSelection();
    this.refreshPreview();
  }

  /**
   * 拉取角色列表（服务端为准；单角色时最多一条）
   *
   * 成功时顺手清掉本地缓存里服务端已经没有的角色（例如换账号登录、或在别处被删过），
   * 避免进游戏时读到一个已不存在的角色；失败时**不清缓存**（网络抖动不该毁本地存档），
   * 界面按「没有角色」处理 —— 至少还能重新建号。
   */
  private async loadRoles() {
    let summaries: RoleSummary[];
    try {
      summaries = await RoleApi.list();
    } catch (error) {
      console.warn(`[RoleSelector] 角色列表加载失败：${describeError(error)}`);
      this.role = null;
      this.applyRoleState();
      return;
    }
    const ids = summaries.map((item) => item.id);
    StorageManager.getRoles().forEach((role) => {
      if (ids.indexOf(role.id) === -1) StorageManager.deleteRole(role.id);
    });
    this.role = summaries[0] ?? null;
    // 服务端上限 > 1 的部署（老配置）也不该让这里「看不见」多余角色：留一条能查的日志
    if (summaries.length > roleSelectorLayout.rolePositions.length) {
      console.warn(`[RoleSelector] 服务端返回 ${summaries.length} 个角色，但界面是单角色（容量 ${roleSelectorLayout.rolePositions.length}）：多余的不会显示（检查服务端 ROLE_MAX_PER_ACCOUNT）`);
    }
    this.applyRoleState();
  }

  /**
   * 按「有没有角色」切换两种状态（进入场景、创建成功、删除角色后调用）
   *
   * 创建态：显示职业/性别选择组与名字输入，按钮文案「创建角色」，管理按钮隐藏；
   * 游戏态：只留角色动画 + 名牌 + 「进入游戏」，管理按钮显示（可删号重来）。
   */
  private applyRoleState() {
    const role = this.role;
    const layout = roleSelectorLayout;
    const hasRole = !!role;
    this.setCreatePartsVisible(!hasRole);
    this.mainView.manageRoleButton.active = hasRole;
    this.setBeginButtonText(hasRole ? layout.beginGameButton.text : layout.beginGameButton.createText);
    if (role) {
      this.setPlate(role.name, role.level.toString());
    } else {
      this.setPlate(layout.selectedInfo.nameLabel.text, layout.selectedInfo.levelLabel.text);
      // 第一次进入创建态时预填一个随机名：玩家想直接进也行，想改就改
      if (!this.nameSeeded) {
        this.fillRandomName();
        this.nameSeeded = true;
      }
      // 没有角色就没有可管理的东西，别停在管理模式
      this.exitManageMode();
    }
    this.refreshPreview();
  }

  /** 创建态零件的显隐（有角色时整组隐藏，删号后原样复用） */
  private setCreatePartsVisible(visible: boolean) {
    const parts = this.createParts;
    if (!parts) return;
    [parts.occupationPicker, parts.sexPicker, parts.nameInput, parts.diceButton].forEach((node) => {
      if (isValid(node)) node.active = visible;
    });
  }

  /** 改主按钮文案（按钮工厂把文字放在 `<按钮名>_label` 子节点上） */
  private setBeginButtonText(text: string) {
    const label = this.mainView.beginGameButton.getChildByName(`${this.mainView.beginGameButton.name}_label`)?.getComponent(Label);
    if (label) label.string = text;
  }

  /** 名牌文案（名称 + 等级） */
  private setPlate(name: string, level: string) {
    this.mainView.selectedRoleName.getComponent(Label).string = name;
    this.mainView.selectedRoleLevel.getComponent(Label).string = level;
  }

  /**
   * 刷新中间的大号站立动画
   *
   * 有角色 = 该角色的职业/性别（游戏态的「只读展示」）；没角色 = 草稿里选中的职业/性别，
   * 点右侧钮就换。位置与倍率见 roleSelectorLayout（rolePositions 只有一个站位）。
   */
  private refreshPreview() {
    if (this.preview && isValid(this.preview, true)) this.preview.destroy();
    this.preview = null;
    const role = this.role;
    const occupation = role ? role.occupation : this.draftOccupation;
    const sex = role ? role.sex : this.draftSex;
    const layout = roleSelectorLayout;
    const stand = layout.rolePositions[0] ?? new Vec2();
    const preview = GameUiHelper.createRolePreview("role_preview", 1, occupation, sex, stand, layout.previewSize, layout.previewScale);
    this.stage!.addChild(preview);
    this.preview = preview;
  }

  /** 掷一个随机角色名（姓 + 名各随机取一段） */
  private randomName(): string {
    const parts = roleSelectorLayout.nameParts;
    const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
    return `${pick(parts.surnames)}${pick(parts.givens)}`;
  }

  /** 把随机名填进输入框 */
  private fillRandomName(): string {
    const name = this.randomName();
    const input = this.createParts?.nameInput.getComponent(EditBox);
    if (input) input.string = name;
    return name;
  }

  /** 骰子钮：换一个随机名（并提示掷出了什么） */
  private rollRandomName() {
    const name = this.fillRandomName();
    GameUiHelper.createTip("dice_name_tip", { name });
  }

  /** 主按钮：没有角色 = 建号并进游戏；已有角色 = 直接进游戏 */
  private async onMainButtonClick() {
    if (this.busy) return;
    if (this.role) {
      await this.enterGame(this.role.id);
      return;
    }
    await this.createRoleAndEnter();
  }

  /**
   * 创建角色并**直接进游戏**
   *
   * 角色数据由客户端按自身配置生成（新手装备、初始金币、背包格、快捷键都在 configs/role），
   * 服务端只校验结构、归属、数量上限与重名 —— 改配置不必同步改服务端。
   * 名字为空时用当前输入框里的随机名兜底（输入框初始化时已预填，正常情况下不会为空）。
   */
  private async createRoleAndEnter() {
    const input = this.createParts?.nameInput.getComponent(EditBox);
    const name = (input?.string ?? "").trim() || this.fillRandomName();
    const occupation = this.draftOccupation;
    const sex = this.draftSex;
    this.busy = true;
    try {
      const detail = await RoleApi.create({ data: new Role(name, occupation, sex) as unknown as Record<string, unknown> });
      // 服务端返回的完整数据（含修订号）写进本地缓存；数据不完整就停在选角界面
      if (!StorageManager.cacheServerRole(detail)) return;
      StorageManager.onlineRole(detail.id);
      GameUiHelper.createTip("role_create_success_tip");
      SceneManager.loadScene("Game");
    } catch (error) {
      console.warn(`[RoleSelector] 创建角色失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 进入游戏
   *
   * 服务端把该角色记为该账号的在线角色，并返回**完整角色数据**；
   * 把完整数据写进本地缓存后，游戏内所有同步读取（findOnlineRole/getRoles）照旧可用。
   */
  private async enterGame(roleId: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      const detail = await RoleApi.select(roleId);
      if (!StorageManager.cacheServerRole(detail)) return;
      StorageManager.onlineRole(roleId);
      SceneManager.loadScene("Game");
    } catch (error) {
      console.warn(`[RoleSelector] 进入角色失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  //#region 角色管理（删除）

  /**
   * 「管理」按钮：进入 / 退出管理模式
   * 管理模式 = 角色头顶出现删除按钮（挂舞台，不在角色预览子树里 —— 预览自带点击事件，
   * 按钮挂在它下面会被冒泡吞掉）
   */
  private toggleManageRole() {
    if (!this.role) return;
    if (this.manageMode) {
      this.exitManageMode();
      return;
    }
    this.manageMode = true;
    this.refreshManageControls();
    GameUiHelper.createTip("role_delete_mode_tip");
  }

  /** 退出管理模式：清待确认状态与临时节点 */
  private exitManageMode() {
    this.manageMode = false;
    this.cancelDeleteConfirm();
    this.clearManageNodes();
  }

  /** 重建管理模式的提示条与删除按钮（进入管理模式、角色变化后调用） */
  private refreshManageControls() {
    this.clearManageNodes();
    if (!this.manageMode || !this.stage || !this.role) return;
    const layout = roleSelectorLayout.manageRole;
    // 提示条（文案见 configs/texts.label_role_delete_hint）
    const hint = GameUiHelper.createText(layout.hint.name, getText("label_role_delete_hint"), layout.hint.fontSize, layout.hint.position, layout.hint.size, layout.hint.color);
    this.stage.addChild(hint);
    this.manageNodes.push(hint);
    // 单角色：只有一个删除按钮，位置 = 站位 + 偏移
    const stand = roleSelectorLayout.rolePositions[0] ?? new Vec2();
    const button = GameUiHelper.createTexturedButton(
      `${DELETE_ROLE_BUTTON_PREFIX}${this.role.id}`,
      uiImages.middleRedButtonBackground,
      getText("label_role_delete"),
      new Vec2(stand.x + layout.deleteButtonOffset.x, stand.y + layout.deleteButtonOffset.y),
      layout.deleteButtonSize,
      Color.WHITE,
      layout.deleteButtonFontSize,
    );
    button.on(Node.EventType.TOUCH_END, () => this.onDeleteRoleClick(this.role!.id, button), this);
    this.stage.addChild(button);
    this.manageNodes.push(button);
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
   * 3. 超时（manageRole.confirmTimeout）、退出管理模式或关场景：文案复位，下次点击重新从第 1 步开始。
   * 不弹确认框的原因与背包回收一致：不新增节点与鼠标监听，也就没有层级与点击穿透的坑
   */
  private onDeleteRoleClick(roleId: string, button: Node) {
    if (this.pendingDeleteId !== roleId) {
      const role = this.role;
      if (!role || role.id !== roleId) {
        GameUiHelper.createTip("role_delete_missing_tip");
        this.refreshManageControls();
        return;
      }
      this.pendingDeleteId = roleId;
      this.pendingDeleteButton = button;
      this.setDeleteButtonText(button, getText("label_role_delete_confirm"));
      GameUiHelper.createTip("role_delete_confirm_tip", { name: role.name });
      // 到点自动复位：免得「确认删除」一直挂着被无意点掉
      this.deleteConfirmTimer = setTimeout(() => this.cancelDeleteConfirm(), roleSelectorLayout.manageRole.confirmTimeout);
      return;
    }
    // 第二步：确认删除（先复位按钮与定时器，再发请求）
    void this.confirmDeleteRole(roleId);
  }

  /** 真删：服务端成功 → 本地缓存同步删除 → 回到创建态；失败则保持原样（提示由网络层给出） */
  private async confirmDeleteRole(roleId: string) {
    const roleName = this.role?.name ?? "";
    this.cancelDeleteConfirm();
    try {
      await RoleApi.remove(roleId);
    } catch (error) {
      console.warn(`[RoleSelector] 删除角色失败：${describeError(error)}`);
      this.refreshManageControls();
      return;
    }
    StorageManager.deleteRole(roleId);
    this.role = null;
    this.clearSelectedRole();
    GameUiHelper.createTip("role_delete_done_tip", { name: roleName });
    this.exitManageMode();
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

  /** 复位角色选中态：名称/等级回占位文案（角色被删除后调用） */
  private clearSelectedRole() {
    const info = roleSelectorLayout.selectedInfo;
    this.setPlate(info.nameLabel.text, info.levelLabel.text);
  }

  //#endregion
}
