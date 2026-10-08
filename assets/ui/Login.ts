import { _decorator, Component, EditBox, Node } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { applyScreenPolicy } from "./utils/layout/ScreenLayout";
import { loginLayout } from "../configs/hudLayout";
import { AuthApi } from "./utils/net/Api";
import type { AuthResult } from "./utils/net/Api";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
const { ccclass } = _decorator;

/**
 * 登录场景（账号登录 / 账号注册）
 *
 * 账号体系统一走服务端（见 ui/utils/net）：登录/注册成功后把令牌存进 Session，
 * 请求层随后自动带上它 —— 客户端不再自己造账号，也不再硬编码任何地址。
 * 两个按钮共用一个 submitting 标记，避免连点重复提交。
 */
@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;
  /** 是否正在提交（登录与注册互斥） */
  private submitting = false;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 屏幕适配：铺满窗口（无黑边），与游戏内一致（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    // 控件位置/尺寸与用图统一见 configs/hudLayout.loginLayout
    const layout = loginLayout;
    // 背景
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", layout.background));
    // 账号输入框
    const account = GameUiHelper.createInputField(layout.account.placeholder, layout.account.position, layout.account.size, layout.account.icon);
    this.accountInput = account.input;
    this.node.addChild(account.node);
    // 密码输入框
    const password = GameUiHelper.createInputField(layout.password.placeholder, layout.password.position, layout.password.size, layout.password.icon, layout.password.password);
    this.passwordInput = password.input;
    this.node.addChild(password.node);
    // 登录按钮
    const button = layout.loginButton;
    const loginButton = GameUiHelper.createTexturedButton(button.name, button.image, button.text, button.position, button.size, button.textColor, button.fontSize);
    this.node.addChild(loginButton);
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
    this.node.addChild(registerButton);
    registerButton.on(Node.EventType.TOUCH_END, () => void this.register());
    // logo
    this.node.addChild(GameUiHelper.createImage(layout.logo.name, layout.logo.image, layout.logo.position, layout.logo.size));
    // 清空缓存------开发时使用（含角色缓存与上次会话，进登录页一律重新登录）
    StorageManager.clear();
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
