import { Node, TiledMap, Vec3 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import { getMapPointPosition } from "../../utils/MapPointMath";
import { npcs } from "../../../configs/npc";
import StorageManager from "../../core/StorageManager";
import { maps } from "../../../configs/map";
import { addObstacleCollider } from "../../utils/utils";
import Monsters from "./Monsters";

/**
 * 地图组件
 * 挂载于地图层的节点容器，负责地图加载、地图对象（NPC/怪物）生成与复活点定位
 * 怪物容器（Monsters）由外部注入，跨地图共享
 */
export default class GameMap extends Node {
  /** 当前地图的 Tiled 节点 */
  private tiledMapNode: Node | null = null;
  /** 怪物容器（外部注入，跨地图共享） */
  private monsters: Monsters;

  constructor(monsters: Monsters) {
    super("map");
    this.monsters = monsters;
  }

  /** 初始化地图 */
  async init() {
    const role = StorageManager.findOnlineRole();
    const onMap = maps.get(role.onMap);
    this.name = "map_" + role.onMap;
    // 清空上一张地图的怪物
    this.monsters.reset();
    LayerManager.clearMapLayer();
    LayerManager.addToMapLayer(this);
    // 加载 Tiled 地图（由 GameUiHelper 生成）
    const tiledMapNode = await GameUiHelper.createTiledMap("tiled_map", onMap.src);
    this.tiledMapNode = tiledMapNode;
    this.addChild(tiledMapNode);
    this.goToRevivePoint();
    // 添加地图上包含的所有对象
    this.initMapObjects();
  }

  /** 初始化地图包含的对象 */
  private initMapObjects() {
    const objects = this.tiledMapNode.getComponent(TiledMap).getObjectGroup("objects");
    objects.getObjects().forEach((object) => {
      if (object.properties.id) {
        switch (object.properties.type) {
          case "npc":
            this.createNpc(object.properties.id as string, new Vec3(object.x, object.y));
            break;
          case "monster":
            this.monsters.createOneMonster(object.properties.id as string, getMapPointPosition(new Vec3(object.x, object.y), this.tiledMapNode));
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
    npcNode.setWorldPosition(getMapPointPosition(position, this.tiledMapNode));
    LayerManager.addToMapLayer(npcNode);
    npcNode.on(Node.EventType.TOUCH_END, () => npc.onClick && npc.onClick(), this);
  }

  /** 前往复活点 */
  private goToRevivePoint() {
    const map = this.tiledMapNode.getComponent(TiledMap);
    const point = map.getObjectGroup("objects").getObject("revive");
    if (!point) throw new Error("该地图无复活点！");
    // TODO: 地图坐标 -> 世界坐标换算后传送角色
    // const worldPosition = getMapPointPositionOnWorld(new Vec3(point.x, point.y), this.tiledMapNode);
    // StorageManager.updateRoleWorldPosition(worldPosition);
  }
}
