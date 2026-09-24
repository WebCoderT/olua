import { Node, Size, Vec2 } from "cc";
import UiHelper from "./UiHelper";
import LayerHelper from "./LayerHelper";

const GameRoleUiHelper = {
  /**
   * 创建基础裸模
   */
  createBasicRole(): Node {
    const node = UiHelper.createSprite("role/0", new Vec2(), new Size(60, 70));
    LayerHelper.setLayerToRoleLayer(node);
    return node;
  },
};

export default GameRoleUiHelper;
