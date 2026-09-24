import { Camera, Node } from "cc";

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

  // 角色层
  RoleLayer: new Node("role_layer"),
  // 给角色层添加元素
  addToRoleLayer: function (node: Node): void {
    node.layer = Layer.ROLE;
    LayerHelper.RoleLayer.addChild(node);
  },
  // 设置node节点为角色层
  setLayerToRoleLayer: function (node: Node): Node {
    node.layer = Layer.ROLE;
    return node;
  },

  // 初始化图层
  initLayer(game: Node, camera: Camera) {
    LayerHelper.UILayer.layer = Layer.UI;
    LayerHelper.RoleLayer.layer = Layer.ROLE;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.ROLE;
    // 添加进游戏场景
    game.addChild(LayerHelper.UILayer);
    game.addChild(LayerHelper.RoleLayer);
  },
};

export default LayerHelper;
