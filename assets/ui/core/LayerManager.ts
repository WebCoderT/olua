import { Camera, isValid, Node, Vec3 } from "cc";

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
 * 图层容器为静态节点，会随场景销毁，因此每次进场景（initLayer）都必须重建
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

  /**
   * 初始化所有图层
   * 图层容器是静态节点，上个场景销毁时会被连带销毁，因此这里必须重建，
   * 不能把已销毁的旧容器再挂到新场景（会触发 Node.walk 读取 null children 崩溃）
   */
  static initLayer(scene: Node, camera: Camera) {
    this.camera = camera;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP | Layer.GAME | Layer.MONSTER;
    // 重建全部图层容器
    this.MapLayer = this.createLayer(scene, "map_layer", Layer.MAP);
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
    node.layer = layer;
    scene.addChild(node);
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
    node.layer = Layer.EFFECT;
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
}
