import { Color, Node, Size, Sprite, TiledMap, Vec2, Vec3 } from "cc";
import GameMapUiHelper from "../helpers/GameMapUiHelper";
import LayerManager from "../utils/LayerManager";
import { getMapPointPosition } from "../utils/MapPointMath";
import { npcs } from "../../configs/npc";
import UiHelper from "../helpers/UiHelper";
import AnimationHelper from "../helpers/AnimationHelper";
import StorageManager from "../utils/StorageManager";
import { maps } from "../../configs/map";

interface MapFrame {
  // 地图
  map: Node | null;
  // 初始化
  init: () => Promise<void>;
  // 初始化地图包含的对象
  initMapObjects: () => void;
  // 创建npc
  createNpc: (id: string, position: Vec3) => void;
  // 创建npc怪物
  createNpcMonster: (id: string, position: Vec3) => void;
  // 前往复活点
  goToRevivePoint: () => void;
}

const MapFrame: MapFrame = {
  map: null,
  async init() {
    const role = StorageManager.findOnlineRole();
    const onMap = maps.get(role.onMap);
    MapFrame.map = await GameMapUiHelper.createMap("map_" + role.onMap, onMap.src);
    // MapFrame.map.setPosition(getMapOffset(MapFrame.map.getComponent(TiledMap)));
    LayerManager.clearMapLayer();
    LayerManager.addToMapLayer(MapFrame.map);
    MapFrame.goToRevivePoint();
    // 添加地图上包含的所有对象
    MapFrame.initMapObjects();
  },
  // 初始化地图包含的对象
  initMapObjects() {
    const objects = MapFrame.map.getComponent(TiledMap).getObjectGroup("objects");
    objects.getObjects().forEach((object) => {
      if (object.properties.id) {
        switch (object.properties.type) {
          case "npc":
            MapFrame.createNpc(object.properties.id as string, new Vec3(object.x, object.y));
            break;
          case "monster":
            MapFrame.createNpcMonster(object.properties.id as string, new Vec3(object.x, object.y));
            break;
          default:
            break;
        }
      }
    });
  },
  // 添加NPC
  createNpc(id, position) {
    const npc = npcs.get(id);
    const npcNode = UiHelper.createFlexCol("npc_node", 0, new Vec2(), new Size(100, 170));
    const npcLabel = UiHelper.createLabel("npc_label", npc.label, Color.WHITE, 12, new Vec2(), new Size(100, 20));
    npcNode.addChild(npcLabel);
    const positionOnMap = getMapPointPosition(position, MapFrame.map);
    const npcSprteNode = UiHelper.createSprite("npc_sprite_node", "", new Vec2(), new Size(100, 150));
    const npcSprite = UiHelper.createSprite("npc_sprite", "");
    npc.scale && npcSprite.setScale(npc.scale);
    npc.position && npcSprite.setPosition(npc.position);
    AnimationHelper.playLoopWithDir("npc", npcSprite, npc.src);
    npcSprteNode.addChild(npcSprite);
    npcNode.addChild(npcSprteNode);
    npcNode.setWorldPosition(positionOnMap);
    LayerManager.addToMapLayer(npcNode);
    npcNode.on(Node.EventType.TOUCH_END, () => npc.onClick && npc.onClick(), this);
  },

  // 添加NPC怪物，比如试炼
  createNpcMonster(id, position) {
    MapFrame.createNpc(id, position);
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
