import { Camera, Vec3 } from "cc";
import { BattleAttributes, Equipment, SEX } from "../../types/common";
import StorageHelper from "../utils/StorageHelper";
import { Role } from "../../configs/role";
import { levelMap } from "../../configs/level";
import { combatCalc as combatAttributeWeights } from "../../configs/game";

interface GameHelper {
  camera: Camera;
  init: (camera: Camera) => void;
  worldPositionToScreenPosition: (worldPos: Vec3) => Vec3;
  // 角色是否能穿上装备
  checkRoleCanUseEquipment: (equipment: Equipment) => boolean;
  // 战斗属性计算公式
  combatCalc: (role: Role) => Role;
  // 双属性计算
  twoAttributesCalc: (array: [number, number][]) => [number, number];
  // 单属性计算
  oneAttributeCalc: (array: number[]) => number;
}

const GameHelper: GameHelper = {
  camera: null,
  init(camera: Camera) {
    GameHelper.camera = camera;
  },
  worldPositionToScreenPosition(worldPos: Vec3) {
    const screenPos = new Vec3();
    GameHelper.camera.worldToScreen(worldPos, screenPos);
    return screenPos;
  },
  checkRoleCanUseEquipment(equipment: Equipment) {
    const role = StorageHelper.findOnlineRole();
    return equipment.level <= role.level && (equipment.sex === role.sex || equipment.sex === SEX.ALL) && equipment.occupation === role.occupation;
  },
  // 战斗属性计算公式
  combatCalc(role) {
    const levelConfig = levelMap.get(role.level);
    if (!levelConfig) return role;

    const equipmentList = Object.keys(role.equipments)
      .map((key) => role.equipments[key as keyof Role["equipments"]])
      .filter((equipment): equipment is Equipment => equipment !== null);
    const attributeKeys: (keyof Omit<BattleAttributes, "maxHp">)[] = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];

    role.maxHp = levelConfig.maxHp + equipmentList.reduce((total, equipment) => total + equipment.maxHp, 0);
    for (const key of attributeKeys) {
      role[key] = GameHelper.twoAttributesCalc([levelConfig[key], ...equipmentList.map((equipment) => equipment[key])]);
    }

    role.combat = Array.from(combatAttributeWeights.entries()).reduce((total, [key, weight]) => {
      const value = key === "maxHp" ? role.maxHp : GameHelper.oneAttributeCalc(role[key]);
      return total + value * weight;
    }, 0);

    const formatRange = (range: [number, number]) => `${range[0]}-${range[1]}`;
    console.log(
      [
        `血量：${role.maxHp}`,
        `物理攻击：${formatRange(role.physicalAttack)}`,
        `魔法攻击：${formatRange(role.magicAttack)}`,
        `道术攻击：${formatRange(role.taoistAttack)}`,
        `物理防御：${formatRange(role.physicalDefense)}`,
        `魔法防御：${formatRange(role.magicDefense)}`,
        `道术防御：${formatRange(role.taoistDefense)}`,
        `战斗力：${role.combat}`,
      ].join("，"),
    );

    return role;
  },
  // 双属性计算
  twoAttributesCalc(array) {
    return array.reduce(
      (acc, cur) => {
        return [acc[0] + cur[0], acc[1] + cur[1]];
      },
      [0, 0],
    );
  },
  // 单属性计算
  oneAttributeCalc(array) {
    return array.reduce((acc, cur) => acc + cur, 0);
  },
};

export default GameHelper;
