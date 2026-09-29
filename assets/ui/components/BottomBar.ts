import { Color, Label, Node, ProgressBar, Size, Sprite, UITransform, Vec2 } from "cc";
import GameUiHelper, { BottomNavBarButton } from "../helpers/GameUiHelper";
import UiHelper from "../helpers/UiHelper";
import RoleInformationDialog from "./dialogs/RoleInformationDialog";
import RoleBagDialog from "./dialogs/RoleBagDialog";
import { getCurrentLevelExpRate } from "../../configs/level";
import { Role } from "../../configs/role";
import SkillDialog from "./dialogs/SkillDialog";
import { ShortcutKeys } from "../../types/common";
import { skills } from "../../configs/skill";
import ShortcutKey from "./ShortcutKey";
import RoleUIManager from "../core/RoleUIManager";

/**
 * 底部栏组件
 * 包含基础UI、功能按键区、经验条、血量显示与左侧快捷键
 * 弹窗实例由本组件持有（哪里使用哪里实例化）
 */
export default class BottomBar extends Node {
  private selectedRole: Role;
  /** 角色信息弹窗 */
  private roleInfoDialog = new RoleInformationDialog();
  /** 背包弹窗 */
  private roleBagDialog = new RoleBagDialog();
  /** 技能弹窗 */
  private skillDialog = new SkillDialog();
  /** 左侧快捷键（技能栏） */
  leftShortcutKeys: { [key in ShortcutKeys]: ShortcutKey | null } = {
    49: null,
    50: null,
    51: null,
    52: null,
  };
  /** 经验条节点 */
  private expBar: Node;
  /** 血量文字节点 */
  private hpText: Node;
  /** 血量进度条节点 */
  private hpBar: Node;

  constructor(role: Role) {
    super("bottom_bar");
    this.selectedRole = role;
    // 注册角色信息弹窗，供数据层（StorageManager）刷新装备内观
    RoleUIManager.registerRoleInformationDialog(this.roleInfoDialog);
    this.createUI(role);
  }

  /** 底部导航栏功能按钮配置（依赖本组件持有的弹窗实例） */
  private get bottomNavBarButtons(): BottomNavBarButton[] {
    return [
      { label: "角色", icon: "bottom-nav-bar/role", openLevel: 1, onClick: () => this.roleInfoDialog.open(), name: "personal_information_dialog", shortcutKey: "C" },
      { label: "背包", icon: "bottom-nav-bar/bag", openLevel: 1, onClick: () => this.roleBagDialog.open(), name: "bag_dialog", shortcutKey: "B" },
      { label: "好友", icon: "bottom-nav-bar/friend", openLevel: 10, onClick: () => {}, name: "friend_dialog", shortcutKey: "F" },
      { label: "组队", icon: "bottom-nav-bar/group", openLevel: 10, onClick: () => {}, name: "group_dialog", shortcutKey: "G" },
      { label: "任务", icon: "bottom-nav-bar/task", openLevel: 1, onClick: () => {}, name: "task_dialog", shortcutKey: "Q" },
      { label: "技能", icon: "bottom-nav-bar/skill", openLevel: 1, onClick: () => this.skillDialog.open(), name: "skill_dialog", shortcutKey: "K" },
      { label: "坐骑", icon: "bottom-nav-bar/horse", openLevel: 1, onClick: () => {}, name: "horse_dialog", shortcutKey: "T" },
      { label: "商城", icon: "bottom-nav-bar/mall", openLevel: 1, onClick: () => {}, name: "mall_dialog", shortcutKey: "M" },
      { label: "设置", icon: "bottom-nav-bar/config", openLevel: 1, onClick: () => {}, name: "config_dialog", shortcutKey: "/" },
    ];
  }

