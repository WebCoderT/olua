import { sys } from "cc";
import BottomBarFrame from "../components/BottomBarFrame";
import RoleAvatarFrame from "../components/RoleAvatarFrame";
import { levelMap } from "../../configs/level";
import { Role } from "../../configs/role";
import { Equipment, MapId } from "../../types/common";
import GameHelper from "../utils/GameHelper";
import RoleInformationDialog from "../components/RoleInformationDialog";
import EffectFrame from "../components/EffectFrame";
import RoleDisplayFrame from "../components/RoleDisplayFrame";

/**
 * 存储
 */
const StorageManager = {
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
    const roles = StorageManager.getRoles();
    if (roles.length < 3) {
      roles.push(new Role(name, occupation, sex));
      StorageManager.setRoles(roles);
    } else console.error("角色超出3个");
  },
  // 根据id获取角色
  findRoleById: (id: string) => {
    return StorageManager.getRoles().find((i) => i.id === id);
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
    return StorageManager.getRoles().find((i) => i.id === selectedRole);
  },
  // 更新在线角色
  updateOnlineRole: (role: Role) => {
    const roles = StorageManager.getRoles().map((i) => {
      if (i.id === role.id) {
        Object.assign(i, role);
      }
      return i;
    });
    StorageManager.setRoles(roles);
  },
  // 角色获得经验(当前在线角色)
  onlineRoleGetExp: (exp: number) => {
    const role = StorageManager.findOnlineRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级
      if (role.level >= 30) role.level = 30;
      else role.level += 1;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 升级时补满血量至最大血量
      role.hp = role.maxHp;
      // 播放升级动画
      EffectFrame.selfUpgrade();
    }
    // 保存
    StorageManager.updateOnlineRole(role);
    // 更新UI
    StorageManager.updateUi(role);
  },
  // 更换装备
  changeEquipment(equipment: Equipment) {
    if (GameHelper.checkRoleCanUseEquipment(equipment)) {
      const role = StorageManager.findOnlineRole();
      // 换装备
      role.equipments[equipment.type] = equipment;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 保存
      StorageManager.updateOnlineRole(role);
      // 更新UI
      StorageManager.updateUi(role, equipment);
    }
  },
  // 跳转地图
  changeOnMap(mapId: MapId) {
    // 获取最新信息
    const role = StorageManager.findOnlineRole();
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    StorageManager.updateOnlineRole(role);
  },
  // 更新UI
  updateUi(role: Role, equipment?: Equipment) {
    // 更改外观
    RoleDisplayFrame.updateOutShow(role);
    // 更新战斗力
    RoleAvatarFrame.update(role);
    // 更新内观
    equipment && RoleInformationDialog.updateDialog(equipment.type);
    // 更新底部导航
    BottomBarFrame.update(role);
  },
};

export default StorageManager;
