import { Node, ProgressBar, Size, Sprite, Vec2 } from "cc";
import { bottomNavBarButtons, getCurrentLevelExpRate, Role } from "../../configs";
import GameUiHelper from "../GameUiHelper";
import StorageHelper from "../StorageHelper";
import UiHelper from "../UiHelper";
import LayerHelper from "../LayerHelper";

interface BottomBarFrame {
  selectedRole: Role | null;
  init: () => void;
  // 经验条
  expBar: Node;
  // 更新经验条
  updateExpBar: Function;
}

const BottomBarFrame: BottomBarFrame = {
  selectedRole: null,
  init() {
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
          if (node.getComponent(Sprite).grayscale) GameUiHelper.createErrorTip(`${button.label}功能需要在${button.openLevel}级后开放`);
        },
        this,
      );
      bottomNavBar.addChild(node);
    });
    // 经验条
    BottomBarFrame.expBar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp), new Vec2(0, -50), new Size(784, 10));
    LayerHelper.setLayerToUILayer(BottomBarFrame.expBar);

    // 统一添加进底层区域
    bottomNavBarBg.addChild(bottomNavBar);
    bottomNavBarBg.addChild(BottomBarFrame.expBar);

    LayerHelper.addToUILayer(bottomNavBarBg);
  },
  // 经验条
  expBar: null,
  // 更新经验条
  updateExpBar() {
    // 更新角色数据
    BottomBarFrame.selectedRole = StorageHelper.findSelectedRole();
    // 更新经验条
    BottomBarFrame.expBar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp);
  },
};

export default BottomBarFrame;