  private createUI(role: Role) {
    const transform = this.addComponent(UITransform);
    transform.setContentSize(1100, 210);
    this.setPosition(0, -324);

    // 基础UI
    // 底部导航区域
    const background = UiHelper.createSprite("bottom_nav_bar_background", "bottom-nav-bar/bg", new Vec2(), new Size(1100, 210));
    this.addChild(background);
    // 功能按键区域
    const bottomNavBar = GameUiHelper.createBottomNavBar(6, new Vec2(153.5, -10), new Size(400, 40));
    this.bottomNavBarButtons.forEach((button) => {
      const node = GameUiHelper.createBottomNavBarButton(button, this.selectedRole);
      // 如果按钮未解锁，点击时用置灰提示
      node.on(
        Node.EventType.TOUCH_END,
        () => {
          if (node.getComponent(Sprite).grayscale) GameUiHelper.createErrorTip("feature_locked_tip", `${button.label}功能需要在${button.openLevel}级后开放`);
          else button.onClick();
        },
        this,
      );
      bottomNavBar.addChild(node);
    });
    // 经验条
    this.expBar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(this.selectedRole.level, this.selectedRole.exp), new Vec2(0, -44.5), new Size(724, 8));

    // 统一添加进底部区域
    this.addChild(bottomNavBar);
    this.addChild(this.expBar);
    // 初始化血量
    this.initHp(role);
    /** 初始化左侧快捷键 */
    this.addChild(this.initLeftShortcutKeys(role));
  }

  /** 初始化左侧快捷键 */
  private initLeftShortcutKeys(role: Role) {
    /** 绘制按钮组 */
    const leftShortcut = UiHelper.createFlexRow("left_shortcut_keys", 6, new Vec2(-270, -9), new Size(178, 40));
    /** 绘制按钮 */
    role.shortcutKeys.forEach((shortkey) => {
      const skill = skills.get(shortkey.skillId);
      const shortcutKey = new ShortcutKey(shortkey.label, shortkey.key, skill?.icon, skill?.onClick);
      this.leftShortcutKeys[shortkey.key] = shortcutKey;
      leftShortcut.addChild(shortcutKey);
    });
    return leftShortcut;
  }

  /** 初始化血量 */
  private initHp(role: Role) {
    // 血量文字
    this.hpText = UiHelper.createLabel("hp_text", `${role.hp} / ${role.maxHp}`, Color.WHITE, 12, new Vec2(-421, -39), new Size(120, 10));
    this.addChild(this.hpText);
    // 圆形血量显示
    const hpBarSprite = UiHelper.createSprite("hp_bar_sprite", "common/max", new Vec2(-420, 12.5), new Size(90, 90));
    this.hpBar = UiHelper.createProgressBar("hp_bar", role.hp / role.maxHp, "", new Vec2(), new Size(90, 90));
    const hpProgress = UiHelper.createSprite(`hp_bar_progress`, "common/hp", new Vec2(), new Size(90, 90));
    hpProgress.getComponent(Sprite).type = Sprite.Type.TILED;
    this.hpBar.addChild(hpProgress);
    hpProgress.setPosition(0, 0);
    hpProgress.getComponent(UITransform).setAnchorPoint(0.5, 0);
    this.hpBar.getComponent(ProgressBar).barSprite = hpProgress.getComponent(Sprite);
    this.hpBar.getComponent(ProgressBar).mode = ProgressBar.Mode.VERTICAL;
    hpBarSprite.addChild(this.hpBar);
    this.addChild(hpBarSprite);
  }

  /** 更新快捷键图标 */
  updateShortcutIcon(key: ShortcutKeys, icon?: string, onClick?: Function) {
    this.leftShortcutKeys[key]?.updateIcon(icon, onClick);
  }

  /** 数据变更后刷新显示 */
  update(role: Role) {
    // 更新血量
    this.hpText.getComponent(Label).string = `${role.hp} / ${role.maxHp}`;
    // 更新圆形血条
    this.hpBar.getComponent(ProgressBar).progress = role.hp / role.maxHp;
    // 更新经验条
    this.expBar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(role.level, role.exp);
  }
}
