import { Camera, Vec3 } from "cc";
import { BattleAttributes } from "../../types/common";
import { Equipment, EQUIPMENT_TYPE } from "../../types/good";
import { OECCUPATION, SEX } from "../../types/role";
import StorageManager from "./StorageManager";
import { Role } from "../../entities/Role";
import { levelMap } from "../../configs/level";
import { getEquipment } from "../../configs/items";
import { combatCalc as combatAttributeWeights } from "../../configs/battle";
import { maps } from "../../configs/map";
import { getSoulLevel } from "../../configs/soul";
import { MapId } from "../../types/map";

/**
 * 游戏工具（静态类）
 * 负责坐标系换算、装备校验与战斗属性计算
 */
export default class GameHelper {
  static camera: Camera | null = null;

  /** 初始化游戏全局工具 */
  static init(camera: Camera) {
    this.camera = camera;
  }

  /** 世界坐标转屏幕坐标 */
  static worldPositionToScreenPosition(worldPos: Vec3) {
    const screenPos = new Vec3();
    this.camera.worldToScreen(worldPos, screenPos);
    return screenPos;
  }

  /** 角色是否能穿上装备 */
  static checkRoleCanUseEquipment(equipment: Equipment) {
    return this.getEquipmentRejectReason(equipment) === null;
  }

  /**
   * 取装备不可穿戴的原因（可穿戴返回 null）
   * 判定项与顺序：等级 → 性别 → 职业；返回文案可直接用于提示玩家
   * @param equipment 待校验装备
   */
  static getEquipmentRejectReason(equipment: Equipment): string | null {
    const role = StorageManager.findOnlineRole();
    if (!role) return "角色不存在";
    if (equipment.level > role.level) return `需要等级 ${equipment.level}`;
    if (equipment.sex !== role.sex && equipment.sex !== SEX.ALL) return `${equipment.sex === SEX.BOY ? "男性" : "女性"}角色才能穿戴`;
    if (equipment.occupation !== role.occupation && equipment.occupation !== OECCUPATION.ALL) return "职业不符，无法穿戴";
    return null;
  }

  /**
   * 取进入地图的限制原因（满足条件返回 null）
   * 判定项与顺序：等级 → 战斗力 → 战魂等级；返回文案可直接用于提示玩家
   * @param mapId 目标地图编号
   */
  static getMapEnterRejectReason(mapId: MapId): string | null {
    const role = StorageManager.findOnlineRole();
    if (!role) return "角色不存在";
    const config = maps.get(mapId);
    if (!config) return "地图不存在";
    if (config.level > role.level) return `${config.label} 需要等级达到 ${config.level} 级`;
    if (config.combat > role.combat) return `${config.label} 需要战斗力达到 ${config.combat}`;
    if (config.soulOfWar > role.soulOfWar) return `${config.label} 需要战魂等级达到 ${config.soulOfWar} 阶`;
    return null;
  }

  /** 战斗属性计算公式 */
  static combatCalc(role: Role) {
    const levelConfig = levelMap.get(role.level);
    if (!levelConfig) return role;

    const equipmentList = (Object.keys(role.equipments) as EQUIPMENT_TYPE[])
      .map((slot) => getEquipment(role.equipments[slot]))
      .filter((equipment): equipment is Equipment => equipment !== null);
    // 战魂按当前等级提供整份属性加成（configs/soul，未激活为 null 不加成）
    const soul = getSoulLevel(role.soulOfWar);
    const attributeKeys: (keyof Omit<BattleAttributes, "maxHp">)[] = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];

    role.maxHp = levelConfig.maxHp + equipmentList.reduce((total, equipment) => total + equipment.maxHp, 0) + (soul?.attributes.maxHp ?? 0);
    // 最大魔法值只跟等级走（装备暂不影响魔法值）
    role.maxMp = levelConfig.maxMp;
    for (const key of attributeKeys) {
      const sources: [number, number][] = [levelConfig[key], ...equipmentList.map((equipment) => equipment[key])];
      if (soul) sources.push(soul.attributes[key]);
      role[key] = this.twoAttributesCalc(sources);
    }

    role.combat = Array.from(combatAttributeWeights.entries()).reduce((total, [key, weight]) => {
      const value = key === "maxHp" ? role.maxHp : this.oneAttributeCalc(role[key]);
      return total + value * weight;
    }, 0);

    return role;
  }

  /** 双属性计算 */
  static twoAttributesCalc(array: [number, number][]): [number, number] {
    return array.reduce(
      (acc, cur) => {
        return [acc[0] + cur[0], acc[1] + cur[1]];
      },
      [0, 0],
    );
  }

  /** 单属性计算 */
  static oneAttributeCalc(array: number[]) {
    return array.reduce((acc, cur) => acc + cur, 0);
  }
}

