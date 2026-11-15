import { _decorator, Component, EditBox, Label, Layout, Node, UITransform, Vec2, isValid } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import SoundManager from "./core/SoundManager";
import { loginLayout, tipsLayout } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { AuthApi, ZoneApi } from "./utils/net/Api";
import type { AuthResult, Zone } from "./utils/net/Api";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
import { HAS_MOUSE, bindMousePress } from "./utils/input/Pointer";
import AnnouncementNoticeDialog from "./components/dialogs/AnnouncementNoticeDialog";
import ZoneSelectDialog from "./components/dialogs/ZoneSelectDialog";
import ZoneStore from "./core/ZoneStore";
const { ccclass } = _decorator;

/**
 * 登录场景（账号登录 / 账号注册）
 *
 * 账号体系统一走服务端（见 ui/utils/net）：登录/注册成功后把令牌存进 Session，
 * 请求层随后自动带上它 —— 客户端不再自己造账号，也不再硬编码任何地址。
 * 两个按钮共用一个 submitting 标记，避免连点重复提交。
 *
 * **本页就选好区**（#1009）：顶部一颗「区服：X（点击切换）」，点它开选服弹窗。
 * 登录前没有令牌，所以列表用公共的 `GET /zones`（区名 / 状态 / 推荐）——
 * 拿不到「我在这区有几个角色」，也不需要：进哪个区由玩家定，角色列表进选角场景再拉。
 * 登录成功之后先按这个区落一次 `POST /zones/select`（见 submit → applyZone），
 * 选角页的 `GET /roles` 才是这个区的角色。
 *
 * 结构与选角场景不同：铺满屏幕的背景 + 一块 **cc.Layout 垂直布局的「舞台」**，
 * 其余元素全部挂在舞台下从上到下排 —— 顺序见 configs/layout/scenes.loginLayout.order，
 * 间距只有 spacingY 一个数（Layout.spacingY），高度随内容自动变、宽度固定（引擎在
 * VERTICAL 下只写容器高度）。舞台不缩放 —— 本作只有 1920×1080 一个分辨率，
 * 1 设计像素 = 1 屏幕像素（见 ScreenLayout.designResolution）
 */
