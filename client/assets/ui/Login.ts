import { _decorator, Component, EditBox, Label, Node, UITransform, isValid } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { applyScreenPolicy, getStageScale, getVisibleSize, onWindowResize } from "./utils/layout/ScreenLayout";
import { loginLayout } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { AuthApi, ZoneApi } from "./utils/net/Api";
import type { AuthResult, Zone } from "./utils/net/Api";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
import { HAS_MOUSE, bindMousePress } from "./utils/input/Pointer";
import AnnouncementNoticeDialog from "./components/dialogs/AnnouncementNoticeDialog";
const { ccclass } = _decorator;

/**
 * 登录场景（账号登录 / 账号注册）
 *
 * 账号体系统一走服务端（见 ui/utils/net）：登录/注册成功后把令牌存进 Session，
 * 请求层随后自动带上它 —— 客户端不再自己造账号，也不再硬编码任何地址。
 * 两个按钮共用一个 submitting 标记，避免连点重复提交。
 *
 * 结构与选角场景同一套：铺满窗口的背景 + 一块固定设计尺寸的「舞台」，
 * 其余元素全部挂在舞台下按设计坐标摆放（坐标以舞台中心为原点，见 configs hudLayout.loginLayout），
 * 舞台按可见尺寸等比缩放（contain、只缩不放）—— 不缩放的话，铺满窗口策略会在
 * 偏宽窗口裁掉 logo 顶部与注册按钮、窄高窗口（手机竖屏）裁掉输入框两侧
 */
