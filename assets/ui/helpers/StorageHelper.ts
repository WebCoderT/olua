import { sys } from "cc";
import { levelMap, Role } from "../../configs";
import BottomBarFrame from "../components/BottomBarFrame";
import RoleAvatarFrame from "../components/RoleAvatarFrame";

/**
 * 存储
 */
const StorageHelper = {
  // 获取角色列表
  getRoles: (): Role[] => {
    const roles = sys.localStorage.getItem("roles");
    if (roles) return JSON.parse(roles);
    else return [];
  },
  // 更新角色列表
  setRoles: (roles: Role[]) => {
    sys.localStorage.setItem("roles", JSON.stringify(roles));
  },
  // 创建新角色
  createRole: (name: string, occupation: Role["occupation"], sex: Role["sex"]): void => {
    const roles = StorageHelper.getRoles();
    if (roles.length < 3) {
      roles.push(new Role(name, occupation, sex));
      StorageHelper.setRoles(roles);
    } else console.error("角色超出3个");
  },
  // 根据id获取角色
  findRoleById: (id: string) => {
    return StorageHelper.getRoles().find((i) => i.id === id);
  },
  // 清空本地所有存储
  clear() {
    sys.localStorage.clear();
  },
  // 选择角色
  selectRole: (id: string) => {
    sys.localStorage.setItem("selectedRole", id);
  },
  // 获取选择的角色
  findSelectedRole: () => {
    const selectedRole = sys.localStorage.getItem("selectedRole");
    return StorageHelper.getRoles().find((i) => i.id === selectedRole);
  },
  // 更新在线角色
  updateOnlineRole: (role: Role) => {
    const roles = StorageHelper.getRoles().map((i) => {
      if (i.id === role.id) {
        Object.assign(i, role);
      }
      return i;
    });
    StorageHelper.setRoles(roles);
  },
  // 角色获得经验(当前在线角色)
  onlineRoleGetExp: (exp: number) => {
    const role = StorageHelper.findSelectedRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级
      role.level += 1;
      StorageHelper.updateOnlineRole(role);
      // 更新等级
      RoleAvatarFrame.updateLevel();
    } else StorageHelper.updateOnlineRole(role);
    // 更新经验条
    BottomBarFrame.updateExpBar();
  },
};

export default StorageHelper;
