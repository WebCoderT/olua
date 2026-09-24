import { math, sys, utils } from "cc";
import { Role } from "../configs";

/**
 * 存储
 */
export interface StorageHelper {
  // 清空存储
  clear: () => void;
  // 获取角色列表
  getRoles: () => Role[];
  // 更新角色列表
  setRoles: (roles: Role[]) => void;
  // 创建新角色
  createRole: (name: string, occupation: Role["occupation"], sex: Role["sex"]) => void;
  // 根据id获取角色
  findRoleById: (id: string) => Role;
  // 选择角色
  selectRole: (id: string) => void;
  // 获取选择的角色
  findSelectedRole: () => Role;
}

const StorageHelper: StorageHelper = {
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
};

export default StorageHelper;
