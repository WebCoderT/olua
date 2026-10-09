import { Node, TiledMap, TiledMapAsset, Vec3 } from "cc";
import LayerManager from "../../core/LayerManager";
import DropManager from "../../core/DropManager";
import MonsterManager from "../../core/MonsterManager";
import AutoBattle from "../../core/AutoBattle";
import StorageManager from "../../core/StorageManager";
import MapObjectSpawner from "./MapObjectSpawner";
import CollisionAreaSpawner from "./CollisionAreaSpawner";
import MonsterAreaSpawner from "./MonsterAreaSpawner";
import { loadResourceAsync } from "../../utils/resource/ResourceLoader";
import { getMapPointPositionOnWorld } from "../../utils/map/MapPointMath";
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
  /** 复活点世界坐标（地图标了 class=revive 的点位且地图加载完成后才有值） */
  private reviveWorldPosition: Vec3 | null = null;
  /** 复活点就绪回调（由组合根注入主角的定位方法，见 setReviveHandler） */
  private reviveHandler: ((worldPosition: Vec3) => void) | null = null;

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
    // 关闭引擎的瓦片裁剪（TiledMap.enableCulling 默认 true）——这是「传送后整张地图一片黑、动一下才恢复」的根因：
    // 裁剪范围（可见瓦片行列）由 TiledLayer.updateCulling 在「相机节点 TRANSFORM_CHANGED」时**同步**重算，
    // 而它用的是相机视图矩阵（camera.screenToWorld），此刻矩阵还没跟上本帧的位置变化（引擎自己也把首次裁剪
    // 延后一帧，注释即 "delay 1 frame, since camera's matrix data is dirty"）。
    // 于是瞬移/传送这种跨屏跳变会把裁剪范围算成**跳变前**的位置 → 目标区域整片瓦片不在裁剪矩形内，不渲染（黑屏）；
    // 之后再移动一下（相机再次变化）才重算出正确范围，画面才恢复。
    // 引擎文档亦写明「瓦片地图采用了摄像机的话需要手动关闭裁剪，否则渲染会出错」，本工程相机正是跟随角色移动的。
    // 代价可忽略：本工程地图为 2 层 64×64（每层 4096 格，共 1 个批次/层），关闭后每帧全量提交，
    // 屏幕外的格子在裁剪阶段被丢弃，实测开销远小于「传送后黑屏」的体验损失。
    tiledMap.enableCulling = false;
    LayerManager.addToMapLayer(this);
    // 按 npc 对象组生成 NPC（碰撞区与 NPC 的碰撞范围显示都在生成流程内完成）
    const objectSpawner = new MapObjectSpawner(this as Node);
    objectSpawner.spawnAll();
    // 按 collision 对象组生成碰撞区域（静态碰撞体 + 名称/区域指示线）
    new CollisionAreaSpawner(this as Node).spawnAll();
    // 按 monster 对象组生成怪物（每个区域在开图时按其 max 一次性生成，之后不再刷新）
    new MonsterAreaSpawner(this as Node).spawnAll();
    // 自动战斗的寻路网格以这张地图为基准（换图后旧网格作废，挂机目标重新选取）
    AutoBattle.setMap(this as Node);
    this.goToRevivePoint(objectSpawner.getRevivePoint());
  }

  /**
   * 注册复活点定位回调（组合根创建主角后调用）
   * 地图资源是异步加载的，而主角在地图构造之后创建，「谁后就绪谁触发」：
   * 地图已就绪时注册即立刻回调一次，避免地图先加载完导致定位丢失
   * @param handler 复活点世界坐标的接收者（主角的传送方法）
   */
  setReviveHandler(handler: (worldPosition: Vec3) => void) {
    this.reviveHandler = handler;
    if (this.reviveWorldPosition) handler(this.reviveWorldPosition);
  }

  /**
   * 回到复活点（安全复活）：把主角传送到当前地图的复活点
   * 进入地图时已定位过一次（setReviveHandler 的立即回调），死亡后选「安全复活」时再次触发
   * 地图未标复活点时不做任何事（不移动）
   */
  revive() {
    if (!this.reviveWorldPosition) return;
    this.reviveHandler?.(this.reviveWorldPosition);
  }

  /**
   * 前往复活点：把复活点的地图坐标换算成世界坐标后交给主角
   * 复活点由 npc 对象组中类为 revive 的点位决定（旧地图用对象名 revive 标记，同样识别）
   * 地图未标复活点时只提示、不打断后续流程（否则会连带阻断地图对象生成）
   * @param revivePoint 复活点坐标（Tiled 原始坐标），无复活点时为 null
   */
  private goToRevivePoint(revivePoint: Vec3 | null) {
    if (!revivePoint) {
      console.warn(`${this.name} 未标复活点：请在 npc 对象组放一个类为 revive 的点位`);
      return;
    }
    this.reviveWorldPosition = getMapPointPositionOnWorld(revivePoint, this as Node);
    this.reviveHandler?.(this.reviveWorldPosition);
  }
}
