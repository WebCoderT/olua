import { EQUIPMENT_TYPE } from "../../types/good";
import { Role } from "../../entities/Role";
import type { SkillId } from "../../types/skill";

interface RoleAvatarView {
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

/**
 * 角色UI管理器
 * 统一注册与刷新角色相关视图（头像栏、底部栏、主角外观、角色信息弹窗），
 * 避免数据层与视图层直接互相引用
 */
export default class RoleUIManager {
  private static roleAvatar: RoleAvatarView | null = null;
  private static bottomBar: BottomBarView | null = null;
  private static roleDisplay: RoleDisplayView | null = null;
  private static roleInfoDialog: RoleInfoDialogView | null = null;

  /** 注册角色头像视图 */
  static registerRoleAvatar(view: RoleAvatarView) {
    this.roleAvatar = view;
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
  static registerRoleInformationDialog(view: RoleInfoDialogView) {
    this.roleInfoDialog = view;
  }

  /** 角色数据变更后统一刷新视图 */
  static updateRoleData(role: Role) {
    this.roleAvatar?.updateRole(role);
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