@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;
  /** 舞台容器（除背景外的所有元素都挂这里，整体按可见尺寸等比缩放） */
  private stage: Node | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;
  /** 是否正在提交（登录与注册互斥） */
  private submitting = false;
  /** 公告提醒弹窗（进登录页时把生效中的重要公告摊开给玩家看，见该类的说明） */
  private announcementNotice = new AnnouncementNoticeDialog();
  /** 活区列表（注册时从中选一个；拉取失败退化为空 —— 注册不带 zoneId，服务端落一区） */
  private zones: Zone[] = [];
  /** 当前选中的区服下标（zones 的下标；tap 循环切换） */
  private zoneIndex = 0;
  /** 区服选择文案节点（zones 拉到后创建并刷新） */
  private zoneLabel: Node | null = null;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 屏幕适配：铺满窗口（无黑边），与游戏内一致（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    // 位置/尺寸与用图统一见 configs/hudLayout.loginLayout
    const layout = loginLayout;
    // 背景（不在舞台内：铺满可见区，舞台等比缩小后四周留白由它兜底）
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", layout.background));
    // 舞台容器：各元素按设计坐标摆在它下面（见 configs/hudLayout.loginLayout）
    this.stage = new Node("login_stage");
    this.stage.addComponent(UITransform).setContentSize(layout.stageSize);
    this.node.addChild(this.stage);
    // 账号输入框
    const account = GameUiHelper.createInputField(layout.account.placeholder, layout.account.position, layout.account.size, layout.account.icon);
    this.accountInput = account.input;
    this.stage.addChild(account.node);
    // 密码输入框
    const password = GameUiHelper.createInputField(layout.password.placeholder, layout.password.position, layout.password.size, layout.password.icon, layout.password.password);
    this.passwordInput = password.input;
    this.stage.addChild(password.node);
    // 登录按钮
    const button = layout.loginButton;
    const loginButton = GameUiHelper.createTexturedButton(button.name, button.image, button.text, button.position, button.size, button.textColor, button.fontSize);
    this.stage.addChild(loginButton);
    loginButton.on(Node.EventType.TOUCH_END, () => void this.login());
    // 注册按钮（用同一个账号密码输入框；服务端会校验账号唯一与格式）
    const registerLayout = layout.registerButton;
    const registerButton = GameUiHelper.createTexturedButton(
      registerLayout.name,
      registerLayout.image,
      registerLayout.text,
      registerLayout.position,
      registerLayout.size,
      registerLayout.textColor,
      registerLayout.fontSize,
    );
    this.stage.addChild(registerButton);
    registerButton.on(Node.EventType.TOUCH_END, () => void this.register());
    // logo
    this.stage.addChild(GameUiHelper.createImage(layout.logo.name, layout.logo.image, layout.logo.position, layout.logo.size));
    // 区服选择（多开区 #295）：先摆一个空文案节点，活区列表拉到后再刷新内容。
    // 点击换区走统一指针入口（PC 走 bindMousePress 防穿透，触屏走 TOUCH_END）—— 审计 audit-ui-click-through 守这条
    this.zoneLabel = GameUiHelper.createText("login_zone", "", layout.zoneSelector.fontSize, layout.zoneSelector.position, layout.zoneSelector.size, layout.zoneSelector.color);
    this.stage.addChild(this.zoneLabel);
    this.bindZonePicker();
    // 按当前可见尺寸适配舞台，并在窗口尺寸变化时重排
    this.applyStageLayout();
    this.offWindowResize = onWindowResize(() => this.applyStageLayout());
    // 拉活区列表（公共接口，无需令牌；不阻塞登录页出现，失败静默 —— 注册落默认区）
    void this.loadZones();
    // 清空缓存------开发时使用（含角色缓存与上次会话，进登录页一律重新登录）
    StorageManager.clear();
    // 公告提醒：拉取「生效中的重要公告」（公共接口，无需令牌），有就弹、没有或拉取失败就静默 ——
    // 挂在本场景自己的节点上（登录场景没有 UI 图层容器，见 AnnouncementNoticeDialog 的说明），
    // 不 await：公告不该拖慢登录页的出现，也不阻塞账号密码输入
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

  /** 登录 */
  async login() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    await this.submit(() => AuthApi.login({ username: credentials.username, password: credentials.password }));
  }

  /** 注册（成功后直接进选角场景，无需再登录一次；带上当前选中的区服） */
  async register() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    const zone = this.zones[this.zoneIndex];
    await this.submit(() =>
      AuthApi.register({
        username: credentials.username,
        password: credentials.password,
        ...(zone ? { zoneId: zone.id } : {}),
      }),
    );
  }

  /**
   * 拉活区列表（公共接口）：拉到后刷新区服文案；
   * 只有一个区就不给「点击切换」的提示（切了也是它）。失败静默 —— 老服务端没有这个接口，
   * 注册不带 zoneId，服务端落默认区，行为与区服上线前完全一致。
   */
  private async loadZones() {
    try {
      const zones = await ZoneApi.list();
      if (!isValid(this.zoneLabel, true)) return;
      this.zones = zones ?? [];
      this.zoneIndex = 0;
      this.renderZone();
    } catch (error) {
      console.warn(`[Login] 区服列表拉取失败（注册将落默认区）：${describeError(error)}`);
    }
  }

  /** 区服选择器的点击接线：PC 走 bindMousePress（按压起点在本节点才响应，防穿透），触屏走 TOUCH_END */
  private bindZonePicker() {
    if (!this.zoneLabel) return;
    if (HAS_MOUSE) {
      bindMousePress(this.zoneLabel, () => this.cycleZone(), this);
      return;
    }
    this.zoneLabel.on(Node.EventType.TOUCH_END, () => this.cycleZone(), this);
  }

  /** 点一下换下一个区（循环；单区时无事发生） */
  private cycleZone() {
    if (this.zones.length < 2) return;
    this.zoneIndex = (this.zoneIndex + 1) % this.zones.length;
    this.renderZone();
  }

  /** 刷新区服文案（zones 未拉到时保持空白，不占视觉焦点） */
  private renderZone() {
    if (!this.zoneLabel || !isValid(this.zoneLabel, true)) return;
    const zone = this.zones[this.zoneIndex];
    if (!zone) {
      this.zoneLabel.getComponent(Label).string = "";
      return;
    }
    const key = this.zones.length > 1 ? "login_zone_picker" : "login_zone_label";
    this.zoneLabel.getComponent(Label).string = getText(key, { zone: zone.name });
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
