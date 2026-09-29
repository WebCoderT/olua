import { sys } from "cc";
import RoleUIManager from "./RoleUIManager";
import SceneManager from "./SceneManager";
import { levelMap } from "../../configs/level";
import { Role } from "../../entities/Role";
import { Equipment } from "../../types/good";
import { MapId } from "../../types/map";
import { SkillId } from "../../types/skill";
import GameHelper from "./GameHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import { skills } from "../../configs/skill";

/**
 * 存储管理器
 * 负责本地角色数据的读写，以及数据变更后的属性重算、UI刷新与外观更新
 */
export default class StorageManager {
  /** 获取角色列表 */
  static getRoles(): Role[] {
    const roles = sys.localStorage.getItem("roles");
    if (roles) return JSON.parse(roles);
    return [];
  }

  /** 更新角色列表 */
  static setRoles(roles: Role[]) {
    sys.localStorage.setItem("roles", JSON.stringify(roles));
  }

  /** 创建新角色 */
  static createRole(name: string, occupation: Role["occupation"], sex: Role["sex"]): void {
    const roles = this.getRoles();
    if (roles.length < 3) {
      roles.push(new Role(name, occupation, sex));
      this.setRoles(roles);
    } else {
      console.error("角色超出3个");
    }
  }

  /** 根据id获取角色 */
  static findRoleById(id: string) {
    return this.getRoles().find((i) => i.id === id);
  }

  /** 清空本地所有存储 */
  static clear() {
    sys.localStorage.clear();
  }

  /** 选择角色 */
  static onlineRole(id: string) {
    sys.localStorage.setItem("selectedRole", id);
  }

  /** 获取当前在线角色 */
  static findOnlineRole() {
    const selectedRole = sys.localStorage.getItem("selectedRole");
    return this.getRoles().find((i) => i.id === selectedRole);
  }

  /** 更新在线角色 */
  static updateOnlineRole(role: Role) {
    const roles = this.getRoles().map((i) => {
      if (i.id === role.id) {
        Object.assign(i, role);
      }
      return i;
    });
    this.setRoles(roles);
  }

  /** 角色获得经验(当前在线角色) */
  static onlineRoleGetExp(exp: number) {
    const role = this.findOnlineRole();
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
      // 播放升级特效
      LayerManager.addToUILayer(GameUiHelper.createUpgradeEffect());
    }
    // 保存
    this.updateOnlineRole(role);
    // 更新UI
    this.updateUi(role);
  }

  /** 更换装备 */
  static changeEquipment(equipment: Equipment) {
    if (GameHelper.checkRoleCanUseEquipment(equipment)) {
      const role = this.findOnlineRole();
      // 换装备
      role.equipments[equipment.type] = equipment;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 保存
      this.updateOnlineRole(role);
      // 更新UI
      this.updateUi(role);
      // 更改主角外观
      RoleUIManager.updateRoleOutShow(role);
      // 更新内观
      equipment && RoleUIManager.updateEquipmentDialog(equipment.type);
    }
  }

  /** 跳转地图 */
  static changeOnMap(mapId: MapId) {
    // 获取最新信息
    const role = this.findOnlineRole();
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    this.updateOnlineRole(role);
    // 重新进入游戏场景，走过渡场景完成新地图资源加载后再进入
    SceneManager.loadScene("Game");
  }

  /** 更新UI */
  static updateUi(role: Role, equipment?: Equipment) {
    RoleUIManager.updateRoleData(role);
  }

  /** 更换快捷键技能 */
  static changeShortcutKey(index: number, skillId: SkillId) {
    const role = this.findOnlineRole();
    role.shortcutKeys[index].skillId = skillId;
    this.updateOnlineRole(role);
    const skill = skills.get(skillId);
    RoleUIManager.updateShortcutIcon(role.shortcutKeys[index].key, skill?.icon, skill?.onClick);
  }
}

