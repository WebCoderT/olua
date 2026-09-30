import { Node, Size, TiledMap } from "cc";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getMapRectCenterPosition } from "../../utils/map/MapPointMath";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/** Tiled 碰撞层对象（只取本生成器用到的字段） */
interface CollisionAreaObject {
  /** 对象名称（Tiled 里给区域起的名字，用于调试显示） */
  name: string;
  /** 矩形左上角 x（Tiled 坐标，原点在地图左上角） */
  x: number;
  /** 矩形左上角 y（Tiled 坐标，y 轴向下） */
  y: number;
  /** 矩形宽（像素） */
  width: number;
  /** 矩形高（像素） */
  height: number;
}

/**
 * 碰撞区域生成器
 * 读取 TiledMap 中名为 collision 的对象组，把其中每个矩形对象实例化为游戏内的静态碰撞体：
 * 节点尺寸即碰撞范围（静态 RigidBody2D + BoxCollider2D，与 NPC 的障碍物同一套做法），
 * 位置按「Tiled 左上角坐标」换算到地图节点本地坐标，节点统一挂到地图层；
 * 碰撞范围的可视化由 GameUiHelper.showColliderRange 统一负责（与全部碰撞体共用一套调试开关）
 * 地图坐标到本地坐标的换算依赖地图节点本身，因此构造时注入地图节点
 */
export default class CollisionAreaSpawner {
  /** 碰撞层对象组名称 */
  private static readonly GROUP_NAME = "collision";

  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;

  constructor(map: Node) {
    this.map = map;
  }

  /** 生成碰撞层中的全部元素 */
  spawnAll() {
    const group = this.map.getComponent(TiledMap).getObjectGroup(CollisionAreaSpawner.GROUP_NAME);
    // 地图未画碰撞层时无需生成（如纯安全区地图）
    if (!group) return;
    group.getObjects().forEach((object) => {
      const area: CollisionAreaObject = object;
      // 没有面积的元素（如点）构不成碰撞范围，跳过
      if (area.width <= 0 || area.height <= 0) return;
      this.spawnArea(area);
    });
  }

  /** 生成单个碰撞区域（节点尺寸即碰撞范围，位置为矩形中心） */
  private spawnArea(area: CollisionAreaObject) {
    const size = new Size(area.width, area.height);
    const node = GameUiHelper.createCollisionAreaNode(area.name, size);
    addObstacleCollider(node);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, area.name);
    node.setPosition(getMapRectCenterPosition(area.x, area.y, size.width, size.height, this.map));
    LayerManager.addToMapLayer(node);
  }
}
