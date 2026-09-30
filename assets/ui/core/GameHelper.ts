import { Camera, Vec3 } from "cc";
import { BattleAttributes } from "../../types/common";
import { Equipment } from "../../types/good";
import { OECCUPATION, SEX } from "../../types/role";
import StorageManager from "./StorageManager";
import { Role } from "../../entities/Role";
import { levelMap } from "../../configs/level";
import { combatCalc as combatAttributeWeights } from "../../configs/battle";

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

  /** 战斗属性计算公式 */
  static combatCalc(role: Role) {
    const levelConfig = levelMap.get(role.level);
    if (!levelConfig) return role;

    const equipmentList = Object.keys(role.equipments)
      .map((key) => role.equipments[key as keyof Role["equipments"]])
      .filter((equipment): equipment is Equipment => equipment !== null);
    const attributeKeys: (keyof Omit<BattleAttributes, "maxHp">)[] = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];

    role.maxHp = levelConfig.maxHp + equipmentList.reduce((total, equipment) => total + equipment.maxHp, 0);
    // 最大魔法值只跟等级走（装备暂不影响魔法值）
    role.maxMp = levelConfig.maxMp;
    for (const key of attributeKeys) {
      role[key] = this.twoAttributesCalc([levelConfig[key], ...equipmentList.map((equipment) => equipment[key])]);
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

