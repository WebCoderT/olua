import { _decorator, Color, Component, EditBox, Graphics, isValid, Label, Layout, Node, ScrollView, Size, UIOpacity, UITransform, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import UiHelper from "./helpers/UiHelper";
import { occupations } from "../configs/role";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import SoundManager from "./core/SoundManager";
import { OECCUPATION, SEX } from "../types/role";
import { roleSelectorLayout, tipsLayout } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { RoleApi } from "./utils/net/Api";
import type { RoleSummary } from "./utils/net/Api";
import ApiError, { describeError, ApiErrorKind } from "./utils/net/ApiError";
import { installNetwork, logoutToLogin, returnToLogin } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
import ZoneStore from "./core/ZoneStore";
import { blockClickThrough } from "./utils/input/UiHit";
import { T } from "../configs/layout/tokens";
import { buttonTone } from "../configs/layout/sizes";
import { createRoundedPanel } from "./components/dialogs/tab-kit";
import ConfirmDialog from "./components/dialogs/ConfirmDialog";
const { ccclass } = _decorator;

/** 删除角色按钮的节点名前缀（按钮文字挂在 `<节点名>_label` 上，改文案时按它取；节点名带角色 id 便于排查） */
const DELETE_ROLE_BUTTON_PREFIX = "delete_role_";

/** 角色卡里的名字 / 等级节点名前缀（节点名带角色 id 便于排查） */
const NAME_PLATE_PREFIX = "role_name_plate_";
const LEVEL_LABEL_PREFIX = "role_level_";
const CARD_BADGE_PREFIX = "role_card_badge_";

/** 角色卡（滚动网格里的单元格：立绘缩略 + 名字 + 职业/等级 + 选中角标 + 管理模式的删除按钮） */
const ROLE_CELL_PREFIX = "role_cell_";

/** 角色立绘（帧动画容器）节点名前缀：选中态切换要按 id 找回它 */
const ROLE_PREVIEW_PREFIX = "role_preview_";

/** 中间大立绘的节点名（选中角色时重建，按名字清理） */
const STAGE_CHAR_PREFIX = "role_stage_preview_";

/** 选角主视图引用（本组件拼装并持有） */
interface RoleSelectorMainView {
  beginGameButton: Node;
  manageButton: Node;
  rosterCount: Label;
  /** 左栏：角色名 / 说明 / 属性 chips 容器 */
  heroName: Label;
  heroSub: Label;
  chips: Node;
  /** 中间：立绘容器 + 脚下名牌 */
  stageChar: Node;
  stagePlate: Node;
  stagePlateName: Label;
  stagePlateLevel: Label;
  /** 右面板：滚动区（空列表时整块隐藏）、固定的「创建角色」按钮（列表下方，不随滚动）、空状态 */
  scrollView: Node;
  createButton: Node;
  emptyNode: Node;
  /** 角色卡：角色 id → 卡片节点（选中态与删除按钮都按它找） */
  cards: Map<string, Node>;
}

/** 创建角色弹窗视图引用（本组件拼装并持有；选项为文字胶囊，选中值记在视图上） */
interface RoleSelectorCreateView {
  dialog: Node;
  nameInput: Node;
  /** 性别 / 职业文字胶囊节点（node.name = SEX / OECCUPATION 枚举值） */
  sexOptionNodes: Node[];
  occupationOptionNodes: Node[];
  /** 当前选中的性别 / 职业（枚举值；默认男 / 战士） */
  selectedSex: string;
  selectedOccupation: string;
  createButton: Node;
  cancelButton: Node;
}

/**
 * 选角场景（登录后的角色列表 + 创建角色弹窗）
 *
 * 角色数据**以服务端为准**：进场景拉一次角色列表（概要），选角色时才拉完整数据写进本地缓存
 * （游戏内各处读角色是同步的，所以必须有一份本地完整数据，见 StorageManager.cacheRole）。
 * 协议见 ui/utils/net —— 本组件不写路径、不拼地址、不管令牌。
 *
 * **界面整版对齐设计稿**（#1059，design/olua-ui/screens/02-role-select）：1920×1080 绝对坐标，
 * 顶栏 / 三栏（左文案 + 中立绘 + 右角色面板）/ 底栏。几何 / 字号 / 配色全部来自
 * `configs/layout/scenes.ts` 的 roleSelectorLayout 与 `configs/layout/tokens.ts`，
 * 本文件只负责组装与接线。稿件里那条底部牌匾栏（开始游戏 / 创建 / 管理 / 返回四颗图按钮）已拆掉：
 * 开始游戏与返回登录进左栏 CTA，创建与管理进右面板，牌匾图不再引用（素材保留）。
 */
@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createView: RoleSelectorCreateView | null = null;
  private ownerRoleSelectedId: string | null = null;
  /** 舞台容器（除背景外的所有元素都挂这里，不缩放） */
  private stage: Node | null = null;
  /** 角色滚动网格的内容容器（卡片都挂它下面，Layout GRID 自动排布与撑高） */
  private roleScrollContent: Node | null = null;
  /** 是否处于管理模式（「管理」按钮开关，开启后各角色卡中央出现删除按钮） */
  private manageMode = false;
  /** 管理模式的临时节点（提示条 + 各角色的删除按钮）：退出管理模式或刷新列表时统一销毁 */
  private manageNodes: Node[] = [];
  /** 删除角色的确认弹窗（同一时刻只留一个；见 onDeleteRoleClick） */
  private deleteConfirmDialog: ConfirmDialog | null = null;
  /** 服务端返回的角色列表（本场景的展示来源；本地角色缓存只在进游戏时才写） */
  private roleSummaries: RoleSummary[] = [];
  /** 是否有请求在途（创建 / 进游戏），避免连点重复提交 */
  private busy = false;
  /** 进游戏按钮（置灰 / 恢复用；buildHero 时 mainView 还没赋值，所以单独持有） */
  private beginGameNode: Node | null = null;
  /**
   * 背景节点与它的素材原始尺寸
   *
   * 背景是**等比铺满（cover）**、不是拉伸：多出的部分落在屏外（尺寸在素材加载完后算一次，
   * 见 fitBackground）。
   */
  private background: Node | null = null;
  private backgroundTexture: Size | null = null;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 背景（不在舞台内：铺满整个屏幕，始终盖住整个窗口）
    this.background = GameUiHelper.createCoverImage("role_selector_background", roleSelectorLayout.background, (textureSize) => {
      this.backgroundTexture = textureSize;
      this.fitBackground();
    });
    this.node.addChild(this.background);
    // 背景上的黑色半透明遮罩（与登录页同一层 heroScrim：盖在背景上、舞台之下）
    const scrim = new Node(roleSelectorLayout.scrim.name);
    scrim.addComponent(UITransform).setContentSize(roleSelectorLayout.stageSize.width, roleSelectorLayout.stageSize.height);
    const scrimGraphics = scrim.addComponent(Graphics);
    scrimGraphics.fillColor = roleSelectorLayout.scrim.color;
    scrimGraphics.rect(
      -roleSelectorLayout.stageSize.width / 2,
      -roleSelectorLayout.stageSize.height / 2,
      roleSelectorLayout.stageSize.width,
      roleSelectorLayout.stageSize.height,
    );
    scrimGraphics.fill();
    this.node.addChild(scrim);
    // 舞台容器：各元素按设计坐标摆在它下面（见 configs/layout/scenes.roleSelectorLayout）
    this.stage = this.createStage();
    this.mainView = this.createMainView();
    // 角色列表（#1009）：区在登录页就定好了（Login.applyZone 已经 POST /zones/select），
    // 这里直接按服务端记着的当前浏览区拉 —— 不再自己对齐区
    void this.loadRoles();
  }

  /** 把背景铺满整个屏幕（等比；素材尺寸未知时什么都不做——加载完会再调一次） */
  private fitBackground() {
    if (!this.background || !isValid(this.background, true) || !this.backgroundTexture) return;
    GameUiHelper.fitCover(this.background, this.backgroundTexture);
  }

  /** 场景卸载：关掉还挂着的删除确认弹窗 */
  onDestroy() {
    this.closeDeleteConfirm();
  }

  /** 创建舞台容器：尺寸为设计分辨率，各元素坐标以舞台中心为原点（与布局配置一致） */
  private createStage() {
    const stage = new Node("role_selector_stage");
    stage.addComponent(UITransform).setContentSize(roleSelectorLayout.stageSize);
    this.node.addChild(stage);
    return stage;
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
      // 连不上服务器：飘字走完后清登录信息回登录页（选角没有服务端什么都做不了）
      this.backToLoginWhenUnreachable(error);
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
   * 连不上服务器（网络层失败 / 超时）：**等错误飘字走完**再清登录信息回登录页。
   *
   * 全局失败观察者已经飘了错误提示（见 NetworkSetup），而飘字挂在本场景的 Canvas 上 ——
   * 立刻换场景会把它一起销毁，玩家只见页面闪一下、提示一个字没看到（与登录页 401 重载同坑）。
   * 所以等「上浮 + 淡出」走完（时长见 tipsLayout）再 returnToLogin。
   *
   * 只认连接层失败：业务失败说明服务端还活着（比如角色重名），提示或重试就够了，
   * 不该把人踢回登录；会话类失败（令牌过期 / 被封禁）由网络层按业务码先走一步，到不了这里。
   */
  private backToLoginWhenUnreachable(error: unknown) {
    const unreachable = error instanceof ApiError && (error.kind === ApiErrorKind.Network || error.kind === ApiErrorKind.Timeout);
    if (!unreachable) return;
    this.scheduleOnce(() => returnToLogin(), tipsLayout.errorMoveDuration + tipsLayout.errorFadeDuration);
  }

  /**
   * 进入游戏
   *
   * 一次请求做两件事：服务端把该角色记为该账号的在线角色，并返回**完整角色数据**；
   * 把完整数据写进本地缓存后，游戏内所有同步读取（findOnlineRole/getRoles）照常可用。
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

  //#region 界面组装

  /** 拼装选角主视图（顶栏 / 左栏 / 中立绘 / 右角色面板 / 底栏，坐标见 roleSelectorLayout） */
  private createMainView(): RoleSelectorMainView {
    this.buildTopbar();
    this.buildFooter();
    const heroName = this.buildHero();
    const stage = this.buildStageChar();
    const roster = this.buildRoster();
    return {
      beginGameButton: heroName.beginGameButton,
      manageButton: roster.manageButton,
      rosterCount: roster.count,
      heroName: heroName.name,
      heroSub: heroName.sub,
      chips: heroName.chips,
      stageChar: stage.charContainer,
      stagePlate: stage.plate,
      stagePlateName: stage.plateName,
      stagePlateLevel: stage.plateLevel,
      scrollView: roster.scrollView,
      createButton: roster.createButton,
      emptyNode: roster.emptyNode,
      cards: new Map<string, Node>(),
    };
  }

  /** 顶栏：「区服 · 账号」胶囊 + 退出登录（左上品牌图已移除，与登录页同一处理） */
  private buildTopbar(): void {
    const { topbar } = roleSelectorLayout;
    const zoneName = ZoneStore.get()?.name ?? "";
    const account = Session.account?.username ?? "";
    const who = UiHelper.createLabel(topbar.who.name, getText("role_select_who", { zone: zoneName, account }), T.text[3], topbar.who.fontSize, topbar.who.position, topbar.who.size);
    this.stage!.addChild(who);
    // 退出登录：ghost 档（先吊销令牌再回登录，与「需要重新登录」兜底共用一条终点）
    const logout = GameUiHelper.createToneButton(
      topbar.logoutButton.name,
      getText(topbar.logoutButton.textKey),
      topbar.logoutButton.position,
      topbar.logoutButton.size,
      topbar.logoutButton.fontSize,
      buttonTone.ghost,
    );
    logout.on(Node.EventType.TOUCH_END, () => logoutToLogin(), this);
    this.stage!.addChild(logout);
  }

  /** 底栏：两段小字（左标识 / 右合规，左右各贴边距 56） */
  private buildFooter(): void {
    const { footer } = roleSelectorLayout;
    this.stage!.addChild(UiHelper.createLabel(footer.left.textKey, getText(footer.left.textKey), T.text[4], footer.left.fontSize, footer.left.position, footer.left.size));
    this.stage!.addChild(
      UiHelper.createLabel(footer.right.textKey, getText(footer.right.textKey), T.text[4], footer.right.fontSize, footer.right.position, footer.right.size),
    );
  }

  /** 左栏：眉题 / 角色名 / 说明 / 属性 chips / 进游戏 + 返回登录 */
  private buildHero(): { name: Label; sub: Label; chips: Node; beginGameButton: Node } {
    // 返回的三块（名字 / 说明 / chips 容器）由 selectRole 按选中角色刷新
    const { hero } = roleSelectorLayout;
    this.stage!.addChild(UiHelper.createLabel(`${hero.cap.textKey}_label`, getText(hero.cap.textKey), T.gold[3], hero.cap.fontSize, hero.cap.position, hero.cap.size, Label.HorizontalAlign.LEFT));
    const nameNode = UiHelper.createLabel("role_hero_name", hero.name.placeholder, T.text[1], hero.name.fontSize, hero.name.position, hero.name.size, Label.HorizontalAlign.LEFT);
    this.stage!.addChild(nameNode);
    const subNode = UiHelper.createWrappedLabel(
      "role_hero_sub",
      getText(hero.sub.placeholderKey),
      T.text[3],
      hero.sub.fontSize,
      hero.sub.lineHeight,
      hero.sub.position,
      hero.sub.size.width,
      Label.HorizontalAlign.LEFT,
    );
    this.stage!.addChild(subNode);
    // 属性 chips（内容随选中角色重建，见 renderChips；容器中心按「左边缘 + 半个正文宽」摆）
    const chips = UiHelper.createNode("role_hero_chips", new Vec2(hero.leftEdgeX + hero.width / 2, hero.chips.positionY), new Size(hero.width, hero.chips.height));
    this.stage!.addChild(chips);
    // 进游戏（主行动档，未选中置灰）
    const enter = hero.cta.enter;
    const beginGameButton = GameUiHelper.createToneButton(enter.name, getText(enter.textKey), enter.position, enter.size, enter.fontSize, buttonTone.primary);
    beginGameButton.on(Node.EventType.TOUCH_END, () => this.beginGame(), this);
    this.beginGameNode = beginGameButton;
    this.stage!.addChild(beginGameButton);
    // 返回登录（ghost 档，带一个左向箭头）
    const back = hero.cta.back;
    const backButton = GameUiHelper.createToneButton(back.name, getText(back.textKey), back.position, back.size, back.fontSize, buttonTone.ghost);
    this.drawBackArrow(backButton, back.arrowWidth);
    backButton.on(Node.EventType.TOUCH_END, () => logoutToLogin(), this);
    this.stage!.addChild(backButton);
    this.setBeginGameEnabled(false);
    return { name: nameNode.getComponent(Label)!, sub: subNode.getComponent(Label)!, chips, beginGameButton };
  }

  /** 中间：底光 + 脚下环 + 立绘容器 + 脚下名牌 */
  private buildStageChar(): { charContainer: Node; plate: Node; plateName: Label; plateLevel: Label } {
    const layout = roleSelectorLayout.stageChar;
    // 底光：Graphics 没有径向渐变，用几圈递减 alpha 的同心圆叠出来
    const glow = UiHelper.createNode("role_stage_glow", layout.glow.position, new Size(layout.glow.radius * 2, layout.glow.radius * 2));
    const glowGraphics = glow.addComponent(Graphics);
    for (let i = layout.glow.rings; i >= 1; i--) {
      const radius = (layout.glow.radius * i) / layout.glow.rings;
      glowGraphics.fillColor = new Color(layout.glow.color.r, layout.glow.color.g, layout.glow.color.b, layout.glow.alpha);
      glowGraphics.circle(0, 0, radius);
      glowGraphics.fill();
    }
    this.stage!.addChild(glow);
    // 脚下环：两圈细金线（外粗内细，稿件 .ring）
    const ring = UiHelper.createNode("role_stage_ring", layout.ring.position, new Size(layout.ring.radius * 2, layout.ring.radius * 2));
    const ringGraphics = ring.addComponent(Graphics);
    ringGraphics.lineWidth = layout.ring.width;
    ringGraphics.strokeColor = layout.ring.color;
    ringGraphics.ellipse(0, 0, layout.ring.radius, layout.ring.radius * 0.28);
    ringGraphics.stroke();
    ringGraphics.strokeColor = T.line[1];
    ringGraphics.ellipse(0, 0, layout.ring.radius * 0.82, layout.ring.radius * 0.22);
    ringGraphics.stroke();
    this.stage!.addChild(ring);
    // 立绘容器（选中角色时往里塞帧动画，见 renderStageChar）
    const charContainer = UiHelper.createNode(layout.name, layout.position, layout.size);
    this.stage!.addChild(charContainer);
    // 脚下名牌：金边胶囊 + 名字 + 等级
    const plate = UiHelper.createNode(layout.plate.name, layout.plate.position, layout.plate.size);
    const plateGraphics = plate.addComponent(Graphics);
    // 金边胶囊：填外框 → 内缩填主体（1px 级 stroke 实机不渲染）
    UiHelper.paintRoundedPanel(plateGraphics, layout.plate.size, layout.plate.size.height / 2, T.surface[3], T.gold[2], T.border.width);
    const plateName = UiHelper.createLabel("role_stage_plate_name", "", T.text[1], layout.plate.fontSize, new Vec2(-layout.plate.gap, 0), new Size(layout.plate.size.width / 2, layout.plate.size.height));
    const plateLevel = UiHelper.createLabel("role_stage_plate_level", "", T.gold[4], layout.plate.levelFontSize, new Vec2(layout.plate.gap + 10, 0), new Size(layout.plate.size.width / 2 - 20, layout.plate.size.height));
    plate.addChild(plateName);
    plate.addChild(plateLevel);
    plate.active = false;
    this.stage!.addChild(plate);
    return { charContainer, plate, plateName: plateName.getComponent(Label)!, plateLevel: plateLevel.getComponent(Label)! };
  }

  /** 右面板：头部（标题 / 数量 / 管理）+ 两列角色卡滚动区 + 固定「创建角色」按钮 + 空状态 */
  private buildRoster(): { manageButton: Node; count: Label; scrollView: Node; createButton: Node; emptyNode: Node } {
    const layout = roleSelectorLayout.roster;
    const panel = GameUiHelper.createDialogPanel(layout.name, layout.size);
    panel.setPosition(layout.position.x, layout.position.y, 0);
    this.stage!.addChild(panel);
    // 头部
    panel.addChild(UiHelper.createLabel(`${layout.name}_title`, getText(layout.head.title.textKey), T.text[1], layout.head.title.fontSize, layout.head.title.position, layout.head.title.size, Label.HorizontalAlign.LEFT));
    const countLabel = UiHelper.createLabel(`${layout.name}_count`, "", T.gold[2], layout.head.count.fontSize, layout.head.count.position, layout.head.count.size, Label.HorizontalAlign.LEFT);
    panel.addChild(countLabel);
    const manageButton = GameUiHelper.createToneButton(
      layout.head.manageButton.name,
      getText("role_select_manage"),
      layout.head.manageButton.position,
      layout.head.manageButton.size,
      layout.head.manageButton.fontSize,
      buttonTone.ghost,
    );
    manageButton.on(Node.EventType.TOUCH_END, () => this.toggleManageRole(), this);
    panel.addChild(manageButton);
    const divider = UiHelper.createNode(`${layout.name}_divider`, layout.head.divider.position, layout.head.divider.size);
    const dividerGraphics = divider.addComponent(Graphics);
    dividerGraphics.fillColor = T.line[1];
    dividerGraphics.rect(-layout.head.divider.size.width / 2, -layout.head.divider.size.height / 2, layout.head.divider.size.width, layout.head.divider.size.height);
    dividerGraphics.fill();
    panel.addChild(divider);
    // 卡片滚动区：一排两张（可用宽 = 视口 474 − padding 3×2 = 468 = 228×2 + 12），排满换行、超出视口上下滚。排布交给引擎 Layout
    // padding 3 不是装饰：content 顶边 = mask 裁剪线，padding 0 时第一行卡片的边框正好压在裁剪线上被整条裁掉（缺上边）
    const scroll = layout.scroll;
    const scrollView = GameUiHelper.createScrollView(scroll.name, scroll.position, scroll.viewSize);
    scrollView.getComponent(ScrollView)!.horizontal = false;
    const content = scrollView.getChildByName(`${scroll.name}_content`)!;
    const grid = content.getComponent(Layout)!;
    grid.type = Layout.Type.GRID;
    grid.resizeMode = Layout.ResizeMode.CONTAINER;
    grid.startAxis = Layout.AxisDirection.HORIZONTAL;
    grid.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    grid.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
    grid.spacingX = layout.card.spacingX;
    grid.spacingY = layout.card.spacingY;
    grid.paddingLeft = scroll.paddingX;
    grid.paddingRight = scroll.paddingX;
    grid.paddingTop = scroll.paddingY;
    grid.paddingBottom = scroll.paddingY;
    this.stage!.addChild(scrollView);
    this.roleScrollContent = content;
    // 「创建角色」固定按钮：钉在滚动区下方（不在卡片网格里，不随列表滚动）
    const createButtonLayout = layout.createButton;
    const createButton = GameUiHelper.createToneButton(
      createButtonLayout.name,
      getText("role_select_new_card"),
      createButtonLayout.position,
      createButtonLayout.size,
      createButtonLayout.fontSize,
      buttonTone.gold,
    );
    createButton.on(Node.EventType.TOUCH_END, () => this.createRoleUI(), this);
    this.stage!.addChild(createButton);
    // 空状态（没有角色时替掉卡片网格，见 showOwnerRolesUI）
    const emptyLayout = roleSelectorLayout.empty;
    const emptyNode = UiHelper.createNode(emptyLayout.name, new Vec2(), roleSelectorLayout.roster.size);
    emptyNode.setPosition(layout.position.x, layout.position.y, 0);
    emptyNode.addChild(UiHelper.createLabel(`${emptyLayout.name}_title`, getText(emptyLayout.titleTextKey), T.text[2], emptyLayout.titleFontSize, new Vec2(0, emptyLayout.titlePosition.y - layout.position.y), new Size(400, 24)));
    emptyNode.addChild(
      UiHelper.createWrappedLabel(
        `${emptyLayout.name}_sub`,
        getText(emptyLayout.subTextKey),
        T.text[4],
        emptyLayout.subFontSize,
        22,
        new Vec2(0, emptyLayout.subPosition.y - layout.position.y),
        emptyLayout.subWidth,
      ),
    );
    const emptyButton = GameUiHelper.createToneButton(
      `${emptyLayout.name}_button`,
      getText(emptyLayout.buttonTextKey),
      new Vec2(0, emptyLayout.buttonPosition.y - layout.position.y),
      emptyLayout.buttonSize,
      emptyLayout.buttonFontSize,
      buttonTone.gold,
    );
    emptyButton.on(Node.EventType.TOUCH_END, () => this.createRoleUI(), this);
    emptyNode.addChild(emptyButton);
    emptyNode.active = false;
    this.stage!.addChild(emptyNode);
    return { manageButton, count: countLabel.getComponent(Label)!, scrollView, createButton, emptyNode };
  }

  /** 返回登录按钮上的左向箭头（贴在文字左侧，图形现画） */
  private drawBackArrow(button: Node, width: number): void {
    const arrow = UiHelper.createNode(`${button.name}_arrow`, new Vec2(-width * 2 - 12, 0), new Size(width, width));
    const graphics = arrow.addComponent(Graphics);
    graphics.lineWidth = 1.5;
    graphics.strokeColor = T.text[3];
    const half = width / 2;
    graphics.moveTo(-half, 0);
    graphics.lineTo(half, 0);
    graphics.moveTo(-half + 4, 4);
    graphics.lineTo(-half, 0);
    graphics.lineTo(-half + 4, -4);
    graphics.stroke();
    button.addChild(arrow);
  }

  /** 进游戏按钮可用 / 置灰（矢量按钮没有 Sprite，用半透明表达不可用） */
  private setBeginGameEnabled(enabled: boolean): void {
    const button = this.beginGameNode;
    if (!button || !isValid(button, true)) return;
    const opacity = button.getComponent(UIOpacity) ?? button.addComponent(UIOpacity);
    opacity.opacity = enabled ? 255 : 150;
  }

  /** 按服务端角色列表重建右面板卡片（列表变化：进场景 / 新建 / 删除后调用） */
  showOwnerRolesUI() {
    const view = this.mainView;
    view.cards.forEach((node) => {
      if (isValid(node)) node.destroy();
    });
    view.cards.clear();
    const content = this.roleScrollContent;
    if (!content) return;
    content.removeAllChildren();
    const isEmpty = this.roleSummaries.length === 0;
    view.scrollView.active = !isEmpty;
    view.emptyNode.active = isEmpty;
    // 空状态自带的建号按钮顶掉了固定按钮，避免页面上出现两颗「创建角色」
    view.createButton.active = !isEmpty;
    view.rosterCount.string = getText("role_select_count", { count: this.roleSummaries.length });
    if (!isEmpty) {
      this.roleSummaries.forEach((role) => {
        const card = this.createRoleCard(role);
        content.addChild(card);
        view.cards.set(role.id, card);
      });
    }
    // 管理模式下列表变了（如刚删掉一个角色）→ 删除按钮按新列表重建
    if (this.manageMode) this.refreshManageControls();
    // 选中态挂在卡片里，重建列表时随节点一起销毁了 → 选中的角色还在列表就重新亮起来
    if (this.ownerRoleSelectedId) this.selectRole(this.ownerRoleSelectedId);
    else this.clearSelectedRole();
  }

  /**
   * 造一张角色卡：立绘缩略（帧动画）+ 名字 + 职业/等级 + 选中角标
   *
   * 点击整张卡选中角色（事件绑在卡片上：缩略图与文字都是它的子节点，点击都会冒泡上来）；
   * 管理模式的删除按钮也挂在卡片下，但会在自己的处理里 stopPropagation，避免连带选中。
   */
  private createRoleCard(role: RoleSummary): Node {
    const cardLayout = roleSelectorLayout.roster.card;
    const cell = new Node(`${ROLE_CELL_PREFIX}${role.id}`);
    cell.addComponent(UITransform).setContentSize(cardLayout.size);
    const preview = GameUiHelper.createRolePreview(
      `${ROLE_PREVIEW_PREFIX}${role.id}`,
      1,
      role.occupation,
      role.sex,
      new Vec2(0, cardLayout.preview.offsetY),
      cardLayout.preview.size,
    );
    preview.setScale(cardLayout.preview.scale, cardLayout.preview.scale, 1);
    cell.addChild(preview);
    const name = UiHelper.createLabel(
      `${NAME_PLATE_PREFIX}${role.id}`,
      // 只显示名字不带等级（等级在卡片右下的 Lv. 标签；脚下名牌才用「名字 Lv.n」模板）
      role.name,
      cardLayout.name.color,
      cardLayout.name.fontSize,
      new Vec2(cardLayout.name.offsetX, cardLayout.name.offsetY),
      cardLayout.name.size,
      Label.HorizontalAlign.LEFT,
    );
    cell.addChild(name);
    // 职业：色点 + 职业名（色点用 Graphics，颜色取职业色）
    const meta = cardLayout.meta;
    const dot = UiHelper.createNode(`${NAME_PLATE_PREFIX}${role.id}_class_dot`, new Vec2(meta.offsetX - meta.size.width / 2 + meta.dot / 2, meta.offsetY), new Size(meta.dot, meta.dot));
    const dotGraphics = dot.addComponent(Graphics);
    dotGraphics.fillColor = this.classColor(role.occupation);
    dotGraphics.circle(0, 0, meta.dot / 2);
    dotGraphics.fill();
    cell.addChild(dot);
    const className = occupations.get(role.occupation as OECCUPATION)?.name ?? "";
    cell.addChild(
      UiHelper.createLabel(
        `${NAME_PLATE_PREFIX}${role.id}_class`,
        className,
        meta.color,
        meta.fontSize,
        new Vec2(meta.offsetX + meta.dot + meta.dotGap, meta.offsetY),
        meta.size,
        Label.HorizontalAlign.LEFT,
      ),
    );
    cell.addChild(
      UiHelper.createLabel(`${LEVEL_LABEL_PREFIX}${role.id}`, getText("role_select_level_suffix", { level: role.level }), cardLayout.level.color, cardLayout.level.fontSize, new Vec2(cardLayout.level.offsetX, cardLayout.level.offsetY), cardLayout.level.size, Label.HorizontalAlign.RIGHT),
    );
    // 选中角标（金底深字，默认隐藏，选中时点亮）
    const badge = this.createBadge(`${CARD_BADGE_PREFIX}${role.id}`, cardLayout.badge.textKey);
    badge.setPosition(cardLayout.badge.offset.x, cardLayout.badge.offset.y, 0);
    badge.active = false;
    cell.addChild(badge);
    this.paintCard(cell, false);
    SoundManager.bindClick(cell);
    blockClickThrough(cell);
    cell.on(Node.EventType.TOUCH_END, () => {
      if (!this.manageMode) this.onlineRole(role.id);
    }, this);
    return cell;
  }

  /** 画一张卡的底板（未选中：暗褐 + 弱金线；选中：金边 + 一层淡金罩） */
  private paintCard(cell: Node, selected: boolean): void {
    const cardLayout = roleSelectorLayout.roster.card;
    const graphics = cell.getComponent(Graphics) ?? cell.addComponent(Graphics);
    const w = cardLayout.size.width;
    const h = cardLayout.size.height;
    graphics.clear();
    // 外框（1px 级 stroke 实机不渲染：先填外框色整块，再内缩填主体）
    const bw = selected ? T.border.widthStrong : T.border.width;
    graphics.fillColor = selected ? T.gold[3] : T.line[2];
    graphics.roundRect(-w / 2, -h / 2, w, h, T.radius.r2);
    graphics.fill();
    // 底板：主体色整块 + 上半一条更亮的带（Graphics 没有渐变，两层矩形叠）
    graphics.fillColor = T.surface[2];
    graphics.roundRect(-w / 2 + bw, -h / 2 + bw, w - bw * 2, h - bw * 2, T.radius.r2 - bw);
    graphics.fill();
    graphics.fillColor = T.surface[3];
    graphics.roundRect(-w / 2 + bw, -h / 2 + bw + h * 0.45, w - bw * 2, h * 0.55 - bw, T.radius.r2 - bw);
    graphics.fill();
    if (selected) {
      graphics.fillColor = T.line[1];
      graphics.roundRect(-w / 2 + bw, -h / 2 + bw, w - bw * 2, h - bw * 2, T.radius.r2 - bw);
      graphics.fill();
    }
  }

  /** 选中角标（金底深字小胶囊） */
  private createBadge(name: string, textKey: string): Node {
    const badgeLayout = roleSelectorLayout.roster.card.badge;
    const node = UiHelper.createNode(name, new Vec2(), badgeLayout.size);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = T.gold[3];
    graphics.roundRect(-badgeLayout.size.width / 2, -badgeLayout.size.height / 2, badgeLayout.size.width, badgeLayout.size.height, badgeLayout.size.height / 2);
    graphics.fill();
    node.addChild(UiHelper.createLabel(`${name}_label`, getText(textKey), T.text.onGold, badgeLayout.font, new Vec2(), badgeLayout.size));
    return node;
  }

  /** 职业色（芯片 / 卡片色点共用） */
  private classColor(occupation: string): Color {
    if (occupation === OECCUPATION.FA) return T.classColor.mage;
    if (occupation === OECCUPATION.DAO) return T.classColor.taoist;
    return T.classColor.warrior;
  }

  //#endregion

  //#region 选中态

  /** 按角色 id 取卡片节点（列表重建会换新节点，所以每次按表查，不缓存引用） */
  private cardOf(roleId: string): Node | null {
    return this.mainView.cards.get(roleId) ?? null;
  }

  /** 按角色 id 取卡片里的立绘节点（选中态切换用） */
  private rolePreview(roleId: string): Node | null {
    return this.cardOf(roleId)?.getChildByName(`${ROLE_PREVIEW_PREFIX}${roleId}`) ?? null;
  }

  /**
   * 切换某个角色立绘的选中态（站立帧 ↔ 展示帧 + 脚下 select_player 特效）
   * 节点可能已随列表重建销毁（新建 / 删除角色后），找不到就跳过 —— 重建后由 showOwnerRolesUI 补回
   */
  private setRoleSelected(roleId: string, selected: boolean) {
    const summary = this.roleSummaries.find((item) => item.id === roleId);
    const preview = this.rolePreview(roleId);
    if (!summary || !preview) return;
    GameUiHelper.setRolePreviewSelected(preview, selected, summary.occupation, summary.sex);
  }

  /** 点选角色：刷新左栏文案 / chips / 中间立绘 / 卡片选中态 */
  private onlineRole(roleId: string) {
    const previous = this.ownerRoleSelectedId;
    const summary = this.roleSummaries.find((item) => item.id === roleId);
    if (!summary) return;
    // 换人选中：先把上一个换回站立帧
    if (previous && previous !== roleId) this.setRoleSelected(previous, false);
    this.selectRole(roleId);
    this.setRoleSelected(roleId, true);
  }

  /**
   * 把某个角色设成「当前选中」并刷新界面（不碰帧动画，帧动画由 onlineRole / showOwnerRolesUI 负责）
   *
   * 一个入口管全部视觉：左栏（名字 / 说明 / chips）、中间立绘与名牌、卡片的金边与角标、进游戏按钮。
   * 重复调用同一个 id 是幂等的（showOwnerRolesUI 重建列表后也走这里补状态）。
   */
  private selectRole(roleId: string): void {
    const summary = this.roleSummaries.find((item) => item.id === roleId);
    if (!summary) return;
    this.ownerRoleSelectedId = roleId;
    const hero = roleSelectorLayout.hero;
    this.mainView.heroName.string = summary.name;
    this.mainView.heroSub.string = getText(hero.sub.textKey, { level: summary.level });
    this.renderChips(summary);
    this.renderStageChar(summary);
    this.mainView.cards.forEach((card, id) => {
      const selected = id === roleId;
      this.paintCard(card, selected);
      const badge = card.getChildByName(`${CARD_BADGE_PREFIX}${id}`);
      if (badge) badge.active = selected;
    });
    this.setBeginGameEnabled(true);
  }

  /** 左栏属性 chips：职业（带色点）/ 性别 / 等级（按配置的顺序横排） */
  private renderChips(role: RoleSummary | null): void {
    const chipsLayout = roleSelectorLayout.hero.chips;
    const container = this.mainView.chips;
    container.removeAllChildren();
    const items: Array<{ text: string; color?: Color; dot?: Color }> = [];
    if (!role) {
      items.push({ text: getText(chipsLayout.emptyKey) });
    } else {
      items.push({ text: occupations.get(role.occupation as OECCUPATION)?.name ?? "", dot: this.classColor(role.occupation) });
      items.push({ text: getText("role_select_chip_sex", { sex: getText(role.sex === SEX.GRIL ? "label_sex_girl" : "label_sex_boy") }) });
      items.push({ text: getText("role_select_chip_level", { level: role.level }) });
    }
    // chips 容器以「左栏正文中心」为原点，所以从左边缘的局部坐标 = -hero.width / 2
    let cursor = -roleSelectorLayout.hero.width / 2;
    items.forEach((item, index) => {
      const itemLayout = chipsLayout.items[index];
      const size = itemLayout?.size ?? new Size(140, chipsLayout.height);
      const centerX = cursor + size.width / 2;
      const chip = UiHelper.createNode(`role_chip_${itemLayout?.key ?? "empty"}`, new Vec2(centerX, 0), size);
      const graphics = chip.addComponent(Graphics);
      // 1px 级 stroke 实机不渲染：走「填外框 → 内缩填主体」
      UiHelper.paintRoundedPanel(graphics, size, T.radius.r2, T.surface.sunken, role ? T.line[2] : T.line[1]);
      let textX = 0;
      if (item.dot) {
        const dotSize = chipsLayout.dot;
        graphics.fillColor = item.dot;
        graphics.circle(-size.width / 2 + T.spacing.sp7 + dotSize / 2, 0, dotSize / 2);
        graphics.fill();
        textX = (dotSize + T.spacing.sp3) / 2;
      }
      const label = UiHelper.createLabel(`role_chip_${itemLayout?.key ?? "empty"}_label`, item.text, role ? T.text[2] : T.text[4], chipsLayout.fontSize, new Vec2(textX, 0), new Size(size.width - 28, size.height));
      chip.addChild(label);
      container.addChild(chip);
      cursor += size.width + chipsLayout.gap;
    });
  }

  /** 中间立绘：按选中角色重建（脚下特效随展示帧一起播） */
  private renderStageChar(role: RoleSummary | null): void {
    const layout = roleSelectorLayout.stageChar;
    const container = this.mainView.stageChar;
    container.removeAllChildren();
    if (!role) {
      this.mainView.stagePlate.active = false;
      return;
    }
    const preview = GameUiHelper.createRolePreview(
      `${STAGE_CHAR_PREFIX}${role.id}`,
      1,
      role.occupation,
      role.sex,
      new Vec2(),
      layout.size,
    );
    preview.setScale(layout.scale, layout.scale, 1);
    container.addChild(preview);
    GameUiHelper.setRolePreviewSelected(preview, true, role.occupation, role.sex);
    this.mainView.stagePlate.active = true;
    this.mainView.stagePlateName.string = role.name;
    this.mainView.stagePlateLevel.string = getText("role_select_level_suffix", { level: role.level });
  }

  /** 复位角色选中态：左栏回占位、chips 回空、立绘与名牌隐藏、进游戏按钮置灰（选中角色被删除后调用） */
  clearSelectedRole() {
    if (this.ownerRoleSelectedId) this.setRoleSelected(this.ownerRoleSelectedId, false);
    this.ownerRoleSelectedId = null;
    const hero = roleSelectorLayout.hero;
    this.mainView.heroName.string = hero.name.placeholder;
    this.mainView.heroSub.string = getText(hero.sub.placeholderKey);
    this.renderChips(null);
    this.renderStageChar(null);
    this.mainView.cards.forEach((card, id) => {
      this.paintCard(card, false);
      const badge = card.getChildByName(`${CARD_BADGE_PREFIX}${id}`);
      if (badge) badge.active = false;
    });
    this.setBeginGameEnabled(false);
  }

  //#endregion

  //#region 角色管理（删除）

  /** 「管理」按钮：进入 / 退出管理模式（卡片中央出现删除按钮） */
  private toggleManageRole() {
    this.manageMode = !this.manageMode;
    const label = this.mainView.manageButton.getChildByName(`${roleSelectorLayout.roster.head.manageButton.name}_label`)?.getComponent(Label);
    if (label) label.string = getText(this.manageMode ? "role_select_manage_done" : "role_select_manage");
    if (!this.manageMode) {
      this.closeDeleteConfirm();
      this.clearManageNodes();
      return;
    }
    this.refreshManageControls();
  }

  /** 按当前角色列表重建管理模式的提示条与删除按钮（进入管理模式、删除角色后刷新列表时调用） */
  private refreshManageControls() {
    this.clearManageNodes();
    if (!this.manageMode || !this.stage) return;
    const hintLayout = roleSelectorLayout.manageHint;
    const hint = UiHelper.createNode(hintLayout.name, hintLayout.position, hintLayout.size);
    const hintGraphics = hint.addComponent(Graphics);
    // 琥珀提示胶囊：填外框 → 内缩填主体（1px 级 stroke 实机不渲染）
    UiHelper.paintRoundedPanel(hintGraphics, hintLayout.size, hintLayout.size.height / 2, T.surface[3], T.amber, T.border.width);
    hint.addChild(UiHelper.createLabel(`${hintLayout.name}_label`, getText(hintLayout.textKey), T.amber, hintLayout.fontSize, new Vec2(), hintLayout.size));
    this.stage.addChild(hint);
    this.manageNodes.push(hint);
    // 每张卡右上角一个删除按钮（朱红主按钮色）：挂在**卡片**下（预览的兄弟节点，躲开预览的选中冒泡），跟着滚动内容走
    const deleteLayout = roleSelectorLayout.roster.card.deleteButton;
    this.roleSummaries.forEach((role) => {
      const card = this.cardOf(role.id);
      if (!card) return;
      const button = GameUiHelper.createToneButton(
        `${DELETE_ROLE_BUTTON_PREFIX}${role.id}`,
        getText("label_role_delete"),
        deleteLayout.offset,
        deleteLayout.size,
        deleteLayout.fontSize,
        buttonTone.primary,
      );
      button.on(Node.EventType.TOUCH_END, (event: { propagationStopped: boolean }) => {
        event.propagationStopped = true;
        this.onDeleteRoleClick(role.id);
      }, this);
      card.addChild(button);
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
   * 删除按钮点击：弹确认框（通用 ConfirmDialog，全屏模态）
   *
   * 删除角色不可恢复，不让一次点击就生效：确认框写明角色名与后果，点「确定」才真删；
   * 「取消」或点其它删除按钮（旧框先关）都不动数据。场景卸载 / 退出管理模式时也会收框。
   */
  private onDeleteRoleClick(roleId: string) {
    const summary = this.roleSummaries.find((item) => item.id === roleId);
    if (!summary) {
      GameUiHelper.createTip("role_delete_missing_tip");
      this.refreshManageControls();
      return;
    }
    // 保险：上一颗确认框还挂着（连点别的删除按钮）先收掉，同一时刻只留一个
    this.closeDeleteConfirm();
    const confirm = new ConfirmDialog({
      title: getText("role_delete_confirm_title"),
      message: getText("role_delete_confirm_text", { name: summary.name }),
      confirmText: getText("label_role_delete"),
      cancelText: getText("label_confirm_cancel"),
      // 确定：真的删除（ConfirmDialog 先关自己再回调，这里只管清引用与发请求）
      onConfirm: () => {
        this.deleteConfirmDialog = null;
        void this.confirmDeleteRole(roleId);
      },
      onCancel: () => {
        this.deleteConfirmDialog = null;
      },
    });
    this.deleteConfirmDialog = confirm;
    // 确认框自身是全屏模态（盖住整个屏幕并独占输入，见 ConfirmDialog）：挂在场景根最后 = 全屏最上层
    this.node.addChild(confirm);
  }

  /** 关掉删除确认弹窗（退出管理模式 / 场景卸载 / 重复弹出前调用；没开着时什么也不做） */
  private closeDeleteConfirm() {
    this.deleteConfirmDialog?.destroy();
    this.deleteConfirmDialog = null;
  }

  /** 真删：服务端成功 → 本地缓存与列表同步更新；失败则列表保持原样（提示由网络层给出） */
  private async confirmDeleteRole(roleId: string) {
    const roleName = this.roleSummaries.find((item) => item.id === roleId)?.name ?? "";
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

  //#endregion

  createRoleUI() {
    if (this.createView) return;
    this.createView = this.createCreateRoleView();
  }

  /** 拼装创建角色弹窗视图（几何见 configs/layout/scenes.roleSelectorLayout.createDialog；按设计语言重绘为文字选项版） */
  private createCreateRoleView(): RoleSelectorCreateView {
    const layout = roleSelectorLayout.createDialog;
    // 弹窗主体：矢量面板（与右侧角色面板同一套底板，不再用整图背景）
    const dialog = GameUiHelper.createDialogPanel(layout.name, layout.size);
    dialog.setPosition(layout.position.x, layout.position.y, 0);
    this.stage!.addChild(dialog);
    // 标题（文字）+ 金色下划线
    dialog.addChild(UiHelper.createLabel(`${layout.name}_title`, getText(layout.title.textKey), T.text[1], layout.title.fontSize, layout.title.position, layout.title.size));
    const underline = UiHelper.createNode(`${layout.name}_title_line`, layout.titleUnderline.position, layout.titleUnderline.size);
    const underlineGraphics = underline.addComponent(Graphics);
    underlineGraphics.fillColor = T.gold[3];
    underlineGraphics.rect(-layout.titleUnderline.size.width / 2, -layout.titleUnderline.size.height / 2, layout.titleUnderline.size.width, layout.titleUnderline.size.height);
    underlineGraphics.fill();
    dialog.addChild(underline);
    // 分组小字：性别 / 职业（左对齐，起点 = 面板左缘 + 18）
    dialog.addChild(UiHelper.createLabel(`${layout.name}_gender_label`, getText(layout.genderLabel.textKey), T.text[3], layout.genderLabel.fontSize, layout.genderLabel.position, layout.genderLabel.size, Label.HorizontalAlign.LEFT));
    dialog.addChild(UiHelper.createLabel(`${layout.name}_occupation_label`, getText(layout.occupationLabel.textKey), T.text[3], layout.occupationLabel.fontSize, layout.occupationLabel.position, layout.occupationLabel.size, Label.HorizontalAlign.LEFT));
    // 性别文字胶囊（node.name = SEX 枚举值；显示名复用 label_sex_boy / label_sex_girl）
    const sexKeys = [SEX.BOY, SEX.GRIL];
    const sexOptionNodes = this.createTextOptionRow(
      `${layout.name}_sex`,
      sexKeys,
      (key) => getText(key === SEX.BOY ? "label_sex_boy" : "label_sex_girl"),
      layout.genderOptions,
    );
    dialog.addChild(sexOptionNodes.row);
    // 职业文字胶囊（显示名取 configs/role.occupations 的 name：战士 / 魔法师 / 道士）
    const occupationKeys = [OECCUPATION.ZHAN, OECCUPATION.FA, OECCUPATION.DAO];
    const occupationOptionNodes = this.createTextOptionRow(
      `${layout.name}_occupation`,
      occupationKeys,
      (key) => occupations.get(key as OECCUPATION)!.name,
      layout.occupationOptions,
    );
    dialog.addChild(occupationOptionNodes.row);
    // 名称分组小字 + 输入框（与登录页账号 / 密码同一套矢量底，UiHelper.createVectorInputField）
    dialog.addChild(UiHelper.createLabel(`${layout.name}_name_label`, getText(layout.nameInputLabel.textKey), T.text[3], layout.nameInputLabel.fontSize, layout.nameInputLabel.position, layout.nameInputLabel.size, Label.HorizontalAlign.LEFT));
    const nameInput = UiHelper.createVectorInputField(layout.nameInput.placeholder, layout.nameInput.position, layout.nameInput.size);
    dialog.addChild(nameInput.node);
    // 创建按钮（矢量朱红主按钮；默认压暗，输入名称后恢复）+ 取消按钮（ghost，关闭弹窗）
    const createLayout = layout.createButton;
    const createButton = GameUiHelper.createToneButton(createLayout.name, getText("label_role_create"), createLayout.position, createLayout.size, createLayout.fontSize, buttonTone.primary);
    createButton.on(Node.EventType.TOUCH_END, () => void this.createRole());
    dialog.addChild(createButton);
    const cancelLayout = layout.cancelButton;
    const cancelButton = GameUiHelper.createToneButton(cancelLayout.name, getText("label_confirm_cancel"), cancelLayout.position, cancelLayout.size, cancelLayout.fontSize, buttonTone.ghost);
    cancelButton.on(Node.EventType.TOUCH_END, () => this.cancelCreateRoleUI());
    dialog.addChild(cancelButton);

    const view: RoleSelectorCreateView = {
      dialog,
      nameInput: nameInput.input,
      sexOptionNodes: sexOptionNodes.pills,
      occupationOptionNodes: occupationOptionNodes.pills,
      selectedSex: SEX.BOY,
      selectedOccupation: OECCUPATION.ZHAN,
      createButton,
      cancelButton,
    };
    // 点胶囊换选中值并重画两态（不弹说明图、不播预览动画）
    sexOptionNodes.pills.forEach((pill) => {
      pill.on(Node.EventType.TOUCH_END, () => {
        view.selectedSex = pill.name;
        this.refreshTextOptions(sexOptionNodes.pills, view.selectedSex);
      }, this);
    });
    occupationOptionNodes.pills.forEach((pill) => {
      pill.on(Node.EventType.TOUCH_END, () => {
        view.selectedOccupation = pill.name;
        this.refreshTextOptions(occupationOptionNodes.pills, view.selectedOccupation);
      }, this);
    });
    // 默认选中第一颗（男 / 战士）：显式刷一遍两态
    this.refreshTextOptions(view.sexOptionNodes, view.selectedSex);
    this.refreshTextOptions(view.occupationOptionNodes, view.selectedOccupation);
    return view;
  }

  /**
   * 一行文字选项胶囊：横排居中，node.name = 枚举 key（点选后由 refreshTextOptions 重画）
   *
   * 胶囊名**必须是纯枚举值**：refreshTextOptions 按它比对选中态，createRole() 也直接拿它当
   * SEX / OECCUPATION 提交（曾错带 baseName 前缀，默认「男 / 战士」因此永远匹配不上）。
   * 胶囊底是 createRoundedPanel 的 Graphics，两态重画直接清了重画（与登录页职业标签同一套视觉：
   * 选中 = 面板底 + 金描边 + 亮字，未选中 = 透明底 + 弱线 + 灰字）。
   */
  private createTextOptionRow(
    baseName: string,
    keys: string[],
    labelFor: (key: string) => string,
    options: { positionY: number; pillSize: Size; spacing: number },
  ): { row: Node; pills: Node[] } {
    const row = new Node(`${baseName}_options`);
    row.setPosition(0, options.positionY, 0);
    const pills = keys.map((key, index) => {
      const pill = createRoundedPanel(key, options.pillSize, T.overlay.transparent, T.line[2], options.pillSize.height / 2);
      pill.setPosition((index - (keys.length - 1) / 2) * (options.pillSize.width + options.spacing), 0, 0);
      pill.addChild(UiHelper.createLabel(`${key}_label`, labelFor(key), T.text[3], T.fontSize.f14, new Vec2(), options.pillSize));
      SoundManager.bindClick(pill);
      blockClickThrough(pill);
      row.addChild(pill);
      return pill;
    });
    return { row, pills };
  }

  /** 整行选项的两态重画：选中 = 面板底 + 金描边 + 亮字，未选中 = 透明底 + 弱线 + 灰字 */
  private refreshTextOptions(pills: Node[], selectedKey: string): void {
    pills.forEach((pill) => {
      const active = pill.name === selectedKey;
      const size = pill.getComponent(UITransform)!.contentSize;
      const graphics = pill.getComponent(Graphics)!;
      graphics.clear();
      // 未选中补暗底（稿的胶囊是暗底描边；纯透明底会让 1px 描边无处落、实机也不渲染）
      UiHelper.paintRoundedPanel(graphics, size, size.height / 2, active ? T.surface[3] : T.surface[2], active ? T.gold[3] : T.line[2]);
      const label = pill.getChildByName(`${pill.name}_label`)!.getComponent(Label)!;
      label.color = active ? T.text[1] : T.text[3];
    });
  }

  cancelCreateRoleUI() {
    if (!this.createView) return;
    this.createView.dialog.destroy();
    this.createView = null;
  }

  /**
   * 创建角色（#597：建号职责在服务端）
   *
   * 客户端只传它自己才知道的三样 —— 输入框的名字、选中的职业与性别；
   * 初始数据（背包 / 装备 / 货币 / 技能 / 引导…）由服务端构造（背包装备货币全空、
   * 技能全解锁 1 级），返回的完整存档才是本地缓存的基线 —— 客户端不再 `new Role(...)`。
   */
  async createRole() {
    if (!this.createView || this.busy) return;
    // 读取表单（名字来自输入框；职业与性别是视图上记着的选中枚举值）
    const occupation = (this.createView.selectedOccupation || OECCUPATION.ZHAN) as OECCUPATION;
    const sex = (this.createView.selectedSex || SEX.BOY) as SEX;
    const name = this.createView.nameInput.getComponent(EditBox).string.trim();
    if (!name) return;
    this.busy = true;
    try {
      const detail = await RoleApi.create({ name, occupation, sex });
      StorageManager.cacheServerRole(detail);
      GameUiHelper.createTip("role_create_success_tip");
      this.cancelCreateRoleUI();
      await this.loadRoles();
      // 新建完直接选中它：否则玩家会看着自己刚建的角色站在列表里，左栏还是「选择角色」、进游戏按不动
      this.onlineRole(detail.id);
    } catch (error) {
      console.warn(`[RoleSelector] 创建角色失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  update() {
    // 名称输入同步创建按钮可用状态（矢量按钮没有 Sprite，用半透明表达不可用）
    if (!this.createView) return;
    const hasName = Boolean(this.createView.nameInput.getComponent(EditBox).string.trim());
    const opacity = this.createView.createButton.getComponent(UIOpacity) ?? this.createView.createButton.addComponent(UIOpacity);
    opacity.opacity = hasName ? 255 : 140;
  }
}
