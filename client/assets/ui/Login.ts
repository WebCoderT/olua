import { _decorator, Component, Label, Node, UITransform, Vec2, isValid } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { applyScreenPolicy, getStageScale, getVisibleSize, onWindowResize } from "./utils/layout/ScreenLayout";
import { loginLayout, uiImages } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { AuthApi } from "./utils/net/Api";
import type { AuthResult } from "./utils/net/Api";
import ApiError, { describeError } from "./utils/net/ApiError";
import { ACCOUNT_BIZ_CODES } from "./utils/net/ApiCodes";
import DeviceAccount from "./utils/net/DeviceAccount";
import type { DeviceCredentials } from "./utils/net/DeviceAccount";
import { installNetwork } from "./utils/net/NetworkSetup";
import { blockClickThrough } from "./utils/input/UiHit";
import Session from "./utils/net/Session";
import AnnouncementNoticeDialog from "./components/dialogs/AnnouncementNoticeDialog";
const { ccclass } = _decorator;

/** 生成账号的重试次数（只为「撞名」准备：唯一性只能由服务端判定，客户端撞了就换一个） */
const ACCOUNT_GENERATE_ATTEMPTS = 3;

/**
 * 登录场景（本机账号自动生成 / 自动登录），视觉按 design/login.png 重排（issue #143、#146）
 *
 * **玩家不输账号、也不注册**：账号与密码由 `ui/utils/net/DeviceAccount` 在本机生成并保存，
 * 点「进入游戏」时：
 * 1. 本地有凭据 → 直接登录；
 * 2. 登录回 `10003`（账号不存在与口令错是同一个码）→ 本地这份已不成立，丢掉重新生成；
 * 3. 没有凭据（首次进入 / 刚清过）→ 生成 → `POST /auth/register`（服务端直接回令牌）→ 进选角；
 * 4. 网络失败 / 限流 / 封禁 → **保留**本地凭据原样报错（封禁不能靠换号绕过）。
 *
 * 凭据先落盘再注册：注册响应丢失时下次进入会先试登录，若服务端其实已建号就能救回来，不会白丢存档。
 *
 * 结构与选角场景同一套：铺满窗口的背景 + 一块固定设计尺寸的「舞台」，
 * 其余元素全部挂在舞台下按设计坐标摆放（坐标以舞台中心为原点，见 configs/layout/scenes.loginLayout），
 * 舞台按可见尺寸等比缩放（contain、只缩不放）—— 任意窗口宽高比下构图都完整可见。
 * 右上角功能圆钮列（公告/协议/隐私协议/清除缓存）与选服条是设计稿带来的入口：
 * 公告重开公告弹窗、清除缓存清本地角色缓存，其余未开放的功能统一「敬请期待」
 */
