import { Node, Size, Vec2 } from "cc";
import GameRoleUiHelper from "../GameRoleUiHelper";
import LayerHelper from "../LayerHelper";
import UiHelper from "../UiHelper";
import { bagCol, bagRow } from "../../configs";

interface RoleBagDialog {
  dialog: Node | null;
  // 背包节点列表
  grids: Node[][];
  open: Function;
  close: Function;
}

const RoleBagDialog: RoleBagDialog = {
  // 节点
  dialog: null,
  // 背包节点列表
  grids: [],
  // 打开
  open() {
    if (RoleBagDialog.dialog && RoleBagDialog.dialog.active) RoleBagDialog.close();
    else {
      RoleBagDialog.dialog = GameRoleUiHelper.createDialog("bag_dialog", "背包");
      LayerHelper.addToUILayer(RoleBagDialog.dialog);
      const bag = UiHelper.createFlexCol(3, new Vec2(0, 17), new Size(580, 368));
      LayerHelper.setLayerToUILayer(bag);
      for (let row = 0; row < bagRow; row++) {
        RoleBagDialog.grids[row] = [];
        const rowNode = UiHelper.createFlexRow(3, new Vec2(0, 0), new Size(580, 50));
        LayerHelper.setLayerToUILayer(rowNode);
        for (let col = 0; col < bagCol; col++) {
          const grid = UiHelper.createSprite("common/grid", new Vec2(), new Size(50, 50));
          LayerHelper.setLayerToUILayer(grid);
          RoleBagDialog.grids[row][col] = grid;
          rowNode.addChild(grid);
        }
        bag.addChild(rowNode);
      }
      RoleBagDialog.dialog.addChild(bag);
      // 添加整理按钮
    }
  },
  // 关闭
  close() {
    RoleBagDialog.grids.length = 0;
    RoleBagDialog.dialog.destroy();
    RoleBagDialog.dialog = null;
  },
};

export default RoleBagDialog;
