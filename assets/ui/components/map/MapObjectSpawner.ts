import { Node, TiledMap, Vec3 } from "cc";
import { npcs } from "../../../configs/npc";
import MonsterManager from "../../core/MonsterManager";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getMapPointPosition } from "../../utils/map/MapPointMath";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/**
 * 地图对象生成器
 * 按 TiledMap 的 objects 对象组生成 NPC 与怪物：
 * NPC 节点挂到地图层并绑定点击事件，怪物统一交给 MonsterManager（挂怪物层）
 * 地图坐标到世界坐标的换算依赖地图节点本身，因此构造时注入地图节点
 */
export default class MapObjectSpawner {
  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;

  constructor(map: Node) {
    this.map = map;
  }

  /** 生成对象组中的全部 NPC 与怪物 */
  spawnAll() {
    const objects = this.map.getComponent(TiledMap).getObjectGroup("objects");
    objects.getObjects().forEach((object) => {
      if (!object.properties.id) return;
      switch (object.properties.type) {
        case "npc":
          this.spawnNpc(object.properties.id as string, new Vec3(object.x, object.y));
          break;
        case "monster":
          MonsterManager.spawn(object.properties.id as string, getMapPointPosition(new Vec3(object.x, object.y), this.map));
          break;
        default:
          break;
      }
    });
  }

  /** 添加NPC（节点主体由 GameUiHelper 生成，此处只负责放置与事件绑定） */
  private spawnNpc(id: string, position: Vec3) {
    const npc = npcs.get(id);
    const npcNode = GameUiHelper.createNpcNode(npc);
    addObstacleCollider(npcNode);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(npcNode, npc.label);
    npcNode.setWorldPosition(getMapPointPosition(position, this.map));
    LayerManager.addToMapLayer(npcNode);
    npcNode.on(Node.EventType.TOUCH_END, () => npc.onClick && npc.onClick(), this);
  }
}
