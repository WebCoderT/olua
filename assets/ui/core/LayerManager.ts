import { Camera, isValid, Node, Vec2, Vec3 } from "cc";
import { isPointOnUi as uiHitTest } from "../utils/input/UiHit";

export enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  GAME = 1 << 2,
  MONSTER = 1 << 3,
  EFFECT = 1 << 4,
  UI = 1 << 5,
}

/**
 * 图层管理器
 * 负责场景内各渲染图层（地图层/掉落层/怪物层/游戏层/特效层/UI层）的初始化与元素挂载
 * 图层容器为静态节点，会随场景销毁，因此每次进场景（initLayer）都必须重建
 */
export default class LayerManager {
  /** 相机（初始化后可用） */
  static camera: Camera | null = null;

  /** 已注册图层继承监听的节点（弱引用，节点销毁后自动回收） */
  private static layerWatchers = new WeakSet<Node>();

  /** 地图层 */
  static MapLayer: Node = new Node("map_layer");
  /** 掉落层（怪物死亡掉落物） */
  static DropLayer: Node = new Node("drop_layer");
  /** 游戏层 */
  static GameLayer: Node = new Node("game_layer");
  /** 怪物层 */
  static MonsterLayer: Node = new Node("monster_layer");
  /** 特效层 */
  static EffectLayer: Node = new Node("effect_layer");
  /** UI层 */
  static UILayer: Node = new Node("ui_layer");

  /**
   * 循环元素下所有元素添加至指定图层
   * 同时为整棵子树注册「新增子节点自动继承图层」监听
   * （引擎新建节点的 layer 恒为 DEFAULT，不在相机 visibility 内，且不会随父节点继承，
   * 挂载图层之后再动态新建的子节点会渲染不出来，例如背包刷新、装备槽换装、属性列表重建）
   */
  static setNodeToLayer(node: Node, layer: Layer) {
    node.layer = layer;
    this.watchChildAdded(node, layer);
    node.children.forEach((child) => {
      this.setNodeToLayer(child, layer);
    });
  }

  /**
   * 为节点注册一次「新增子节点自动继承图层」监听（同一节点只注册一次）
   * 节点销毁时监听随之回收，不会残留
   */
  private static watchChildAdded(node: Node, layer: Layer) {
    if (this.layerWatchers.has(node)) return;
    this.layerWatchers.add(node);
    node.on(Node.EventType.CHILD_ADDED, (child: Node) => {
      // 节点已被移出该图层时跳过，避免残留监听把子节点刷回旧图层
      if (!isValid(node) || node.layer !== layer) return;
      this.setNodeToLayer(child, layer);
    });
  }

  /**
   * 初始化所有图层
   * 图层容器是静态节点，上个场景销毁时会被连带销毁，因此这里必须重建，
   * 不能把已销毁的旧容器再挂到新场景（会触发 Node.walk 读取 null children 崩溃）
   */
  static initLayer(scene: Node, camera: Camera) {
    this.camera = camera;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP | Layer.DROP | Layer.GAME | Layer.MONSTER;
    // 重建全部图层容器
    this.MapLayer = this.createLayer(scene, "map_layer", Layer.MAP);
    this.DropLayer = this.createLayer(scene, "drop_layer", Layer.DROP);
    this.GameLayer = this.createLayer(scene, "game_layer", Layer.GAME);
    this.MonsterLayer = this.createLayer(scene, "monster_layer", Layer.MONSTER);
    this.EffectLayer = this.createLayer(scene, "effect_layer", Layer.EFFECT);
    this.UILayer = this.createLayer(scene, "ui_layer", Layer.UI);
  }

  /** 创建图层容器并挂到场景下 */
  private static createLayer(scene: Node, name: string, layer: Layer): Node {
    // 同一场景内重复初始化时，先移除仍然有效的旧同名容器，避免出现两份
    const existed = scene.getChildByName(name);
    if (existed && isValid(existed)) existed.removeFromParent();
    const node = new Node(name);
    scene.addChild(node);
    // 容器自身与后续动态新增的子节点都对齐到该图层
    this.setNodeToLayer(node, layer);
    return node;
  }

  /** 清除地图层 */
  static clearMapLayer() {
    if (isValid(this.MapLayer)) this.MapLayer.removeAllChildren();
  }

  /** 添加元素至地图层 */
  static addToMapLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MAP);
    this.MapLayer.addChild(node);
  }

  /** 添加元素至游戏层 */
  static addToGameLayer(node: Node) {
    this.setNodeToLayer(node, Layer.GAME);
    this.GameLayer.addChild(node);
  }

  /** 清除掉落层 */
  static clearDropLayer() {
    if (isValid(this.DropLayer)) this.DropLayer.removeAllChildren();
  }

  /** 添加元素至掉落层 */
  static addToDropLayer(node: Node) {
    this.setNodeToLayer(node, Layer.DROP);
    this.DropLayer.addChild(node);
  }

  /** 清除怪物层 */
  static clearMonsterLayer() {
    if (isValid(this.MonsterLayer)) this.MonsterLayer.removeAllChildren();
  }

  /** 添加元素至怪物层 */
  static addToMonsterLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MONSTER);
    this.MonsterLayer.addChild(node);
  }

  /** 添加元素至特效层 */
  static addToEffectLayer(node: Node) {
    this.setNodeToLayer(node, Layer.EFFECT);
    this.EffectLayer.addChild(node);
  }

  /** 添加元素至UI层 */
  static addToUILayer(node: Node) {
    this.setNodeToLayer(node, Layer.UI);
    this.UILayer.addChild(node);
  }

  /** 地图与UI层跟随角色移动 */
  static move(position: Vec3) {
    // 场景切换过程中容器可能已销毁，校验后再使用
    if (isValid(this.UILayer)) this.UILayer.setWorldPosition(position);
    if (!this.camera || !isValid(this.camera.node)) return;
    const cameraPosition = this.camera.node.getWorldPosition();
    this.camera.node.setWorldPosition(position.x, position.y, cameraPosition.z);
  }

  /**
   * 屏幕坐标点是否落在 UI 层元素上
   * 用途：世界点击（选中怪物/拾取掉落物）据此忽略 UI 上的点击，避免点界面时打断角色正在进行的操作
   * 判定细节见 utils/input/UiHit
   * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
   */
  static isPointOnUi(screenPoint: Vec2): boolean {
    return uiHitTest(this.UILayer, screenPoint);
  }
}
