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
import ChatDialog from "../dialogs/ChatDialog";
import QuestDialog from "../dialogs/QuestDialog";
import PartyDialog from "../dialogs/PartyDialog";
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
  /** 商城弹窗 */
  private mallDialog = new MallDialog();
  /** 技能列表弹窗 */
  private skillListDialog = new SkillListDialog();
  /** 聊天弹窗（#395：世界 / 帮会 / 私聊） */
  private chatDialog = new ChatDialog();
  /** 任务弹窗（#396：进行中 / 可接，接取与交付都在这里） */
  private questDialog = new QuestDialog();
  /** 队伍弹窗（#399：成员 / 邀请 / 退出 / 解散；底部「组队」入口与邀请提示都落到它） */
  private partyDialog = new PartyDialog();
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

  /**
   * 底部功能入口（数据见 configs/bottomNav.bottomNavItems）
   * 这里只补「点击做什么」——回调是代码不是配置，按入口 key 关联
   *
   * 还没做的入口（`comingSoon`）与漏接回调的入口都给一句「正在开发中」的飘字：
   * 静默无反应最糟，玩家会以为 UI 坏了（#485）。等级不够置灰的走 BottomNavButton 自己的
   * `feature_locked_tip`，两种说法不能混。
   */
  private get bottomNavBarButtons(): BottomNavBarButton[] {
    const handlers: Record<string, () => void> = {
      role: () => this.roleInfoDialog.open(),
      bag: () => this.bagDialog.open(),
      group: () => this.partyDialog.open(),
      mall: () => this.mallDialog.open(),
      skill: () => this.skillListDialog.open(),
    };
    return bottomNavItems.map((item) => {
      const comingSoon = () => GameUiHelper.createTip("feature_coming_soon", { feature: item.label });
      return { ...item, onClick: item.comingSoon ? comingSoon : (handlers[item.key] ?? comingSoon) };
    });
  }

  /** 每帧刷新快捷键冷却显示（由组合根驱动） */
  updateCooldowns() {
    this.shortcutKeyBar.updateCooldowns();
  }

  /** 打开任务面板（任务追踪栏点一下就走这里，见 Game 里的 QuestTracker 接线） */
  openQuests() {
    this.questDialog.open();
  }

  /**
   * 开/关聊天小窗（#469：常驻左下角）
   * @param auto true = 只开不关且不推进引导（进游戏自动弹出用）；false = 玩家点入口/Enter 的开关
   */
  openChatBox(auto = false) {
    this.chatDialog.open(auto);
  }

  /** 开聊天小窗时重贴左下角（关着时是 no-op，见 ChatDialog.refreshDock） */
  refreshChatBoxDock() {
    this.chatDialog.refreshDock();
  }

  /** 打开队伍面板（收到组队邀请时 Game 也会走这里，让玩家直接看到「同意 / 拒绝」） */
  openParty() {
    this.partyDialog.open();
  }

  /** 队伍面板是否开着（邀请提示据此决定是顶到面板上还是只飘一句） */
  isPartyOpen(): boolean {
    return this.partyDialog.isOpen();
  }

  /** 按入口 key 取底部按钮（引导高亮用；`bag` / `skill` / `chat` 这几个 key 见 configs/bottomNav） */
  navNode(key: string): Node | null {
    return this.navBar.nodeOf(key);
  }

  /** 技能快捷键栏节点（引导「打怪」那一步指这里 —— 怪会跑，画个洞没意义） */
  shortcutNode(): Node | null {
    return this.shortcutKeyBar;
  }

  /** 贴边定位（贴屏幕底部居中；坐标是常量，创建时调一次） */
  applyFixedPosition() {
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
