import { Node } from "cc";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";
import { ShortcutKeys } from "../../../types/role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";
import { bottomNavImage } from "../../../configs/hudLayout";
import RoleUIManager from "../../core/RoleUIManager";
import RoleInfoDialog from "../dialogs/RoleInfoDialog";
import BagDialog from "../dialogs/BagDialog";
import SkillListDialog from "../dialogs/SkillListDialog";
import BottomNavBar from "./BottomNavBar";
import RoleExpBar from "./RoleExpBar";
import RoleHpOrb from "./RoleHpOrb";
import RoleMpOrb from "./RoleMpOrb";
import ShortcutKeyBar from "./ShortcutKeyBar";
import AutoFightButton from "./AutoFightButton";

/**
 * 底部栏组件（底部 HUD 容器）
 * 只负责组装子组件与持有各功能弹窗，本身不产生任何 UI 零件：
 * 背景（GameUiHelper）+ 功能按键区（BottomNavBar）+ 经验条（RoleExpBar）+ 血量显示（RoleHpOrb）+ 魔法值显示（RoleMpOrb）+ 技能快捷键栏（ShortcutKeyBar）
 * 子组件添加顺序即绘制层级顺序（背景在最下、技能栏在最上）
 */
export default class BottomBar extends Node {
  /** 角色信息弹窗 */
  private roleInfoDialog = new RoleInfoDialog();
  /** 背包弹窗 */
  private bagDialog = new BagDialog();
  /** 技能列表弹窗 */
  private skillListDialog = new SkillListDialog();
  /** 功能按键区 */
  private navBar: BottomNavBar;
  /** 经验条 */
  private expBar: RoleExpBar;
  /** 血量显示（血球 + 血量文字） */
  private hpOrb: RoleHpOrb;
  /** 魔法值显示（魔法球 + 魔法值文字，仅在底部栏显示） */
  private mpOrb: RoleMpOrb;
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
    this.hpOrb = new RoleHpOrb(role);
    this.addChild(this.hpOrb);
    this.mpOrb = new RoleMpOrb(role);
    this.addChild(this.mpOrb);
    this.shortcutKeyBar = new ShortcutKeyBar(role);
    this.addChild(this.shortcutKeyBar);
    // 自动挂机开关（图标随挂机状态切换，状态由 AutoBattle 回调同步）
    this.autoFightButton = new AutoFightButton();
    this.addChild(this.autoFightButton);
  }

  /** 底部功能按钮配置（依赖本组件持有的弹窗实例；图标统一走 hudLayout.bottomNavImage 取图） */
  private get bottomNavBarButtons(): BottomNavBarButton[] {
    return [
      { label: "角色", icon: bottomNavImage("role"), openLevel: 1, onClick: () => this.roleInfoDialog.open(), shortcutKey: "C" },
      { label: "背包", icon: bottomNavImage("bag"), openLevel: 1, onClick: () => this.bagDialog.open(), shortcutKey: "B" },
      { label: "好友", icon: bottomNavImage("friend"), openLevel: 10, onClick: () => {}, shortcutKey: "F" },
      { label: "组队", icon: bottomNavImage("group"), openLevel: 10, onClick: () => {}, shortcutKey: "G" },
      { label: "任务", icon: bottomNavImage("task"), openLevel: 1, onClick: () => {}, shortcutKey: "Q" },
      { label: "技能", icon: bottomNavImage("skill"), openLevel: 1, onClick: () => this.skillListDialog.open(), shortcutKey: "K" },
      { label: "坐骑", icon: bottomNavImage("horse"), openLevel: 1, onClick: () => {}, shortcutKey: "T" },
      { label: "商城", icon: bottomNavImage("mall"), openLevel: 1, onClick: () => {}, shortcutKey: "M" },
      { label: "设置", icon: bottomNavImage("config"), openLevel: 1, onClick: () => {}, shortcutKey: "/" },
    ];
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

  /** 数据变更后刷新血量、魔法值与经验显示 */
  update(role: Role) {
    this.hpOrb.update(role);
    this.mpOrb.update(role);
    this.expBar.update(role);
  }
}
