import { Camera, Node, Vec2, Vec3 } from "cc";
import RoleDisplayFrame from "../components/RoleDisplayFrame";

enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  GAME = 1 << 2,
  EFFECT = 1 << 3,
  UI = 1 << 4,
}

const LayerManager = {
  /** 循环元素下所有元素添加至指定图层 */
  setNodeToLayer(node: Node, layer: Layer) {
    node.layer = layer;
    node.children.forEach((child) => {
      LayerManager.setNodeToLayer(child, layer);
    });
  },

  /** 地图层 */
  MapLayer: new Node("map_layer"),
  /** 初始化地图层 */
  initMapLayer(scene: Node) {
    LayerManager.MapLayer.layer = Layer.MAP;
    scene.addChild(LayerManager.MapLayer);
  },
  /** 清除地图层 */
  clearMapLayer() {
    LayerManager.MapLayer.removeAllChildren();
  },
  /** 添加地图 */
  addToMapLayer(node: Node) {
    LayerManager.setNodeToLayer(node, Layer.MAP);
    LayerManager.MapLayer.addChild(node);
  },

  /** 游戏层 */
  GameLayer: new Node("game_layer"),
  /** 初始化游戏层 */
  initGameLayer(scene: Node) {
    LayerManager.GameLayer.layer = Layer.GAME;
    scene.addChild(LayerManager.GameLayer);
    RoleDisplayFrame.init();
  },
  /** 添加元素至游戏层 */
  addToGameLayer(node: Node) {
    LayerManager.setNodeToLayer(node, Layer.MAP);
    LayerManager.GameLayer.addChild(node);
  },

  /** 特效层 */
  EffectLayer: new Node("effect_layer"),
  /** 初始化特效层 */
  initEffectLayer(scene: Node) {
    LayerManager.EffectLayer.layer = Layer.EFFECT;
    scene.addChild(LayerManager.EffectLayer);
  },
  /** 给特效层添加元素 */
  addToEffectLayer(node: Node) {
    node.layer = Layer.EFFECT;
    LayerManager.EffectLayer.addChild(node);
  },

  /** UI层 */
  UILayer: new Node("ui_layer"),
  /** 初始化UI层 */
  initUiLayer(scene: Node) {
    LayerManager.UILayer.layer = Layer.UI;
    scene.addChild(LayerManager.UILayer);
  },
  /** 给UI层添加元素 */
  addToUILayer(node: Node) {
    LayerManager.setNodeToLayer(node, Layer.UI);
    LayerManager.UILayer.addChild(node);
  },

  // 移动
  move(position: Vec3) {
    LayerManager.UILayer.setWorldPosition(position);
    const cameraPosition = LayerManager.camera.node.getWorldPosition();
    LayerManager.camera.node.setWorldPosition(position.x, position.y, cameraPosition.z);
  },

  // 相机
  camera: null,

  // 初始化图层
  initLayer(scene: Node, camera: Camera) {
    LayerManager.camera = camera;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP;
    /** 初始化所有图层 */
    LayerManager.initMapLayer(scene);
    LayerManager.initGameLayer(scene);
    LayerManager.initEffectLayer(scene);
    LayerManager.initUiLayer(scene);
  },
};

export default LayerManager;
