import { Node, Size, Sprite, UITransform, Vec2, Vec3 } from "cc";
import GameUiHelper from "./GameUiHelper";
import UiHelper from "./UiHelper";
import GameHelper from "../utils/GameHelper";
import { bagRow, bagCol } from "../../configs/game";
import { Goods } from "../../types/common";
import LayerManager from "../utils/LayerManager";

const RoleBagUiHelper = {
  // 创建背包格子
  createRoleBagCell(row: number, col: number) {
    const grid = UiHelper.createSprite(`bag_slot_${row}_${col}`, "common/grid", new Vec2(), new Size(50, 50));
    LayerManager.setLayerToUILayer(grid);
    return grid;
  },

  // 创建背包格子
  createRoleBagCellRow(parent: Node) {
    const cells = [];
    for (let row = 0; row < bagRow; row++) {
      cells[row] = [];
      const rowNode = UiHelper.createFlexRow(`bag_row_${row}`, 3, new Vec2(0, 0), new Size(580, 50));
      LayerManager.setLayerToUILayer(rowNode);
      parent.addChild(rowNode);
      for (let col = 0; col < bagCol; col++) {
        const cell = RoleBagUiHelper.createRoleBagCell(row, col);
        rowNode.addChild(cell);
        cells[row][col] = cell;
      }
    }
    return cells;
  },

  // 创建背包格子行的列
  createRoleBagCells() {
    const bagGrid = UiHelper.createFlexCol("bag_grid", 3, new Vec2(0, 17), new Size(580, 368));
    LayerManager.setLayerToUILayer(bagGrid);
    const cells = RoleBagUiHelper.createRoleBagCellRow(bagGrid);
    return { bagGrid, cells };
  },

  // 创建背包UI
  createRoleBag() {
    const dialog = GameUiHelper.createDialog("bag_dialog", "背包");
    LayerManager.addToUILayer(dialog);
    const { bagGrid, cells } = RoleBagUiHelper.createRoleBagCells();
    dialog.addChild(bagGrid);
    return { dialog, cells };
  },
};

export default RoleBagUiHelper;