@ccclass("Login")
export class Login extends Component {
  /** 舞台容器（除背景外的所有元素都挂这里，整体按可见尺寸等比缩放） */
  private stage: Node | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;
  /** 是否正在提交（防连点：自动登录与自动注册全程只允许一条请求链） */
  private submitting = false;
  /** 本机账号展示（只读；文本随「有没有凭据」变化，见 renderAccount） */
  private accountLabel: Node | null = null;
  /** 公告提醒弹窗（进登录页时摊开重要公告；右上角「公告」圆钮可再次打开） */
  private announcementNotice = new AnnouncementNoticeDialog();

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 屏幕适配：铺满窗口（无黑边），与游戏内一致（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    // 位置/尺寸与用图统一见 configs/layout/scenes.loginLayout
    const layout = loginLayout;
    // 背景（不在舞台内：铺满可见区，舞台等比缩小后四周留白由它兜底）
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", layout.background));
    // 舞台容器：各元素按设计坐标摆在它下面（见 configs/layout/scenes.loginLayout）
    this.stage = new Node("login_stage");
    this.stage.addComponent(UITransform).setContentSize(layout.stageSize);
    this.node.addChild(this.stage);
    // 选服条（装饰 + 入口：服务器名与「选服」都是 Label，点击提示只有一个服）
    this.createServerBar();
    // 本机账号（只读展示，替代原来的账号 / 密码输入框）
    this.createAccountLine();
    // 进入游戏（自动登录；首次进入会先自动建号）
    const button = layout.loginButton;
    const loginButton = GameUiHelper.createTexturedButton(button.name, button.image, button.text, button.position, button.size, button.textColor, button.fontSize);
    this.stage.addChild(loginButton);
    loginButton.on(Node.EventType.TOUCH_END, () => void this.enterGame());
    // 右上角功能圆钮列（公告 / 协议 / 隐私协议 / 清除缓存）
    this.createCornerButtons();
    // 按当前可见尺寸适配舞台，并在窗口尺寸变化时重排
    this.applyStageLayout();
    this.offWindowResize = onWindowResize(() => this.applyStageLayout());
    // 清角色缓存与会话（进登录页一律重新登录）—— **不动本机凭据**，否则点一次清缓存就换号丢角色
    StorageManager.clear();
    // 公告提醒：拉取「生效中的重要公告」（公共接口，无需令牌），有就弹、没有或拉取失败就静默 ——
    // 挂在本场景自己的节点上（登录场景没有 UI 图层容器，见 AnnouncementNoticeDialog 的说明），
    // 不 await：公告不该拖慢登录页的出现，也不阻塞自动登录
    void this.announcementNotice.open(this.node);
  }

  /** 场景卸载：取消窗口尺寸监听（监听挂在 screen 单例上，不随节点销毁） */
  onDestroy() {
    this.offWindowResize?.();
    this.offWindowResize = null;
  }

  /**
   * 舞台适配（窗口尺寸变化时可重复调用）：按可见尺寸等比缩放整块舞台并居中
   * （与选角场景同一套做法，缩放算法见 ui/utils/layout/ScreenLayout.getStageScale）
   */
  private applyStageLayout() {
    const stage = this.stage;
    if (!stage || !isValid(stage, true)) return;
    const scale = getStageScale(loginLayout.stageSize, getVisibleSize());
    stage.setScale(scale, scale, 1);
  }

  /** 本机账号展示行（只读）：有凭据就显示账号名，没有就提示「首次进入自动创建」 */
  private createAccountLine() {
    const layout = loginLayout.account;
    const label = GameUiHelper.createText(layout.name, "", layout.fontSize, layout.position, layout.size, layout.color);
    this.stage!.addChild(label);
    this.accountLabel = label;
    this.renderAccount();
    // 说明文案（原密码输入框位置）：玩家会疑惑「账号哪来的」，这里一次讲清
    const hint = loginLayout.autoHint;
    this.stage!.addChild(GameUiHelper.createText(hint.name, getText("login_device_account_hint"), hint.fontSize, hint.position, hint.size, hint.color));
  }

  /** 刷新本机账号展示（生成新账号 / 清掉凭据后都要调） */
  private renderAccount() {
    const node = this.accountLabel;
    if (!node || !isValid(node, true)) return;
    const label = node.getComponent(Label);
    if (!label) return;
    const credentials = DeviceAccount.load();
    label.string = credentials ? getText("login_device_account_label", { name: credentials.username }) : getText("login_device_account_pending_tip");
  }

  /** 选服条：底图（含红宝石装饰）+ 服务器名与「选服」文字；点击提示当前只有一个服 */
  private createServerBar() {
    const layout = loginLayout.serverBar;
    const bar = GameUiHelper.createImage(layout.name, layout.image, layout.position, layout.size);
    this.stage!.addChild(bar);
    bar.addChild(GameUiHelper.createText(layout.serverName.name, layout.serverName.text, layout.serverName.fontSize, layout.serverName.position, layout.serverName.size, layout.serverName.color));
    const select = GameUiHelper.createText(layout.selectServer.name, layout.selectServer.text, layout.selectServer.fontSize, layout.selectServer.position, layout.selectServer.size, layout.selectServer.color);
    bar.addChild(select);
    bar.on(Node.EventType.TOUCH_END, () => GameUiHelper.createTip("server_single_tip"));
    // 整条可点（选服提示），在 mouse 通道也登记拦截，避免点击穿透到下层
    blockClickThrough(bar);
  }

  /** 右上角功能圆钮列：球体底图 + 居中功能名文字；点击按 action 分发（见 onCornerButtonClick） */
  private createCornerButtons() {
    const layout = loginLayout;
    layout.cornerButtons.forEach((item) => {
      const button = GameUiHelper.createImage(`corner_${item.action}`, uiImages.loginCornerButton, item.position, layout.cornerButtonSize);
      const labelLayout = layout.cornerButtonLabel;
      button.addChild(GameUiHelper.createText(`${item.action}_text`, item.label, labelLayout.fontSize, new Vec2(0, 0), labelLayout.size, labelLayout.color));
      this.stage!.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => this.onCornerButtonClick(item.action));
      // 可点元素在 mouse 通道也登记拦截（否则点击会穿透到下层，见 utils/input/UiHit.blockClickThrough）
      blockClickThrough(button);
    });
  }

  /** 功能圆钮分发（action 见 loginLayout.cornerButtons）：公告重开公告弹窗，清除缓存清本地存储，其余未开放 */
  private onCornerButtonClick(action: string) {
    if (action === "announcement") {
      void this.announcementNotice.open(this.node);
      return;
    }
    if (action === "clear_cache") {
      // 只清角色缓存与会话，本机账号留着 —— 否则下次进来会变成新号，旧角色再也回不去
      StorageManager.clear();
      this.renderAccount();
      GameUiHelper.createTip("cache_cleared_tip");
      return;
    }
    GameUiHelper.createTip("coming_soon_tip");
  }

  /**
   * 进入游戏（自动登录 / 首次自动建号）
   *
   * 两条分支的边界很明确：**只有「凭据在服务端不成立」才重新生成**，
   * 网络问题、登录限流、封禁都保留本地凭据报错 —— 那些情况下换号既解决不了问题，
   * 还会把玩家已经有的角色永久留在一个他再也拿不到的账号上。
   */
  private async enterGame() {
    if (this.submitting) return;
    this.submitting = true;
    GameUiHelper.createTip("login_connecting_tip");
    try {
      const saved = DeviceAccount.load();
      if (saved) {
        const loggedIn = await this.loginWithSavedAccount(saved);
        if (loggedIn) return;
        // 本地账号在服务端已不成立（换库 / 账号被删）：丢掉重生成，否则每次点都撞同一句错误
        DeviceAccount.clear();
        this.renderAccount();
      }
      await this.createAccountAndEnter();
    } catch (error) {
      // 两条请求都是 silent 的（见下），全局飘字不会响 —— 在这里统一提示一次
      GameUiHelper.createErrorTipText(describeError(error));
      console.warn(`[Login] 进入游戏失败：${describeError(error)}`);
    } finally {
      this.submitting = false;
    }
  }

  /**
   * 用本机凭据登录
   *
   * `silent`：本地凭据失效是**正常分支**（下一步就会重新建号），不该先弹一条「账号或密码错误」吓玩家；
   * 其余错误由调用方统一提示。
   * @returns 是否登录成功（true = 已切到选角场景）
   */
  private async loginWithSavedAccount(credentials: DeviceCredentials): Promise<boolean> {
    try {
      const result = await AuthApi.login({ username: credentials.username, password: credentials.password }, { silent: true });
      this.enterSelector(result);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === ACCOUNT_BIZ_CODES.credentialInvalid) return false;
      throw error;
    }
  }

  /**
   * 生成一套新账号并注册（服务端注册成功直接回令牌，不用再登录一次）
   *
   * **先落盘再请求**：注册响应可能丢（超时），但服务端已经建了号 —— 下次进入先试登录就能接上，
   * 不会因为「没收到响应」白白丢掉一对已经有角色的凭据。
   */
  private async createAccountAndEnter() {
    for (let attempt = 0; attempt < ACCOUNT_GENERATE_ATTEMPTS; attempt++) {
      const credentials = DeviceAccount.generate();
      DeviceAccount.save(credentials);
      this.renderAccount();
      try {
        const result = await AuthApi.register({ username: credentials.username, password: credentials.password }, { silent: true });
        this.enterSelector(result);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.code === ACCOUNT_BIZ_CODES.accountExists) continue;
        // 网络 / 超时 / 关闭注册 / 限流：保留凭据，下次进入先用登录把它接上
        throw error;
      }
    }
    // 连续撞名（理论上不可能）：清掉这份没注册成功的凭据，别让它一直卡住
    DeviceAccount.clear();
    this.renderAccount();
    GameUiHelper.createTip("login_account_generate_failed_tip");
  }

  /** 登录 / 注册成功：存会话并进选角场景 */
  private enterSelector(result: AuthResult) {
    Session.save(result.token, result.account);
    SceneManager.loadScene("RoleSelector");
  }

  update(deltaTime: number) {}
}
