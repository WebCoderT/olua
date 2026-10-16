import { Node } from "cc";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";
import { ShortcutKeys } from "../../../types/role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";
import { bottomNavItems } from "../../../configs/bottomNav";
import RoleUIManager from "../../core/RoleUIManager";
import RoleInfoDialog from "../dialogs/RoleInfoDialog";
import BagDialog from "../dialogs/BagDialog";
import MallDialog from "../dialogs/MallDialog";
import SkillListDialog from "../dialogs/SkillListDialog";
import BottomNavBar from "./BottomNavBar";
import RoleExpBar from "./RoleExpBar";
import ShortcutKeyBar from "./ShortcutKeyBar";
import AutoFightButton from "./AutoFightButton";

/**
 * 底部栏组件（底部 HUD 容器）
 * 只负责组装子组件与持有各功能弹窗，本身不产生任何 UI 零件：
 * 背景（GameUiHelper）+ 功能按键区（BottomNavBar）+ 经验条（RoleExpBar）+ 技能快捷键栏（ShortcutKeyBar）
 * 子组件添加顺序即绘制层级顺序（背景在最下、技能栏在最上）
 *
 * 竖屏（750×1624）改造时移除了血量/魔法值显示（RoleHpOrb/RoleMpOrb，含血量与魔法文字）：
 * 它们挂在底部栏两端，竖屏下整体跑出屏幕（可见 0~14px），见 configs/layout/hud.ts 的说明
 */
export default class BottomBar extends Node {
  /** 角色信息弹窗 */
  private roleInfoDialog = new RoleInfoDialog();
  /** 背包弹窗 */
  private bagDialog = new BagDialog();
  /** 商城弹窗 */
  private mallDialog = new MallDialog();
  /** 技能列表弹窗 */
  private skillListDialog = new SkillListDialog();
  /** 功能按键区 */
  private navBar: BottomNavBar;
  /** 经验条 */
  private expBar: RoleExpBar;
  /** 技能快捷键栏 */
  private shortcutKeyBar: ShortcutKeyBar;
  /** 自动挂机开关按钮 */
  private autoFightButton: AutoFightButton;

  constructor(role: Role) {
    super("bottom_bar");
    // 注册弹窗，供数据层刷新：装备穿脱后的槽位/内观（StorageManager 装备变更流程）、背包显示（拾取/使用物品）
    RoleUIManager.registerRoleInfoDialog(this.roleInfoDialog);
    RoleUIManager.registerBagDialog(this.bagDialog);
    // 底部栏主体（尺寸/位置/背景）
    GameUiHelper.applyBottomBarBodyStyle(this);
    // 子组件
    this.navBar = new BottomNavBar(this.bottomNavBarButtons, role);
    this.addChild(this.navBar);
    this.expBar = new RoleExpBar(role);
    this.addChild(this.expBar);
    this.shortcutKeyBar = new ShortcutKeyBar(role);
    this.addChild(this.shortcutKeyBar);
    // 自动挂机开关（图标随挂机状态切换，状态由 AutoBattle 回调同步）
    this.autoFightButton = new AutoFightButton();
    this.addChild(this.autoFightButton);
  }

  /**
   * 底部功能入口（数据见 configs/bottomNav.bottomNavItems）
   * 这里只补「点击做什么」——回调是代码不是配置，按入口 key 关联；未实现的功能留空回调
   */
  private get bottomNavBarButtons(): BottomNavBarButton[] {
    const handlers: Record<string, () => void> = {
      role: () => this.roleInfoDialog.open(),
      bag: () => this.bagDialog.open(),
      mall: () => this.mallDialog.open(),
      skill: () => this.skillListDialog.open(),
    };
    return bottomNavItems.map((item) => ({ ...item, onClick: handlers[item.key] ?? (() => {}) }));
  }

  /** 每帧刷新快捷键冷却显示（由组合根驱动） */
  updateCooldowns() {
    this.shortcutKeyBar.updateCooldowns();
  }

  /** 贴边定位（贴屏幕底部居中按可见尺寸重算）——窗口尺寸变化时由组合根调用 */
  applyAnchorPosition() {
    GameUiHelper.setBottomBarPosition(this);
  }

  /** 更新指定快捷键槽的图标与绑定技能 */
  updateShortcutIcon(key: ShortcutKeys, icon?: string, onClick?: Function, skillId?: SkillId) {
    this.shortcutKeyBar.updateSlotIcon(key, icon, onClick, skillId);
  }

  /** 数据变更后刷新经验显示（血量/魔法值显示已随竖屏改造移除，见类注释） */
  update(role: Role) {
    this.expBar.update(role);
  }
}
