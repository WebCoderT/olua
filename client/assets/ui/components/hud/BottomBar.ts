import { instantiate, Node, Prefab, UITransform } from "cc";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";
import { ShortcutKeys } from "../../../types/role";
import GameUiHelper, { BottomNavBarButton } from "../../helpers/GameUiHelper";
import { bottomBarPrefab } from "../../../configs/hudLayout";
import { bottomNavItems } from "../../../configs/bottomNav";
import RoleUIManager from "../../core/RoleUIManager";
import RoleInfoDialog from "../dialogs/RoleInfoDialog";
import BagDialog from "../dialogs/BagDialog";
import MallDialog from "../dialogs/MallDialog";
import SkillListDialog from "../dialogs/SkillListDialog";
import ChatDialog from "../dialogs/ChatDialog";
import QuestDialog from "../dialogs/QuestDialog";
import QuestDetailDialog from "../dialogs/QuestDetailDialog";
import PartyDialog from "../dialogs/PartyDialog";
import SettingsDialog from "../dialogs/SettingsDialog";
import TitleUpgradeDialog from "../dialogs/TitleUpgradeDialog";
import WarSoulDialog from "../dialogs/WarSoulDialog";
import BottomNavBar from "./BottomNavBar";
import BottomNavButton from "./BottomNavButton";
import GrowthEntries from "./GrowthEntries";
import RoleExpBar from "./RoleExpBar";
import RoleHpOrb from "./RoleHpOrb";
import RoleMpOrb from "./RoleMpOrb";
import ShortcutKeyBar from "./ShortcutKeyBar";
import AutoFightButton from "./AutoFightButton";

/**
 * 「设置」入口的 key（configs/bottomNav.bottomNavItems 里的最后一条）
 *
 * 稿把它单独摆在第二条竖分隔线之后（不在六颗主按钮那一排），所以组装时要把它从
 * BottomNavBar 的列表里摘出来、挂在 prefab 的 SettingsButton 锚点上（#1361）。
 */
const SETTINGS_KEY = "settings";

