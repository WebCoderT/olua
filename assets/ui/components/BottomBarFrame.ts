import { Node, ProgressBar, Size, Sprite, Vec2 } from "cc";
import GameUiHelper, { BottomNavBarButton } from "../helpers/GameUiHelper";
import GameRoleUiHelper from "../helpers/GameRoleUiHelper";
import StorageHelper from "../utils/StorageHelper";
import UiHelper from "../helpers/UiHelper";
import LayerHelper from "../helpers/LayerHelper";
import RoleInformationDialog from "./RoleInformationDialog";
import RoleBagDialog from "./RoleBagDialog";
import { getCurrentLevelExpRate } from "../../configs/level";
import { Role } from "../../configs/role";

const bottomNavBarButtons: BottomNavBarButton[] = [
  { label: "角色", icon: "bottom-nav-bar/role", openLevel: 1, onClick: () => RoleInformationDialog.open(), name: "personal_information_dialog" },
  { label: "背包", icon: "bottom-nav-bar/bag", openLevel: 1, onClick: () => RoleBagDialog.open(), name: "bag_dialog" },
  { label: "好友", icon: "bottom-nav-bar/friend", openLevel: 10, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "组队", icon: "bottom-nav-bar/group", openLevel: 10, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "任务", icon: "bottom-nav-bar/task", openLevel: 1, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "技能", icon: "bottom-nav-bar/skill", openLevel: 1, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "坐骑", icon: "bottom-nav-bar/horse", openLevel: 1, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "商城", icon: "bottom-nav-bar/mall", openLevel: 1, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
  { label: "设置", icon: "bottom-nav-bar/config", openLevel: 1, onClick: () => GameRoleUiHelper.createPersonalInformationDialog(), name: "personal_information_dialog" },
];

interface BottomBarFrame {
  selectedRole: Role | null;
  // 初始化
  init: () => void;
  // 经验条
  expBar: Node;
  // 更新经验条
  updateExpBar: () => void;
}

const BottomBarFrame: BottomBarFrame = {
  selectedRole: null,
  init() {
    // 初始化角色数据
    this.selectedRole = StorageHelper.findOnlineRole();
    // 基础UI
    // 底部导航区域
    const bottomNavBarBg = UiHelper.createSprite("bottom_nav_bar_background", "bottom-nav-bar/bg", new Vec2(0, -316), new Size(1200, 240));
    // 功能按键区域
    const bottomNavBar = GameUiHelper.createBottomNavBar(6, new Vec2(200, -10), new Size(500, 44));
    bottomNavBarButtons.map((button) => {
      const node = GameUiHelper.createBottomNavBarButton(button, this.selectedRole);
      // 如果node是禁用，禁用使用grayscale表示
      node.on(
        Node.EventType.TOUCH_END,
        () => {
          // 禁用，出现提示
          if (node.getComponent(Sprite).grayscale) GameUiHelper.createErrorTip("feature_locked_tip", `${button.label}功能需要在${button.openLevel}级后开放`);
          else button.onClick();
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
    BottomBarFrame.selectedRole = StorageHelper.findOnlineRole();
    // 更新经验条
    BottomBarFrame.expBar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp);
  },
};

export default BottomBarFrame;
