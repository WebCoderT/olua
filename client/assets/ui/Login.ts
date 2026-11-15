import { _decorator, Component, EditBox, Layout, Node, UITransform, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import SoundManager from "./core/SoundManager";
import { loginLayout } from "../configs/hudLayout";
import { AuthApi } from "./utils/net/Api";
import type { AuthResult } from "./utils/net/Api";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
import AnnouncementNoticeDialog from "./components/dialogs/AnnouncementNoticeDialog";
const { ccclass } = _decorator;

/**
 * 登录场景（账号登录 / 账号注册）
 *
 * 账号体系统一走服务端（见 ui/utils/net）：登录/注册成功后把令牌存进 Session，
 * 请求层随后自动带上它 —— 客户端不再自己造账号，也不再硬编码任何地址。
 * 两个按钮共用一个 submitting 标记，避免连点重复提交。
 *
 * **本页不显示也不选任何区服**（#962）：登录前还不知道这个账号有哪几个区，
 * 在这里摆一个「区服：一区」只是把服务器上的第一个开放区当成玩家的选择，是假信息。
 * 区从选角页开始才有意义（那里有「区服：X（点击切换）」）。
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
    this.widgets = { logo, account: account.node, password: password.node, loginButton, registerButton };
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
    // 注册只建账号（#962）：区是角色的属性，进选角页后从顶部「区服」里选 / 建角时落在当前区
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
   * 成功后存会话并进选角场景；失败由网络层统一飘字（服务端文案如「账号或密码错误」直接展示）
   */
  private async submit(action: () => Promise<AuthResult>) {
    if (this.submitting) return;
    this.submitting = true;
    // 点击音不在这里（#685 移到 SoundManager.bindClick）：登录 / 注册按钮是 UiHelper.createButton
    // 建的，创建时就带上了；在这里再播一次会响两声
    try {
      const result = await action();
      Session.save(result.token, result.account);
      SceneManager.loadScene("RoleSelector");
    } catch (error) {
      console.warn(`[Login] 提交失败：${describeError(error)}`);
    } finally {
      this.submitting = false;
    }
  }

  update(deltaTime: number) {}
}
