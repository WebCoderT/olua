import { Camera, Node } from "cc";

enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  MONSTER = 1 << 2,
  PLAYER = 1 << 3,
  EFFECT = 1 << 4,
  SKILL = 1 << 5,
  UI = 1 << 6,
}

interface LayerHelper {
  // ui层
  UILayer: Node;
  addToUILayer: (node: Node) => void;
  setLayerToUILayer: (node: Node) => Node;
  initLayer: (game: Node, camera: Camera) => void;
}

const LayerHelper: LayerHelper = {
  // UI层
  UILayer: new Node("ui_layer"),
  // 给UI层添加元素
  addToUILayer(node: Node) {
    node.layer = Layer.UI;
    LayerHelper.UILayer.addChild(node);
  },
  setLayerToUILayer(node: Node) {
    node.layer = Layer.UI;
    return node;
  },
  initLayer(game: Node, camera: Camera) {
    LayerHelper.UILayer.layer = Layer.UI;
    // l1|l2
    camera.visibility = Layer.UI;
    game.addChild(LayerHelper.UILayer);
  },
};

export default LayerHelper;
