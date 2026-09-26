import { Camera, Vec3 } from "cc";
import { Equipment } from "../../types/common";
import StorageHelper from "../helpers/StorageHelper";

interface GameHelper {
  camera: Camera;
  init: (camera: Camera) => void;
  worldPositionToScreenPosition: (worldPos: Vec3) => Vec3;
  // 角色是否能穿上装备
  checkRoleCanUseEquipment: (equipment: Equipment) => boolean;
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
    return equipment.level <= role.level && equipment.sex === role.sex && equipment.occupation === role.occupation;
  },
};

export default GameHelper;
