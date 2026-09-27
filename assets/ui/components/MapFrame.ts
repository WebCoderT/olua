import { Color, Node, Size, Sprite, TiledMap, Vec2, Vec3 } from "cc";
import GameMapUiHelper from "../helpers/GameMapUiHelper";
import LayerManager from "../utils/LayerManager";
import { getMapPointPosition } from "../utils/MapPointMath";
import { npcs } from "../../configs/npc";
import UiHelper from "../helpers/UiHelper";
import AnimationHelper from "../helpers/AnimationHelper";

interface MapFrame {
  // 地图
  map: Node | null;
  // 初始化
  init: () => Promise<void>;
  // 初始化地图包含的对象
  initMapObjects: () => void;
  // 创建npc
  createNpc: (id: string, position: Vec3) => void;
  // 前往复活点
  goToRevivePoint: () => void;
}

const MapFrame: MapFrame = {
  map: null,
  async init() {
    MapFrame.map = await GameMapUiHelper.createMap("基础地图", "map/0");
    // MapFrame.map.setPosition(getMapOffset(MapFrame.map.getComponent(TiledMap)));
    LayerManager.addToMapLayer(MapFrame.map);
    MapFrame.goToRevivePoint();
    // 添加地图上包含的所有对象
    MapFrame.initMapObjects();
  },
  // 初始化地图包含的对象
  initMapObjects() {
    const objects = MapFrame.map.getComponent(TiledMap).getObjectGroup("objects");
    objects.getObjects().forEach((object) => {
      if (object.properties.id && object.properties.type === "npc") {
        MapFrame.createNpc(object.properties.id as string, new Vec3(object.x, object.y));
      }
    });
  },
  // 添加NPC
  createNpc(id, position) {
    const npc = npcs.get(id);
    const npcNode = UiHelper.createFlexCol("npc_node", 0, new Vec2(), new Size(100, 0));
    const npcLabel = UiHelper.createLabel("npc_label", npc.label, Color.WHITE, 12, new Vec2(), new Size(100, 20));
    LayerManager.setLayerToMapLayer(npcLabel);
    npcNode.addChild(npcLabel);
    const positionOnMap = getMapPointPosition(position, MapFrame.map);
    const npcSprteNode = UiHelper.createSprite("npc_sprite_node", "", new Vec2(), new Size(100, 150));
    LayerManager.setLayerToMapLayer(npcSprteNode);
    const npcSprite = UiHelper.createSprite("npc_sprite", "");
    npc.scale && npcSprite.setScale(npc.scale);
    npc.position && npcSprite.setPosition(npc.position);
    LayerManager.setLayerToMapLayer(npcSprite);
    AnimationHelper.playLoopWithDir("npc", npcSprite, npc.src);
    npcSprteNode.addChild(npcSprite);
    npcNode.addChild(npcSprteNode);
    npcNode.setWorldPosition(positionOnMap);
    LayerManager.addToMapLayer(npcNode);
  },
  // 前往复活点
  goToRevivePoint() {
    const map = MapFrame.map.getComponent(TiledMap);
    const point = map.getObjectGroup("objects").getObject("revive");
    if (!point) throw new Error("该地图无复活点！");
    // const worldPosition = getMapPointPositionOnWorld(new Vec3(point.x, point.y), MapFrame.map);
    // RoleDisplayFrame.updateRoleWorldPosition(worldPosition);
  },
};

export default MapFrame;
