import { Color, Label, Node, ProgressBar, Size, Sprite, UITransform, Vec2 } from "cc";
import GameUiHelper, { BottomNavBarButton } from "../helpers/GameUiHelper";
import StorageManager from "../utils/StorageManager";
import UiHelper from "../helpers/UiHelper";
import LayerManager from "../utils/LayerManager";
import RoleInformationDialog from "./RoleInformationDialog";
import RoleBagDialog from "./RoleBagDialog";
import { getCurrentLevelExpRate } from "../../configs/level";
import { Role } from "../../configs/role";
import SkillDialog from "./SkillDialog";

const bottomNavBarButtons: BottomNavBarButton[] = [
  { label: "角色", icon: "bottom-nav-bar/role", openLevel: 1, onClick: () => RoleInformationDialog.open(), name: "personal_information_dialog", shortcutKey: "C" },
  { label: "背包", icon: "bottom-nav-bar/bag", openLevel: 1, onClick: () => RoleBagDialog.open(), name: "bag_dialog", shortcutKey: "B" },
  { label: "好友", icon: "bottom-nav-bar/friend", openLevel: 10, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "F" },
  { label: "组队", icon: "bottom-nav-bar/group", openLevel: 10, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "G" },
  { label: "任务", icon: "bottom-nav-bar/task", openLevel: 1, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "Q" },
  { label: "技能", icon: "bottom-nav-bar/skill", openLevel: 1, onClick: SkillDialog.createDialog, name: "personal_information_dialog", shortcutKey: "K" },
  { label: "坐骑", icon: "bottom-nav-bar/horse", openLevel: 1, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "T" },
  { label: "商城", icon: "bottom-nav-bar/mall", openLevel: 1, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "M" },
  { label: "设置", icon: "bottom-nav-bar/config", openLevel: 1, onClick: () => {}, name: "personal_information_dialog", shortcutKey: "/" },
];

interface BottomBarFrame {
  selectedRole: Role | null;
  // 底部导航节点
  node: Node;
  // 初始化
  init: (role: Role) => void;
  /** 左侧快捷键列表 */
  leftShortcutKeys: [];
  /** 初始化左侧快捷键 */
  initLeftShortcutKeys: () => void;
  // 经验条
  expBar: Node;
  // 角色血量文字显示
  hpText: Node;
  // 角色血量徒刑显示
  hpBar: Node;
  // 初始化血量
  initHp: (role: Role) => void;
  // 更新
  update: (role: Role) => void;
}

const BottomBarFrame: BottomBarFrame = {
  selectedRole: null,
  node: null,
  init(role) {
    // 初始化角色数据
    this.selectedRole = StorageManager.findOnlineRole();
    // 基础UI
    // 底部导航区域
    BottomBarFrame.node = UiHelper.createSprite("bottom_nav_bar_background", "bottom-nav-bar/bg", new Vec2(0, -324), new Size(1100, 210));
    // 功能按键区域
    const bottomNavBar = GameUiHelper.createBottomNavBar(6, new Vec2(153.5, -10), new Size(400, 40));
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
    BottomBarFrame.expBar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp), new Vec2(0, -44.5), new Size(724, 8));

    // 统一添加进底层区域
    BottomBarFrame.node.addChild(bottomNavBar);
    BottomBarFrame.node.addChild(BottomBarFrame.expBar);
    // 初始化血量
    BottomBarFrame.initHp(role);
    /** 添加快捷键 */
    BottomBarFrame.initLeftShortcutKeys();
    LayerManager.addToUILayer(BottomBarFrame.node);
  },
  /** 左侧快捷键列表 */
  leftShortcutKeys: [],
  /** 初始化左侧快捷键 */
  initLeftShortcutKeys() {
    /** 绘制每个按钮的UI */
    const leftShortcut = UiHelper.createFlexRow("left_shortcut_keys", 6, new Vec2(), new Size(300, 40));
  },
  // 经验条
  expBar: null,
  // 角色血量文字显示
  hpText: null,
  // 角色血量徒刑显示
  hpBar: null,
  // 初始化血量
  initHp(role) {
    // 血量文字
    BottomBarFrame.hpText = UiHelper.createLabel("hp_text", `${role.hp} / ${role.maxHp}`, Color.WHITE, 12, new Vec2(-421, -39), new Size(120, 10));
    BottomBarFrame.node.addChild(BottomBarFrame.hpText);
    // 圆形血量显示
    const hpBarSprite = UiHelper.createSprite("ho_bar_sprite", "common/max", new Vec2(-420, 12.5), new Size(90, 90));
    BottomBarFrame.hpBar = UiHelper.createProgressBar("hp_bar", role.hp / role.maxHp, "", new Vec2(), new Size(90, 90));
    const hpProgress = UiHelper.createSprite(`hp_bar_progress`, "common/hp", new Vec2(), new Size(90, 90));
    hpProgress.getComponent(Sprite).type = Sprite.Type.TILED;
    BottomBarFrame.hpBar.addChild(hpProgress);
    hpProgress.setPosition(0, 0);
    hpProgress.getComponent(UITransform).setAnchorPoint(0.5, 0);
    BottomBarFrame.hpBar.getComponent(ProgressBar).barSprite = hpProgress.getComponent(Sprite);
    BottomBarFrame.hpBar.getComponent(ProgressBar).mode = ProgressBar.Mode.VERTICAL;
    hpBarSprite.addChild(BottomBarFrame.hpBar);
    BottomBarFrame.node.addChild(hpBarSprite);
  },
  // 更新
  update(role) {
    // 更新血量
    BottomBarFrame.hpText.getComponent(Label).string = `${role.hp} / ${role.maxHp}`;
    // 更新圆形血条
    BottomBarFrame.hpBar.getComponent(ProgressBar).progress = role.hp / role.maxHp;
    // 更新经验条
    BottomBarFrame.expBar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(role.level, role.exp);
  },
};

export default BottomBarFrame;
