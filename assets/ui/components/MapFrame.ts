import { Node, TiledMap, Vec3 } from "cc";
import GameMapUiHelper from "../helpers/GameMapUiHelper";
import LayerHelper from "../helpers/LayerHelper";
import { getMapOffset, getMapPointPositionOnWorld } from "../utils/MapPointMath";
import RoleDisplayFrame from "./RoleDisplayFrame";

interface MapFrame {
  // 地图
  map: Node | null;
  // 初始化
  init: () => Promise<void>;
  // 初始化地图包含的对象
  initMapObjects: () => void;
  // 前往复活点
  goToRevivePoint: () => void;
}

const MapFrame: MapFrame = {
  map: null,
  async init() {
    MapFrame.map = await GameMapUiHelper.createMap("基础地图", "map/0");
    // MapFrame.map.setPosition(getMapOffset(MapFrame.map.getComponent(TiledMap)));
    LayerHelper.addToMapLayer(MapFrame.map);
    MapFrame.goToRevivePoint();
  },
  // 初始化地图包含的对象
  initMapObjects() {
    const objects = MapFrame.map.getComponent(TiledMap).getObjectGroup("objects");
  },
  // 前往复活点
  goToRevivePoint() {
    const map = MapFrame.map.getComponent(TiledMap);
    const point = map.getObjectGroup("objects").getObject("revive");
    if (!point) throw new Error("该地图无复活点！");
    const worldPosition = getMapPointPositionOnWorld(new Vec3(point.x, point.y), MapFrame.map);
    RoleDisplayFrame.updateRoleWorldPosition(worldPosition);
  },
};

export default MapFrame;
