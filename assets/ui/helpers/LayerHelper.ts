import { Camera, Node, Vec2, Vec3 } from "cc";

enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  MONSTER = 1 << 2,
  ROLE = 1 << 3,
  EFFECT = 1 << 4,
  SKILL = 1 << 5,
  UI = 1 << 6,
}

const LayerHelper = {
  // UI层
  UILayer: new Node("ui_layer"),
  // 给UI层添加元素
  addToUILayer(node: Node) {
    node.layer = Layer.UI;
    LayerHelper.UILayer.addChild(node);
  },
  // 设置node节点图层为UI层
  setLayerToUILayer(node: Node) {
    node.layer = Layer.UI;
    return node;
  },

  // 其他角色层
  RoleLayer: new Node("role_layer"),
  // 给其他角色层添加元素
  addToRoleLayer: function (node: Node): void {
    node.layer = Layer.ROLE;
    LayerHelper.RoleLayer.addChild(node);
  },
  // 设置node节点为其他角色层
  setLayerToRoleLayer: function (node: Node): Node {
    node.layer = Layer.ROLE;
    return node;
  },

  // 特效层
  EffectLayer: new Node("effect_layer"),
  // 给特效层添加元素
  addToEffectLayer(node: Node) {
    node.layer = Layer.EFFECT;
    LayerHelper.EffectLayer.addChild(node);
  },

  // 地图层
  MapLayer: new Node("map_layer"),
  // 添加地图
  addToMapLayer(node: Node) {
    node.layer = Layer.MAP;
    LayerHelper.MapLayer.addChild(node);
  },
  // 设置节点图层为地图层
  setLayerToMapLayer(node: Node) {
    node.layer = Layer.MAP;
    return node;
  },

  // 移动
  move(position: Vec3) {
    LayerHelper.UILayer.setWorldPosition(position);
    const cameraPosition = LayerHelper.camera.node.getWorldPosition();
    LayerHelper.camera.node.setWorldPosition(position.x, position.y, cameraPosition.z);
  },

  // 相机
  camera: null,

  // 初始化图层
  initLayer(game: Node, camera: Camera) {
    LayerHelper.camera = camera;
    LayerHelper.MapLayer.layer = Layer.MAP;
    LayerHelper.UILayer.layer = Layer.UI;
    LayerHelper.RoleLayer.layer = Layer.ROLE;
    LayerHelper.EffectLayer.layer = Layer.EFFECT;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.ROLE | Layer.EFFECT | Layer.MAP;
    // 添加进游戏场景
    game.addChild(LayerHelper.MapLayer);
    game.addChild(LayerHelper.RoleLayer);
    game.addChild(LayerHelper.EffectLayer);
    game.addChild(LayerHelper.UILayer);
  },
};

export default LayerHelper;
