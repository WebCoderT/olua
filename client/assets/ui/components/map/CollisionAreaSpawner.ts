import { Size, Vec2 } from "cc";
import { maps } from "../../../configs/game-config";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { addPolygonObstacleCollider } from "../../utils/physics/ObstacleCollider";

/**
 * 碰撞区域生成器（#676：改读配置快照；#1190：矩形升级为多边形）
 *
 * ## 数据来源：服务端快照，不是 TMX
 *
 * #676 之前这里读 TMX 的 `collision` 对象组，把每个矩形实例化成静态碰撞体。碰撞盒搬进
 * `map_collisions` 之后，TMX 里**一个对象组都没有了**（地图文件只剩瓦片与图层），
 * 所以这里读 `configs/game-config` 的 `maps` 表（`applyMapRows` 填的，来自 `GET /game-config`）。
 *
 * 再读 TMX 会出现最难查的一类现象：后台在图上删了一个碰撞区、客户端还能撞上 ——
 * 「配了没生效」与「本来就有」在画面上完全一样。
 *
 * ## 坐标是**世界坐标**，不再换算
 *
 * 快照里给的是多边形顶点序列（`points`，`[x, y][]`，首尾自动闭合），与库表同构。
 * 节点摆在**顶点包围盒的中心**、`PolygonCollider2D` 的顶点取相对该中心的坐标 ——
 * 中心怎么取必须与服务端烙格 / 穿墙校验用同一套几何（两端各自算，公式一致才不漂）。
 *
 * ## 静态 RigidBody2D + PolygonCollider2D
 *
 * 由 `addPolygonObstacleCollider` 加，与 NPC 盒障碍同一套做法；碰撞范围的可视化由
 * `GameUiHelper.showColliderRange` 统一负责（调试开关在 `configs/debug`）。
 */
export default class CollisionAreaSpawner {
  /** 这张图的 id（`resources/map/<id>` 与快照 `maps` 表的 key） */
  private mapId: string;

  constructor(mapId: string) {
    this.mapId = mapId;
  }

  /**
   * 生成全部碰撞体（快照没到 / 这张图没有碰撞多边形时什么也不做）
   *
   * `maps` 在 Loading 阶段就已填好（#604 缺段直接停在 Loading 重试），所以正常进图一定有值；
   * 万一没有（有人绕过 Loading 直接 openScene），`warn` 而不是「猜一堆形状」——
   * 猜出来的碰撞体比没有更糟：玩家会莫名其妙撞墙。
   */
  spawnAll() {
    const config = maps.get(this.mapId);
    if (!config) {
      console.warn(`[CollisionAreaSpawner] 地图 ${this.mapId} 的配置还没到，跳过碰撞体`);
      return;
    }
    for (const poly of config.collisions) {
      // 封闭不了的多边形构不成碰撞范围（快照侧已过滤一次，这里再守一道：数据坏了不该炸整张图）
      if (!poly.points || poly.points.length < 3) continue;
      this.spawnPolygon(poly.points);
    }
  }

  /**
   * 生成单个碰撞多边形
   *
   * 节点 UITransform 尺寸取包围盒（调试范围框与名称按它摆），碰撞体顶点取相对包围盒
   * 中心的坐标 —— PolygonCollider2D 的 `points` 是相对量，不是世界坐标。
   */
  private spawnPolygon(points: Array<[number, number]>) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const node = GameUiHelper.createCollisionAreaNode("collision", new Size(maxX - minX, maxY - minY));
    addPolygonObstacleCollider(node, points.map(([x, y]) => new Vec2(x - centerX, y - centerY)));
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, "collision");
    // 先入层再定位（无父节点时写的其实是本地坐标），与 NPC 生成器同一顺序
    LayerManager.addToMapLayer(node);
    node.setWorldPosition(centerX, centerY, 0);
  }
}
