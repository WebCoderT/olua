import { _decorator, Color, Component, EditBox, Node, Size, Vec2 } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
const { ccclass, property } = _decorator;

@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;

  start() {
    // 背景与 logo
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", "login/login_bg"));
    // 账号输入框
    const account = GameUiHelper.createInputField("请输入您的游戏账号", new Vec2(0, -20), new Size(600, 80), "login/icon_user");
    this.accountInput = account.input;
    this.node.addChild(account.node);
    // 密码输入框
    const password = GameUiHelper.createInputField("请输入您的游戏密码", new Vec2(0, -120), new Size(600, 80), "login/icon_pwd", true);
    this.passwordInput = password.input;
    this.node.addChild(password.node);
    // 登录按钮
    const loginButton = GameUiHelper.createTexturedButton("login_button", "login/button", "账号登录", new Vec2(0, -260), new Size(300, 80), new Color("#f4fc00"), 30);
    this.node.addChild(loginButton);
    loginButton.on(Node.EventType.TOUCH_END, this.login, this);
    // logo
    this.node.addChild(GameUiHelper.createImage("game_logo", "logo", new Vec2(0, 200), new Size(600, 300)));
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
