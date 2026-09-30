import { Node, Vec3 } from "cc";
import { npcs } from "../../../configs/npc";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getMapPointPosition } from "../../utils/map/MapPointMath";
import { getTiledObjectsFrom, TiledObject } from "../../utils/map/TiledObjects";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/** 对象组名称：地图里画 NPC 点位的对象组 */
const NPC_GROUP_NAME = "npc";

/** 兼容对象组名称：早期地图把 NPC 与复活点画在 objects 组 */
const LEGACY_OBJECT_GROUP_NAME = "objects";

/** 自定义属性 type 取值：NPC */
const OBJECT_TYPE_NPC = "npc";

/** 自定义属性 type 取值：复活点 */
const OBJECT_TYPE_REVIVE = "revive";

/**
 * 地图对象生成器
 * 读取 TiledMap 的 npc 对象组，把其中每个点位按自定义属性 type 分流：
 * type=npc 生成 NPC 节点（挂地图层、带静态碰撞体、绑定点击事件），
 * type=revive 记录为复活点坐标供 GameMap 使用（不生成节点）。
 * 点位坐标（Tiled 左上角原点、y 轴向下）由 MapPointMath 统一换算，本类不自行翻转 y
 * 地图坐标换算依赖地图节点本身，因此构造时注入地图节点
 */
export default class MapObjectSpawner {
  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;

  /** 复活点坐标（Tiled 原始坐标，未标复活点时为 null） */
  private revivePoint: Vec3 | null = null;

  constructor(map: Node) {
    this.map = map;
  }

  /** 生成对象组中的全部 NPC，并记录复活点 */
  spawnAll() {
    // 兼容早期地图（NPC 与复活点画在 objects 组）
    const objects = getTiledObjectsFrom(this.map, NPC_GROUP_NAME, LEGACY_OBJECT_GROUP_NAME);
    objects.forEach((object) => this.spawnObject(object));
  }

  /** 地图的复活点坐标（Tiled 原始坐标，未标复活点时为 null） */
  getRevivePoint() {
    return this.revivePoint;
  }

  /** 按点位用途分流：复活点只记录坐标，NPC 生成节点 */
  private spawnObject(object: TiledObject) {
    const type = `${object.properties.type ?? ""}`;
    // 复活点：以自定义属性 type=revive 标记；早期地图用对象名 revive 标记的同样识别
    if (type === OBJECT_TYPE_REVIVE || object.name === OBJECT_TYPE_REVIVE) {
      this.revivePoint = new Vec3(object.x, object.y);
      return;
    }
    if (type !== OBJECT_TYPE_NPC) return;
    const id = `${object.properties.id ?? ""}`;
    if (!id) return;
    this.spawnNpc(id, new Vec3(object.x, object.y));
  }

  /** 添加NPC（节点主体由 GameUiHelper 生成，此处只负责放置与事件绑定） */
  private spawnNpc(id: string, position: Vec3) {
    const npc = npcs.get(id);
    if (!npc) return;
    const npcNode = GameUiHelper.createNpcNode(npc);
    addObstacleCollider(npcNode);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(npcNode, npc.label);
    npcNode.setWorldPosition(getMapPointPosition(position, this.map));
    LayerManager.addToMapLayer(npcNode);
    npcNode.on(Node.EventType.TOUCH_END, () => npc.onClick && npc.onClick(), this);
  }
}
