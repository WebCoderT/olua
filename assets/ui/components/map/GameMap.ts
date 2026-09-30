import { Node, TiledMap, TiledMapAsset, Vec3 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import DropManager from "../../core/DropManager";
import MonsterManager from "../../core/MonsterManager";
import { getMapPointPosition } from "../../utils/MapPointMath";
import { loadResourcesAsync } from "../../utils/ResourceLoad";
import { npcs } from "../../../configs/npc";
import StorageManager from "../../core/StorageManager";
import { maps } from "../../../configs/map";
import { addObstacleCollider } from "../../utils/utils";

/**
 * 地图组件（自身即地图节点）
 * 挂载于地图层，负责地图资源加载、地图对象（NPC/怪物）生成与复活点定位
 * 地图资源异步加载完成后才在自身挂载 TiledMap 组件并生成地图对象，
 * 避免节点先挂上而地图未加载完成导致的黑屏
 * 怪物的生成与清空统一交给 MonsterManager（怪物节点挂载到怪物层）
 */
export default class GameMap extends Node {
  constructor() {
    super("map");
    const role = StorageManager.findOnlineRole();
    const onMap = maps.get(role.onMap);
    this.name = "map_" + role.onMap;
    // 清空上一张地图的怪物与掉落物
    MonsterManager.reset();
    DropManager.reset();
    LayerManager.clearMapLayer();
    this.loadMap(onMap.src);
  }

  /** 初始化地图（异步：地图资源加载完成后才挂载 TiledMap 组件） */
  async loadMap(src: string) {
    // 等待地图资源加载完成后，将 TiledMap 组件挂到自身
    const mapAsset = await loadResourcesAsync<TiledMapAsset>("map", src, TiledMapAsset);
    // 重复初始化时先移除旧组件
    this.getComponent(TiledMap)?.destroy();
    const tiledMap = this.addComponent(TiledMap);
    tiledMap.tmxAsset = mapAsset;
    LayerManager.addToMapLayer(this);
    this.goToRevivePoint();
    // 添加地图上包含的所有对象
    this.initMapObjects();
  }

  /** 初始化地图包含的对象 */
  private initMapObjects() {
    const objects = this.getComponent(TiledMap).getObjectGroup("objects");
    objects.getObjects().forEach((object) => {
      if (object.properties.id) {
        switch (object.properties.type) {
          case "npc":
            this.createNpc(object.properties.id as string, new Vec3(object.x, object.y));
            break;
          case "monster":
            MonsterManager.spawn(object.properties.id as string, getMapPointPosition(new Vec3(object.x, object.y), this));
            break;
          default:
            break;
        }
      }
    });
  }

  /** 添加NPC（节点主体由 GameUiHelper 生成，此处只负责放置与事件绑定） */
  private createNpc(id: string, position: Vec3) {
    const npc = npcs.get(id);
    const npcNode = GameUiHelper.createNpcNode(npc);
    addObstacleCollider(npcNode);
    npcNode.setWorldPosition(getMapPointPosition(position, this));
    LayerManager.addToMapLayer(npcNode);
    npcNode.on(Node.EventType.TOUCH_END, () => npc.onClick && npc.onClick(), this);
  }

  /** 前往复活点 */
  private goToRevivePoint() {
    const map = this.getComponent(TiledMap);
    const point = map.getObjectGroup("objects").getObject("revive");
    if (!point) throw new Error("该地图无复活点！");
    // TODO: 地图坐标 -> 世界坐标换算后传送角色
    // const worldPosition = getMapPointPositionOnWorld(new Vec3(point.x, point.y), this);
    // StorageManager.updateRoleWorldPosition(worldPosition);
  }
}
