import { Camera, Node, Vec3 } from "cc";

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
 * 负责场景内各渲染图层（地图层/怪物层/游戏层/特效层/UI层）的初始化与元素挂载
 */
export default class LayerManager {
  /** 相机（初始化后可用） */
  static camera: Camera | null = null;

  /** 地图层 */
  static MapLayer: Node = new Node("map_layer");
  /** 游戏层 */
  static GameLayer: Node = new Node("game_layer");
  /** 怪物层 */
  static MonsterLayer: Node = new Node("monster_layer");
  /** 特效层 */
  static EffectLayer: Node = new Node("effect_layer");
  /** UI层 */
  static UILayer: Node = new Node("ui_layer");

  /** 循环元素下所有元素添加至指定图层 */
  static setNodeToLayer(node: Node, layer: Layer) {
    node.layer = layer;
    node.children.forEach((child) => {
      this.setNodeToLayer(child, layer);
    });
  }

  /** 初始化所有图层（图层容器为静态节点，会随上一个场景销毁，进入新场景时必须重建） */
  static initLayer(scene: Node, camera: Camera) {
    this.camera = camera;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP | Layer.GAME | Layer.MONSTER;
    this.initMapLayer(scene);
    this.initGameLayer(scene);
    this.initMonsterLayer(scene);
    this.initEffectLayer(scene);
    this.initUiLayer(scene);
  }

  /** 初始化地图层 */
  private static initMapLayer(scene: Node) {
    this.MapLayer.layer = Layer.MAP;
    scene.addChild(this.MapLayer);
  }

  /** 清除地图层 */
  static clearMapLayer() {
    this.MapLayer.removeAllChildren();
  }

  /** 添加元素至地图层 */
  static addToMapLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MAP);
    this.MapLayer.addChild(node);
  }

  /** 初始化游戏层 */
  private static initGameLayer(scene: Node) {
    this.GameLayer.layer = Layer.GAME;
    scene.addChild(this.GameLayer);
  }

  /** 添加元素至游戏层 */
  static addToGameLayer(node: Node) {
    this.setNodeToLayer(node, Layer.GAME);
    this.GameLayer.addChild(node);
  }

  /** 初始化怪物层 */
  private static initMonsterLayer(scene: Node) {
    this.MonsterLayer.layer = Layer.MONSTER;
    scene.addChild(this.MonsterLayer);
  }

  /** 清除怪物层 */
  static clearMonsterLayer() {
    this.MonsterLayer.removeAllChildren();
  }

  /** 添加元素至怪物层 */
  static addToMonsterLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MONSTER);
    this.MonsterLayer.addChild(node);
  }

  /** 初始化特效层 */
  private static initEffectLayer(scene: Node) {
    this.EffectLayer.layer = Layer.EFFECT;
    scene.addChild(this.EffectLayer);
  }

  /** 添加元素至特效层 */
  static addToEffectLayer(node: Node) {
    node.layer = Layer.EFFECT;
    this.EffectLayer.addChild(node);
  }

  /** 初始化UI层 */
  private static initUiLayer(scene: Node) {
    this.UILayer.layer = Layer.UI;
    scene.addChild(this.UILayer);
  }

  /** 添加元素至UI层 */
  static addToUILayer(node: Node) {
    this.setNodeToLayer(node, Layer.UI);
    this.UILayer.addChild(node);
  }

  /** 地图与UI层跟随角色移动 */
  static move(position: Vec3) {
    this.UILayer.setWorldPosition(position);
    if (!this.camera) return;
    const cameraPosition = this.camera.node.getWorldPosition();
    this.camera.node.setWorldPosition(position.x, position.y, cameraPosition.z);
  }
}
