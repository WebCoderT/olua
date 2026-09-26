import { sys } from "cc";
import BottomBarFrame from "../components/BottomBarFrame";
import RoleAvatarFrame from "../components/RoleAvatarFrame";
import { levelMap } from "../../configs/level";
import { Role } from "../../configs/role";
import { Equipment } from "../../types/common";
import GameHelper from "../utils/GameHelper";
import RoleInformationDialog from "../components/RoleInformationDialog";
import EffectFrame from "../components/EffectFrame";

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
      console.log(roles);
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
  onlineRole: (id: string) => {
    sys.localStorage.setItem("selectedRole", id);
  },
  // 获取选择的角色
  findOnlineRole: () => {
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
    const role = StorageHelper.findOnlineRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级
      role.level += 1;
      // 播放升级动画
      EffectFrame.selfUpgrade();
      // 保存
      StorageHelper.updateOnlineRole(role);
      // 更新属性
      StorageHelper.AttributeCalc(role);
    } else StorageHelper.updateOnlineRole(role);
    // 更新经验条
    BottomBarFrame.updateExpBar();
  },
  // 更换装备
  changeEquipment(equipment: Equipment) {
    if (GameHelper.checkRoleCanUseEquipment(equipment)) {
      const role = StorageHelper.findOnlineRole();
      role.equipments[equipment.type] = equipment;
      StorageHelper.updateOnlineRole(role);
      RoleInformationDialog.updateDialog(equipment.type);
      StorageHelper.AttributeCalc(role);
    }
  },
  // 属性计算
  AttributeCalc(role: Role) {
    role.maxHp = StorageHelper.maxHpCalc(role);
    role.combat = StorageHelper.combatCalc(role);
    StorageHelper.updateOnlineRole(role);
    RoleAvatarFrame.update(role);
  },
  // 计算血量
  maxHpCalc(role: Role) {
    let maxHp = 0;
    maxHp += levelMap.get(role.level).maxHp;
    role.equipments.cloth && (maxHp += role.equipments.cloth.maxHp);
    return maxHp;
  },
  // 战斗力计算
  combatCalc(role: Role) {
    let combat = 0;
    combat += role.maxHp * 10;
    return combat;
  },
  // 判断
};

export default StorageHelper;
