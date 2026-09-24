import { _decorator, Camera, Component, error, Node, Size, Sprite, tween, UIOpacity, Vec2, Vec3 } from "cc";
import GameUiHelper from "./GameUiHelper";
import StorageHelper from "./StorageHelper";
import LayerHelper from "./LayerHelper";
import UiHelper from "./UiHelper";
import { bottomNavBarButtons, getCurrentLevelExpRate, Role } from "../configs";
const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  @property({ type: Camera })
  camera: Camera;

  selectedRole: Role;

  start() {
    // 初始化图层
    LayerHelper.initLayer(this.node, this.camera);
    // 初始化角色数据
    this.selectedRole = StorageHelper.findSelectedRole();
    // 基础UI
    // 底部导航区域
    const bottomNavBarBg = UiHelper.createSprite("bottom-nav-bar/bg", new Vec2(0, -316), new Size(1200, 240));
    // 功能按键区域
    const bottomNavBar = GameUiHelper.createBottomNavBar(6, new Vec2(200, -10), new Size(500, 44));
    bottomNavBarButtons.map((button) => {
      const node = GameUiHelper.createBottomNavBarButton(button, this.selectedRole);
      // 如果node是禁用，禁用使用grayscale表示
      node.on(
        Node.EventType.TOUCH_END,
        () => {
          // 禁用，出现提示
          if (node.getComponent(Sprite).grayscale) this.showErrorTip(`${button.label}功能需要在${button.openLevel}级后开放`);
        },
        this,
      );
      bottomNavBar.addChild(node);
    });
    // 经验条
    const bar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp), new Vec2(0, -50), new Size(784, 10));
    LayerHelper.setLayerToUILayer(bar);

    // 统一添加进底层区域
    bottomNavBarBg.addChild(bottomNavBar);
    bottomNavBarBg.addChild(bar);

    LayerHelper.addToUILayer(bottomNavBarBg);

    // 用户头像
    LayerHelper.addToUILayer(GameUiHelper.createRoleInfoFrame(this.selectedRole));
  }

  // 错误提示，临时放在这里
  showErrorTip(error: string) {
    const errorTip = UiHelper.createErrorTip(error);
    const uiOpacity = errorTip.addComponent(UIOpacity);
    tween(errorTip)
      .to(0.3, { position: new Vec3(0, 40, 0) })
      .start();
    tween(uiOpacity)
      .to(1.5, { opacity: 0 })
      .call(() => {
        errorTip.destroy();
      })
      .start();
    LayerHelper.addToUILayer(errorTip);
  }

  update(deltaTime: number) {}
}
