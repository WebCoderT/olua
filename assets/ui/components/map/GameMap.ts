import { Node, TiledMap, TiledMapAsset } from "cc";
import LayerManager from "../../core/LayerManager";
import DropManager from "../../core/DropManager";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import MapObjectSpawner from "./MapObjectSpawner";
import CollisionAreaSpawner from "./CollisionAreaSpawner";
import { loadResourcesAsync } from "../../utils/ResourceLoad";
import { maps } from "../../../configs/map";

/**
 * 地图组件（自身即地图节点）
 * 负责地图资源加载与复活点定位，地图对象（NPC/怪物）生成交给 MapObjectSpawner、
 * 碰撞区域（collision 对象组）生成交给 CollisionAreaSpawner
 * 地图资源异步加载完成后才在自身挂载 TiledMap 组件并生成地图对象，
 * 避免节点先挂上而地图未加载完成导致的黑屏
 */
export default class GameMap extends Node {
  constructor() {
    super("map");
    const role = StorageManager.findOnlineRole();
    const onMap = maps.get(role.onMap);
    this.name = `map_${role.onMap}`;
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
    // 添加地图上包含的所有对象（NPC/怪物）
    new MapObjectSpawner(this as Node).spawnAll();
    // 按 map 的 collision 对象组生成碰撞区域（静态碰撞体 + 对象名称/区域指示线）
    new CollisionAreaSpawner(this as Node).spawnAll();
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
