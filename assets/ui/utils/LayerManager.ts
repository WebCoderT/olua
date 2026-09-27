import { Camera, Node, Vec2, Vec3 } from "cc";
import RoleDisplayFrame from "../components/RoleDisplayFrame";

enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  MONSTER = 1 << 2,
  EFFECT = 1 << 3,
  SKILL = 1 << 4,
  UI = 1 << 5,
}

const LayerManager = {
  // 角色显示效果
  roleDisplay: RoleDisplayFrame,
  // UI层
  UILayer: new Node("ui_layer"),
  // 给UI层添加元素
  addToUILayer(node: Node) {
    node.layer = Layer.UI;
    LayerManager.UILayer.addChild(node);
  },
  // 设置node节点图层为UI层
  setLayerToUILayer(node: Node) {
    node.layer = Layer.UI;
    return node;
  },

  // 特效层
  EffectLayer: new Node("effect_layer"),
  // 给特效层添加元素
  addToEffectLayer(node: Node) {
    node.layer = Layer.EFFECT;
    LayerManager.EffectLayer.addChild(node);
  },

  // 地图层
  MapLayer: new Node("map_layer"),
  // 清除地图层
  clearMapLayer() {
    LayerManager.MapLayer.removeAllChildren();
  },
  // 添加地图
  addToMapLayer(node: Node) {
    node.layer = Layer.MAP;
    LayerManager.MapLayer.addChild(node);
  },
  // 设置节点图层为地图层
  setLayerToMapLayer(node: Node) {
    node.layer = Layer.MAP;
    return node;
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
  initLayer(game: Node, camera: Camera) {
    LayerManager.camera = camera;
    LayerManager.MapLayer.layer = Layer.MAP;
    LayerManager.UILayer.layer = Layer.UI;
    LayerManager.EffectLayer.layer = Layer.EFFECT;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP;
    // 添加进游戏场景
    game.addChild(LayerManager.MapLayer);
    // 初始化角色显示
    LayerManager.roleDisplay.init(game);
    game.addChild(LayerManager.EffectLayer);
    game.addChild(LayerManager.UILayer);
  },
};

export default LayerManager;
