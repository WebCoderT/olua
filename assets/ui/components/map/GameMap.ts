import { Node, TiledMap, TiledMapAsset, Vec3 } from "cc";
import LayerManager from "../../core/LayerManager";
import DropManager from "../../core/DropManager";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import MapObjectSpawner from "./MapObjectSpawner";
import CollisionAreaSpawner from "./CollisionAreaSpawner";
import MonsterAreaSpawner from "./MonsterAreaSpawner";
import { loadResourceAsync } from "../../utils/resource/ResourceLoader";
import { maps } from "../../../configs/map";

/**
 * 地图组件（自身即地图节点）
 * 负责地图资源加载与复活点定位，地图对象（NPC/复活点）生成交给 MapObjectSpawner、
 * 碰撞区域（collision 对象组）生成交给 CollisionAreaSpawner、
 * 刷怪区域（monster 对象组）生成交给 MonsterAreaSpawner（怪物本体由 MonsterManager 按区域生成）
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
    const mapAsset = await loadResourceAsync<TiledMapAsset>(src, TiledMapAsset);
    // 重复初始化时先移除旧组件
    this.getComponent(TiledMap)?.destroy();
    const tiledMap = this.addComponent(TiledMap);
    tiledMap.tmxAsset = mapAsset;
    LayerManager.addToMapLayer(this);
    // 按 npc 对象组生成 NPC（碰撞区与 NPC 的碰撞范围显示都在生成流程内完成）
    const objectSpawner = new MapObjectSpawner(this as Node);
    objectSpawner.spawnAll();
    // 按 collision 对象组生成碰撞区域（静态碰撞体 + 名称/区域指示线）
    new CollisionAreaSpawner(this as Node).spawnAll();
    // 按 monster 对象组生成怪物（每个区域在开图时按其 max 一次性生成，之后不再刷新）
    new MonsterAreaSpawner(this as Node).spawnAll();
    this.goToRevivePoint(objectSpawner.getRevivePoint());
  }

  /**
   * 前往复活点（复活点由 npc 对象组中 type=revive 的点位决定）
   * 地图未标复活点时只提示、不打断后续流程（否则会连带阻断地图对象生成）
   * @param revivePoint 复活点坐标（Tiled 原始坐标），无复活点时为 null
   */
  private goToRevivePoint(revivePoint: Vec3 | null) {
    if (!revivePoint) {
      console.warn(`${this.name} 未标复活点：请在 npc 对象组放一个 type=revive 的点位`);
      return;
    }
    // TODO: 地图坐标 -> 世界坐标换算后传送角色
    // const worldPosition = getMapPointPositionOnWorld(revivePoint, this);
    // StorageManager.updateRoleWorldPosition(worldPosition);
  }
}