/**
 * 底部栏组件（底部 HUD 容器）
 * 只负责组装子组件与持有各功能弹窗，本身不产生任何 UI 零件：
 * 功能按键区（BottomNavBar）+ 经验条（RoleExpBar）+ 血量显示（RoleHpOrb）+ 魔法值显示（RoleMpOrb）+ 技能快捷键栏（ShortcutKeyBar）+ 挂机开关（AutoFightButton）
 * 新稿（04-hud）底部栏不画整条底板，各部分自带矢量底板；子组件添加顺序即绘制层级顺序
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
  /** 聊天弹窗（#395：世界 / 帮会 / 私聊；#1361 起 prefab 由 Game 注入） */
  private chatDialog: ChatDialog;
  /** 任务弹窗（#396：进行中 / 可接，接取与交付都在这里） */
  private questDialog = new QuestDialog();
  /** 任务详情弹窗（#1191：描述 / 进度条 / 奖励 / 交付 NPC；入口是任务追踪栏的「详」） */
  private questDetailDialog = new QuestDetailDialog();
  /** 队伍弹窗（#399：成员 / 邀请 / 退出 / 解散；底部「组队」入口与邀请提示都落到它） */
  private partyDialog = new PartyDialog();
  /** 设置弹窗（稿 21-settings：选择角色 / 退出登录） */
  private settingsDialog = new SettingsDialog();
  /** 称号升级弹窗（#1381 成长线入口的临时落点：总览弹窗落地后换） */
  private titleDialog = new TitleUpgradeDialog();
  /** 战魂弹窗（#1381 成长线入口的临时落点：总览弹窗落地后换） */
  private warSoulDialog = new WarSoulDialog();
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
  /** 成长线入口行（称号 / 元神，#1381：prefab 化的两颗胶囊，悬在功能按键排正上方） */
  private growthEntries: GrowthEntries | null = null;

  constructor(role: Role, prefab: Prefab, chatPrefab: Prefab, growthPrefab: Prefab | null = null) {
    super("bottom_bar");
    // 注册弹窗，供数据层刷新：装备穿脱后的槽位/内观（StorageManager 装备变更流程）、背包显示（拾取/使用物品）
    RoleUIManager.registerRoleInfoDialog(this.roleInfoDialog);
    RoleUIManager.registerBagDialog(this.bagDialog);
    // 聊天窗的 prefab 由 Game 一并注入（聊天窗自身也是 prefab 化的，#1361）
    this.chatDialog = new ChatDialog(chatPrefab);
    if (!prefab) {
      console.warn("[bottom-bar] prefab 未注入：请确认 Game 场景的 bottomBarPrefab 字段已绑定");
      return;
    }
    // 实例化 prefab（#1361：底衬/分隔线锚点与七个子组件挂点都在 prefab，编辑器可视化改摆位）
    const instance = instantiate(prefab) as Node;
    this.addComponent(UITransform).setContentSize(instance.getComponent(UITransform)!.contentSize);
    const children = instance.children.slice();
    for (const child of children) child.setParent(this);
    // 根位置以 prefab 为准（#1359 口径）
    this.setPosition(instance.position.x, instance.position.y, 0);
    const paths = bottomBarPrefab.nodes;
    const anchor = (path: string): Node => {
      const found = this.getChildByPath(path);
      if (!found) console.warn(`[bottom-bar] prefab 缺节点: ${path}`);
      return found as Node;
    };
    // 子组件（添加顺序即绘制层级；各组件自身不再定位，摆位由 prefab 锚点承载）
    // 底衬与竖分隔线的视觉在 prefab（#1363：HudBackdrop / VerticalRule 组件，编辑器可见可调）
    this.navBar = new BottomNavBar(this.bottomNavBarButtons.filter((button) => button.key !== SETTINGS_KEY), role);
    anchor(paths.navBar).addChild(this.navBar);
    // 「设置」独立一颗（稿放在第二条竖分隔线之后；逻辑与其它入口一致，未做时给「开发中」提示）
    const settingsButton = this.bottomNavBarButtons.find((button) => button.key === SETTINGS_KEY);
    if (settingsButton) {
      const node = new BottomNavButton(settingsButton, role);
      anchor(paths.settingsButton).addChild(node);
    }
    this.expBar = new RoleExpBar(role);
    anchor(paths.expBar).addChild(this.expBar);
    this.hpOrb = new RoleHpOrb(role);
    anchor(paths.hpOrb).addChild(this.hpOrb);
    this.mpOrb = new RoleMpOrb(role);
    anchor(paths.mpOrb).addChild(this.mpOrb);
    this.shortcutKeyBar = new ShortcutKeyBar(role);
    anchor(paths.shortcutBar).addChild(this.shortcutKeyBar);
    // 自动挂机开关（图标随挂机状态切换，状态由 AutoBattle 回调同步）
    this.autoFightButton = new AutoFightButton();
    anchor(paths.autoFight).addChild(this.autoFightButton);
    // 成长线入口（#1381）：称号 → 称号升级弹窗 / 元神 → 战魂弹窗（总览弹窗落地后换过去）
    const growthAnchor = anchor(paths.growthEntries);
    if (growthAnchor) {
      this.growthEntries = new GrowthEntries(growthPrefab, {
        title: () => this.titleDialog.open(),
        soul: () => this.warSoulDialog.open(),
      });
      growthAnchor.addChild(this.growthEntries);
    }
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
      settings: () => this.settingsDialog.open(),
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

  /** 打开任务详情弹窗（#1191：任务追踪栏标题行的「详」走这里） */
  openQuestDetail() {
    this.questDetailDialog.open();
  }

  /**
   * 开/关聊天小窗（#469：常驻左下角）
   * @param auto true = 只开不关且不推进引导（进游戏自动弹出用）；false = 玩家点入口/Enter 的开关
   */
  openChatBox(auto = false) {
    // BottomBar 是 Node 子类，场景销毁后 Cocos _destruct 会把构造器赋值的字段置 null；
    // 销毁期残余回调（#1188）走到这里时 chatDialog 可能已是 null，直接 no-op 不崩
    if (!this.chatDialog) return;
    this.chatDialog.open(auto);
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
