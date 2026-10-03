import { _decorator, Component, EditBox, Node } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import { applyScreenPolicy } from "./utils/layout/ScreenLayout";
import { loginLayout } from "../configs/hudLayout";
const { ccclass } = _decorator;

@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;

  start() {
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
    loginButton.on(Node.EventType.TOUCH_END, this.login, this);
    // logo
    this.node.addChild(GameUiHelper.createImage(layout.logo.name, layout.logo.image, layout.logo.position, layout.logo.size));
    // 清空缓存------开发时使用
    StorageManager.clear();
  }

  // 登陆事件
  login() {
    // 获取密码
    const account = this.accountInput.getComponent(EditBox).string;
    const password = this.passwordInput.getComponent(EditBox).string;

    // 跳转到角色选择页面
    SceneManager.loadScene("RoleSelector");
  }

  update(deltaTime: number) {}
}
