import RoleUIManager from "../RoleUIManager";
import { Role } from "../../../entities/Role";

/**
 * 角色 UI 刷新桥（#1115 批次 6）：storage 各子模块统一走它刷「信息栏 / 底栏 / 血条」，
 * 不再各自回头 import StorageManager（facade）—— 子模块只依赖视图，不依赖门面。
 */
export function updateRoleUi(role: Role) {
  RoleUIManager.updateRoleData(role);
}


