import { Node, Size } from "cc";
import { tiledGroupNames } from "../../../configs/map";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getMapRectCenterPosition } from "../../utils/map/MapPointMath";
import { getTiledObjects, TiledObject } from "../../utils/map/TiledObjects";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/**
 * 碰撞区域生成器
 * 读取 TiledMap 中名为 collision 的对象组，把其中每个矩形对象实例化为游戏内的静态碰撞体：
 * 节点尺寸即碰撞范围（静态 RigidBody2D + BoxCollider2D，与 NPC 的障碍物同一套做法），
 * 位置按「Tiled 左上角坐标」换算到地图节点本地坐标，节点统一挂到地图层；
 * 碰撞范围的可视化由 GameUiHelper.showColliderRange 统一负责（与全部碰撞体共用一套调试开关）
 * 地图坐标到本地坐标的换算依赖地图节点本身，因此构造时注入地图节点
 */
export default class CollisionAreaSpawner {
  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;

  constructor(map: Node) {
    this.map = map;
  }

  /** 生成碰撞层中的全部元素（地图未画碰撞层时得到空数组，直接跳过） */
  spawnAll() {
    getTiledObjects(this.map, tiledGroupNames.collision).forEach((object) => {
      // 没有面积的元素（点、多边形）构不成矩形碰撞范围，跳过
      if (object.width <= 0 || object.height <= 0) return;
      this.spawnArea(object);
    });
  }

  /** 生成单个碰撞区域（节点尺寸即碰撞范围，位置为矩形中心） */
  private spawnArea(area: TiledObject) {
    const size = new Size(area.width, area.height);
    const node = GameUiHelper.createCollisionAreaNode(area.name, size);
    addObstacleCollider(node);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, area.name);
    node.setPosition(getMapRectCenterPosition(area.x, area.y, size.width, size.height, this.map));
    LayerManager.addToMapLayer(node);
  }
}