@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;
  /** 舞台容器（cc.Layout 垂直布局：宽度固定 loginLayout.width，高度随内容自动变） */
  private stage: Node | null = null;
  /** 舞台内的元素（键 = loginLayout.order 里的 key；纵向位置由 Layout 统一排） */
  private widgets: Record<string, Node> = {};
  /** 是否正在提交（登录与注册互斥） */
  private submitting = false;
  /** 公告提醒弹窗（进登录页时把生效中的重要公告摊开给玩家看，见该类的说明） */
  private announcementNotice = new AnnouncementNoticeDialog();
  /** 选服弹窗（#1009）：点顶部那颗「区服：X（点击切换）」才开，不自动弹 */
  private zoneDialog = new ZoneSelectDialog();
  /** 顶部区服文案节点 */
  private zoneLabel: Node | null = null;
  /** 当前选中的区（列表还没拉到 / 拉失败时为 null —— 登录后按服务端记着的区走） */
  private pickedZone: Zone | null = null;
  /** 活区数（≥2 才给「点击切换」并响应点击；单区服点了也是它） */
  private zoneCount = 0;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 已有登录态（页面被误刷新 / 意外重载）→ 直接回选角，不让人重输账号密码。
    // 令牌若已过期，选角场景的请求会吃 401 → 网络层清会话并送回本场景，过期会话自然兜底
    if (Session.isLoggedIn) {
      SceneManager.loadScene("RoleSelector");
      return;
    }
    // 登录场景背景音（#683）：配置来自公开接口 `GET /game-config/audio`（登录页没有玩家令牌，
    // 快照拉不到），`play` 内部先补配置再播，所以这里不用 await —— 背景音晚半秒起来比登录页
    // 晚半秒出现好。已登录走上面的分支，不会响。
    void SoundManager.play("login_bgm");
    // 位置/尺寸与用图统一见 configs/layout/scenes.loginLayout
    const layout = loginLayout;
    // 背景（不在舞台内：铺满整个屏幕）
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", layout.background));
    // 舞台容器：cc.Layout 垂直布局 —— 元素从上到下排、间距只有 spacingY 一个数；
    // 高度随内容自动变（CONTAINER），宽度固定（引擎在 VERTICAL 布局下只写容器高度、不碰宽度）
    this.stage = new Node("login_stage");
    this.stage.addComponent(UITransform).setContentSize(layout.width, 0);
    const stageLayout = this.stage.addComponent(Layout);
    stageLayout.type = Layout.Type.VERTICAL;
    stageLayout.resizeMode = Layout.ResizeMode.CONTAINER;
    stageLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    stageLayout.spacingY = layout.spacingY;
    stageLayout.paddingBottom = layout.paddingBottom;
    this.node.addChild(this.stage);
    // 账号输入框（坐标不用给 —— 纵向位置由 Layout 统一排，这里只关心文案/尺寸/图标）
    const account = GameUiHelper.createInputField(layout.account.placeholder, new Vec2(), layout.account.size, layout.account.icon);
    this.accountInput = account.input;
    // 密码输入框
    const password = GameUiHelper.createInputField(layout.password.placeholder, new Vec2(), layout.password.size, layout.password.icon, layout.password.password);
    this.passwordInput = password.input;
    // 区服（#1009）：登录前就定好进哪个区，点它开选服弹窗。
    // 文案与「能不能点」由 renderZoneLabel 按活区数决定；点击走统一指针入口
    // （PC 走 bindMousePress 防穿透到输入框，触屏走 TOUCH_END）—— 审计 tools/audit-ui-click-through.cjs 守这条
    const zoneLayout = layout.zoneLabel;
    const zoneLabel = GameUiHelper.createText(zoneLayout.name, "", zoneLayout.fontSize, new Vec2(), zoneLayout.size, zoneLayout.color);
    SoundManager.bindClick(zoneLabel);
    if (HAS_MOUSE) {
      bindMousePress(zoneLabel, () => void this.openZonePicker(), this);
    } else {
      zoneLabel.on(Node.EventType.TOUCH_END, () => void this.openZonePicker(), this);
    }
    this.zoneLabel = zoneLabel;
    // 登录按钮
    const button = layout.loginButton;
    const loginButton = GameUiHelper.createTexturedButton(button.name, button.image, button.text, new Vec2(), button.size, button.textColor, button.fontSize);
    loginButton.on(Node.EventType.TOUCH_END, () => void this.login());
    // 注册按钮（用同一个账号密码输入框；服务端会校验账号唯一与格式）
    const registerLayout = layout.registerButton;
    const registerButton = GameUiHelper.createTexturedButton(
      registerLayout.name,
      registerLayout.image,
      registerLayout.text,
      new Vec2(),
      registerLayout.size,
      registerLayout.textColor,
      registerLayout.fontSize,
    );
    registerButton.on(Node.EventType.TOUCH_END, () => void this.register());
    // logo
    const logo = GameUiHelper.createImage(layout.logo.name, layout.logo.image, new Vec2(), layout.logo.size);
    // 元素按 key 登记，按 loginLayout.order 的顺序挂进舞台（挂载顺序 = 屏幕顺序，Layout 照它排）
    this.widgets = { logo, account: account.node, password: password.node, zoneLabel, loginButton, registerButton };
    for (const key of layout.order) {
      const widget = this.widgets[key];
      // 配置里写了但没建节点 = 元素被漏掉，登录页会少一块且位置对不上 —— 当场报出来，别静默跳过
      if (!widget) throw new Error(`login_stage is missing widget "${key}" (see loginLayout.order in configs/layout/scenes)`);
      this.stage.addChild(widget);
    }
    // 走到这里必然没有登录态（上方已拦截直接跳选角）：清掉上个账号的角色缓存与选中标记，
    // 避免换账号时串号 —— 有登录态的刷新不动缓存，回来还在原账号上
    StorageManager.clear();
    // 公告提醒：拉取「生效中的重要公告」（公共接口，无需令牌），有就弹、没有或拉取失败就静默 ——
    // 挂在本场景自己的节点上（登录场景没有 UI 图层容器，见 AnnouncementNoticeDialog 的说明），
    // 不 await：公告不该拖慢登录页的出现，也不阻塞账号密码输入
    void this.announcementNotice.open(this.node);
    // 区服列表（公共接口，无需令牌）：不 await 也不阻塞登录 —— 拉不到就不显示区名，
    // 登录后按服务端记着的区走（角色列表本来也按那个区拉）
    void this.loadZones();
  }

  /**
   * 拉一次活区列表，选默认区并刷新区服文案（#1009）
   *
   * 默认区优先级：
   * 1. **本机记着的那个区**（`ZoneStore`，还开放）—— 玩家上次自己选的，最该被尊重；
   * 2. **运营推荐区**（`recommended`，还开放）—— 新玩家 / 记录失效时的落点，运营想让新人
   *    去哪个区用这个标志表达，不靠客户端猜；
   * 3. **最新的开放区**（id 最大 = 最后建的）。
   *
   * 拉不到列表只提示一句、不阻塞登录：这时顶部不显示区名，登录后按服务端记着的区继续。
   */
  private async loadZones(): Promise<void> {
    let zones: Zone[];
    try {
      zones = await ZoneApi.list();
    } catch (error) {
      console.warn(`[Login] 区服列表加载失败（登录后按服务端记着的区进入）：${describeError(error)}`);
      GameUiHelper.createTip("zone_load_failed_tip");
      return;
    }
    if (!isValid(this.node)) return;
    this.zoneCount = zones.length;
    const target = this.pickDefaultZone(zones);
    if (!target) return;
    this.pickedZone = target;
    // 记在本机：顶部文案与游戏内（榜单 / 帮会标题）都要用区名
    ZoneStore.set(target.id, target.name);
    this.renderZoneLabel();
  }

  /** 默认区（优先级见 loadZones 的注释）；一个开放区都没有时返回 null */
  private pickDefaultZone(zones: Zone[]): Zone | null {
    const open = zones.filter((zone) => zone.status === "open");
    const remembered = ZoneStore.get();
    const rememberedHit = remembered ? open.find((zone) => zone.id === remembered.id) : undefined;
    if (rememberedHit) return rememberedHit;
    const recommended = open.find((zone) => zone.recommended);
    if (recommended) return recommended;
    // 最新的开放区：id 自增，最大 = 最后建的
    return open.length > 0 ? open.reduce((newest, zone) => (zone.id > newest.id ? zone : newest)) : null;
  }

  /**
   * 刷新区服文案
   *
   * 两个及以上活区才写「（点击切换）」；单区服写不带动作的那句，点了也不响应
   * （见 openZonePicker）。区名还没拿到时留空 —— 不显示一个猜出来的区名。
   */
  private renderZoneLabel(): void {
    if (!this.zoneLabel || !isValid(this.zoneLabel, true)) return;
    const label = this.zoneLabel.getComponent(Label);
    if (!this.pickedZone) {
      label.string = "";
      return;
    }
    label.string = getText(this.zoneCount > 1 ? "zone_switch_label" : "zone_current_label", { zone: this.pickedZone.name });
  }

  /** 打开选服弹窗（单区服不响应：弹出来也只有它自己） */
  private async openZonePicker(): Promise<void> {
    if (this.zoneCount < 2) return;
    await this.zoneDialog.open(this.node, this.pickedZone?.id ?? null, (zone) => this.onZonePicked(zone));
  }

  /** 选好区之后：只刷新顶部文案（落服务端在登录成功之后，见 applyZone） */
  private onZonePicked(zone: Zone): void {
    this.pickedZone = zone;
    this.renderZoneLabel();
  }

  /** 登录 */
  async login() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    await this.submit(() => AuthApi.login({ username: credentials.username, password: credentials.password }));
  }

  /** 注册（成功后直接进选角场景，无需再登录一次） */
  async register() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    // 注册只建账号：区是角色的属性，建角落在登录页选好的那个区（#1009）
    await this.submit(() => AuthApi.register({ username: credentials.username, password: credentials.password }));
  }

  /** 读输入框（为空时提示并返回 null） */
  private readCredentials(): { username: string; password: string } | null {
    const username = this.accountInput.getComponent(EditBox).string.trim();
    const password = this.passwordInput.getComponent(EditBox).string;
    if (!username || !password) {
      GameUiHelper.createTip("login_input_empty_tip");
      return null;
    }
    return { username, password };
  }

  /**
   * 提交登录 / 注册
   * 成功后存会话、按登录页选的区落一次，再进选角场景；失败由网络层统一飘字
   * （服务端文案如「账号或密码错误」直接展示）
   */
  private async submit(action: () => Promise<AuthResult>) {
    if (this.submitting) return;
    this.submitting = true;
    // 点击音不在这里（#685 移到 SoundManager.bindClick）：登录 / 注册按钮是 UiHelper.createButton
    // 建的，创建时就带上了；在这里再播一次会响两声
    try {
      const result = await action();
      Session.save(result.token, result.account);
      // 区必须在进选角页之前落地：GET /roles 按「当前浏览区」过滤，晚一步拉到的就是另一个区
      const fellBack = await this.applyZone();
      // 兜底换过区就先等飘字走完：飘字挂在本场景的 Canvas 上，立刻换场景会把它一起销毁
      // （与 RoleSelector.backToLoginWhenUnreachable 同一个坑）
      if (fellBack) await this.waitTipGone();
      SceneManager.loadScene("RoleSelector");
    } catch (error) {
      console.warn(`[Login] 提交失败：${describeError(error)}`);
    } finally {
      this.submitting = false;
    }
  }

  /** 等一条飘字「上浮 + 淡出」走完（时长见 tipsLayout，与 createTip 用的是同一组数） */
  private waitTipGone(): Promise<void> {
    const duration = tipsLayout.messageMoveDuration + tipsLayout.messageFadeDuration;
    return new Promise((resolve) => this.scheduleOnce(() => resolve(), duration));
  }

  /**
   * 把登录页选的区落到服务端（#1009）
   *
   * 登录前没有令牌，只能记在本机；拿到令牌后立刻 `POST /zones/select` ——
   * 之后选角页的 `GET /roles` 拉到的就是这个区的角色（选角页不再自己对齐区）。
   *
   * **失败不挡进游戏**：网络层已经飘过服务端文案（维护 / 关闭 / 已合并）。这时重拉一次
   * 区列表，若这个区确实进不去，就换一个还能进的并飘字说明；换不了就按服务端记着的区继续 ——
   * 区服系统出问题不该让人卡在登录页。
   *
   * @returns 是否换了兜底区（调用方据此决定要不要等飘字走完再换场景）
   */
  private async applyZone(): Promise<boolean> {
    const zone = this.pickedZone;
    if (!zone) return false;
    try {
      await ZoneApi.select({ zoneId: zone.id });
      return false;
    } catch (error) {
      console.warn(`[Login] 选定区服切换失败：${describeError(error)}`);
    }
    const fallback = await this.pickFallbackZone(zone.id);
    if (!fallback) return false;
    try {
      await ZoneApi.select({ zoneId: fallback.id });
      ZoneStore.set(fallback.id, fallback.name);
      GameUiHelper.createTip("zone_fallback_tip", { from: zone.name, to: fallback.name });
      return true;
    } catch (error) {
      console.warn(`[Login] 兜底区服切换失败（按服务端记着的区继续）：${describeError(error)}`);
      return false;
    }
  }

  /**
   * 换一个还能进的区（推荐 → 最新开放区）
   *
   * 两个前提：这个区**确实进不去了**（不在列表里 / 已不是开放状态），而且还有别的开放区。
   * 区还在开放就返回 null —— 那次失败多半是网络抖动，不能因为一次抖动把玩家换到别的区。
   */
  private async pickFallbackZone(failedId: number): Promise<Zone | null> {
    let zones: Zone[];
    try {
      zones = await ZoneApi.list();
    } catch {
      return null;
    }
    const failed = zones.find((zone) => zone.id === failedId);
    if (failed && failed.status === "open") return null;
    const open = zones.filter((zone) => zone.status === "open");
    if (open.length === 0) return null;
    const recommended = open.find((zone) => zone.recommended);
    return recommended ?? open.reduce((newest, zone) => (zone.id > newest.id ? zone : newest));
  }

  update(deltaTime: number) {}
}
