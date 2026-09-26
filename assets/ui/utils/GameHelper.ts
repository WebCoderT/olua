import { Camera, Vec3 } from "cc";

interface GameHelper {
  camera: Camera;
  init: (camera: Camera) => void;
  worldPositionToScreenPosition: (worldPos: Vec3) => Vec3;
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
};

export default GameHelper;
