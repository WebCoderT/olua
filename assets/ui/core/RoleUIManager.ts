import { EQUIPMENT_TYPE } from "../../types/good";
import { Role } from "../../entities/Role";
import type { Node } from "cc";
import type { SkillId } from "../../types/skill";
import type { StatusBadge } from "../../types/status";

interface RoleInfoBarView {
  updateRole: (role: Role) => void;
}

interface BottomBarView {
  update: (role: Role) => void;
  updateShortcutIcon: (key: number, icon?: string, onClick?: Function, skillId?: SkillId) => void;
}

/** 角色外观视图（主角换装刷新） */
interface RoleDisplayView {
  updateOutShow: (role: Role) => void;
}

/** 角色信息弹窗视图（装备变更后刷新内观） */
interface RoleInfoDialogView {
  updateDialog: (equipmentType: EQUIPMENT_TYPE) => void;
}

/** 背包弹窗视图（物品变更后刷新背包显示） */
interface BagDialogView {
  refresh: () => void;
}

/** 状态图标条视图（状态增删后重建图标） */
interface StatusIconBarView {
  updateStatuses: (badges: StatusBadge[]) => void;
}

/** 怪物信息面板视图（选中怪物时展示血量/名称/头像/技能） */
interface MonsterInfoView {
  /** 面板节点是否仍存活 */
  isValidNode: () => boolean;
  /** 切换展示的怪物 */
  select: (target: Node) => void;
  /** 每帧刷新，返回 false 表示选中目标已失效（面板将被销毁） */
  update: () => boolean;
  /** 销毁面板节点 */
  destroy: () => void;
}

/** 怪物信息面板创建器（由组合根注入，面板按需动态创建） */
type MonsterInfoFactory = (target: Node) => MonsterInfoView;

/**
 * 角色UI管理器
 * 统一注册与刷新角色相关视图（信息栏、底部栏、主角外观、角色信息弹窗），
 * 并管理怪物信息面板的动态创建与销毁，避免数据层与视图层直接互相引用
 */
export default class RoleUIManager {
  private static roleInfoBar: RoleInfoBarView | null = null;
  private static bottomBar: BottomBarView | null = null;
  private static roleDisplay: RoleDisplayView | null = null;
  private static roleInfoDialog: RoleInfoDialogView | null = null;
  private static bagDialog: BagDialogView | null = null;
  /** 状态图标条视图 */
  private static statusIconBar: StatusIconBarView | null = null;
  /** 当前存活的怪物信息面板（未选中怪物时为 null） */
  private static monsterInfo: MonsterInfoView | null = null;
  private static monsterInfoFactory: MonsterInfoFactory | null = null;

  /** 注册角色信息栏视图 */
  static registerRoleInfoBar(view: RoleInfoBarView) {
    this.roleInfoBar = view;
  }

  /** 注册底部栏视图 */
  static registerBottomBar(view: BottomBarView) {
    this.bottomBar = view;
  }

  /** 注册主角视图（外观刷新） */
  static registerRoleDisplay(view: RoleDisplayView) {
    this.roleDisplay = view;
  }

  /** 注册角色信息弹窗视图（由持有弹窗实例的 BottomBar 注册） */
  static registerRoleInfoDialog(view: RoleInfoDialogView) {
    this.roleInfoDialog = view;
  }

  /** 注册背包弹窗视图（由持有弹窗实例的 BottomBar 注册） */
  static registerBagDialog(view: BagDialogView) {
    this.bagDialog = view;
  }

  /** 注册状态图标条视图（由 RoleInfoBar 注册，状态增删后重建图标） */
  static registerStatusIconBar(view: StatusIconBarView) {
    this.statusIconBar = view;
  }

  /** 状态增删后刷新状态图标条（由 StatusManager 调用，徽标列表为其数据来源） */
  static updateStatuses(badges: StatusBadge[]) {
    this.statusIconBar?.updateStatuses(badges);
  }

  /** 物品变更后刷新背包显示（弹窗未打开时忽略） */
  static refreshBag() {
    this.bagDialog?.refresh();
  }

  /** 设置怪物信息面板创建器（由组合根注入，选中怪物时才真正创建面板） */
  static setMonsterInfoFactory(factory: MonsterInfoFactory) {
    this.monsterInfoFactory = factory;
  }

  /** 选中怪物（null 表示取消选中）：动态创建/销毁怪物信息面板 */
  static selectMonster(target: Node | null) {
    // 取消选中：销毁面板
    if (!target) {
      this.destroyMonsterInfo();
      return;
    }
    // 已有面板则复用，否则按需创建
    if (!this.monsterInfo) {
      this.monsterInfo = this.monsterInfoFactory ? this.monsterInfoFactory(target) : null;
      return;
    }
    this.monsterInfo.select(target);
  }

  /** 每帧刷新怪物信息面板（目标已死亡/移除则销毁面板） */
  static updateMonsterInfo() {
    const view = this.monsterInfo;
    if (!view) return;
    if (!view.isValidNode() || !view.update()) this.destroyMonsterInfo();
  }

  /** 销毁怪物信息面板并释放引用（取消选中、目标失效、场景卸载时调用） */
  static destroyMonsterInfo() {
    const view = this.monsterInfo;
    this.monsterInfo = null;
    if (view && view.isValidNode()) view.destroy();
  }

  /** 清空全部视图引用（场景卸载时由组合根调用，避免跨场景残留已销毁节点） */
  static clearViews() {
    this.destroyMonsterInfo();
    this.roleInfoBar = null;
    this.bottomBar = null;
    this.roleDisplay = null;
    this.roleInfoDialog = null;
    this.bagDialog = null;
    this.statusIconBar = null;
  }

  /** 角色数据变更后统一刷新视图 */
  static updateRoleData(role: Role) {
    this.roleInfoBar?.updateRole(role);
    this.bottomBar?.update(role);
  }

  /** 更新快捷键图标 */
  static updateShortcutIcon(key: number, icon?: string, onClick?: Function, skillId?: SkillId) {
    this.bottomBar?.updateShortcutIcon(key, icon, onClick, skillId);
  }

  /** 装备变更后刷新主角外观 */
  static updateRoleOutShow(role: Role) {
    this.roleDisplay?.updateOutShow(role);
  }

  /** 装备变更后刷新角色信息弹窗内观 */
  static updateEquipmentDialog(equipmentType: EQUIPMENT_TYPE) {
    this.roleInfoDialog?.updateDialog(equipmentType);
  }
}
