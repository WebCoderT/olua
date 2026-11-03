import { Size } from "cc";
import { maps } from "../../../configs/game-config";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/**
 * 碰撞区域生成器（#676：改读配置快照）
 *
 * ## 数据来源：服务端快照，不是 TMX
 *
 * #676 之前这里读 TMX 的 `collision` 对象组，把每个矩形实例化成静态碰撞体。碰撞盒搬进
 * `map_collisions` 之后，TMX 里**一个对象组都没有了**（地图文件只剩瓦片与图层），
 * 所以这里读 `configs/game-config` 的 `maps` 表（`applyMapRows` 填的，来自 `GET /game-config`）。
 *
 * 再读 TMX 会出现最难查的一类现象：后台在图上删了一个碰撞盒、客户端还能撞上 ——
 * 「配了没生效」与「本来就有」在画面上完全一样。
 *
 * ## 坐标是**世界坐标**，不再换算
 *
 * 快照里给的是矩形中心与尺寸（`x/y/w/h`），与库表同构。所以这里只做两件事：
 * 节点尺寸 = `(w, h)`、节点世界位置 = `(x, y)`。少一次换算就少一处「差一个符号」的机会。
 *
 * ## 节点尺寸即碰撞范围
 *
 * 静态 RigidBody2D + BoxCollider2D 由 `addObstacleCollider` 加，与 NPC 障碍物同一套做法；
 * 碰撞范围的可视化由 `GameUiHelper.showColliderRange` 统一负责（调试开关在 `configs/debug`）。
 */
export default class CollisionAreaSpawner {
  /** 这张图的 id（`resources/map/<id>` 与快照 `maps` 表的 key） */
  private mapId: string;

  constructor(mapId: string) {
    this.mapId = mapId;
  }

  /**
   * 生成全部碰撞体（快照没到 / 这张图没有碰撞盒时什么也不做）
   *
   * `maps` 在 Loading 阶段就已填好（#604 缺段直接停在 Loading 重试），所以正常进图一定有值；
   * 万一没有（有人绕过 Loading 直接 openScene），`warn` 而不是「猜一堆矩形」——
   * 猜出来的碰撞体比没有更糟：玩家会莫名其妙撞墙。
   */
  spawnAll() {
    const config = maps.get(this.mapId);
    if (!config) {
      console.warn(`[CollisionAreaSpawner] 地图 ${this.mapId} 的配置还没到，跳过碰撞体`);
      return;
    }
    for (const box of config.collisions) {
      // 零面积的盒子构不成碰撞范围（快照侧已过滤一次，这里再守一道：数据坏了不该炸整张图）
      if (box.w <= 0 || box.h <= 0) continue;
      this.spawnArea(box.x, box.y, box.w, box.h);
    }
  }

  /** 生成单个碰撞区域（节点尺寸即碰撞范围，位置为矩形中心 = 世界坐标） */
  private spawnArea(x: number, y: number, width: number, height: number) {
    const node = GameUiHelper.createCollisionAreaNode("collision", new Size(width, height));
    addObstacleCollider(node);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, "collision");
    // 先入层再定位（无父节点时写的其实是本地坐标），与 NPC 生成器同一顺序
    LayerManager.addToMapLayer(node);
    node.setWorldPosition(x, y, 0);
  }
}
