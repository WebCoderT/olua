import { _decorator, Color, Component, EditBox, Node, Size, Vec2 } from "cc";
import UiHelper from "./UiHelper";
import SceneManager from "./SceneManager";
import StorageHelper from "./StorageHelper";
const { ccclass, property } = _decorator;

@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;

  start() {
    // 登陆界面
    this.node.addChild(UiHelper.createFullScreenNode("login/login_bg"));
    // 账号输入框
    const accountInputBg = UiHelper.createSprite("login/input_bg", new Vec2(0, -20), new Size(600, 80));
    const accountIcon = UiHelper.createSprite("login/icon_user", new Vec2(-240, -6), new Size(40, 40));
    accountInputBg.addChild(accountIcon);
    this.accountInput = UiHelper.createInputBox("请输入您的游戏账号", new Vec2(0, -6), new Vec2(400, 60));
    accountInputBg.addChild(this.accountInput);
    this.node.addChild(accountInputBg);
    // 密码输入框
    const passwordInputBg = UiHelper.createSprite("login/input_bg", new Vec2(0, -120), new Size(600, 80));
    const passwordIcon = UiHelper.createSprite("login/icon_pwd", new Vec2(-240, -6), new Size(40, 40));
    this.passwordInput = UiHelper.createInputBox("请输入您的游戏密码", new Vec2(0, -6), new Vec2(400, 60), true);
    passwordInputBg.addChild(passwordIcon);
    passwordInputBg.addChild(this.passwordInput);
    this.node.addChild(passwordInputBg);
    // 登陆按钮
    const loginButton = UiHelper.createButton("login/button", new Vec2(0, -260), new Size(300, 80));
    const label = UiHelper.createLabel("账号登录", new Color("#f4fc00"), 30, new Vec2(0, 0), new Size(300, 80));
    loginButton.addChild(label);
    this.node.addChild(loginButton);
    loginButton.on(Node.EventType.TOUCH_END, this.login, this);
    // logo
    const logo = UiHelper.createSprite("logo", new Vec2(0, 200), new Size(322, 219));
    this.node.addChild(logo);
    // 清空缓存------开发时使用
    StorageHelper.clear();
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
