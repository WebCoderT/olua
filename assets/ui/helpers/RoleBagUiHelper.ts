import { Node, Size, Sprite, UITransform, Vec2, Vec3 } from "cc";
import GameUiHelper from "./GameUiHelper";
import LayerHelper from "./LayerHelper";
import UiHelper from "./UiHelper";
import GameHelper from "../utils/GameHelper";
import { bagRow, bagCol } from "../../configs/game";
import { Goods } from "../../types/common";

const RoleBagUiHelper = {
  // 创建背包格子
  createRoleBagCell(row: number, col: number) {
    const grid = UiHelper.createSprite(`bag_slot_${row}_${col}`, "common/grid", new Vec2(), new Size(50, 50));
    LayerHelper.setLayerToUILayer(grid);
    return grid;
  },

  // 创建背包格子
  createRoleBagCellRow(parent: Node) {
    const cells = [];
    for (let row = 0; row < bagRow; row++) {
      cells[row] = [];
      const rowNode = UiHelper.createFlexRow(`bag_row_${row}`, 3, new Vec2(0, 0), new Size(580, 50));
      LayerHelper.setLayerToUILayer(rowNode);
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
    LayerHelper.setLayerToUILayer(bagGrid);
    const cells = RoleBagUiHelper.createRoleBagCellRow(bagGrid);
    return { bagGrid, cells };
  },

  // 创建背包UI
  createRoleBag() {
    const dialog = GameUiHelper.createDialog("bag_dialog", "背包");
    LayerHelper.addToUILayer(dialog);
    const { bagGrid, cells } = RoleBagUiHelper.createRoleBagCells();
    dialog.addChild(bagGrid);
    return { dialog, cells };
  },

  // 在某个格子上创建物品
  createGood(cell: Node, good: Goods) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    LayerHelper.setLayerToUILayer(sprite);
    cell.addChild(sprite);
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        const dialog = RoleBagUiHelper.showGoodDetail(cell, good);
        sprite.once(Node.EventType.MOUSE_LEAVE, () => dialog.destroy(), this);
      },
      this,
    );
  },

  // 鼠标移入物品，显示物品详情
  showGoodDetail(cell: Node, good: Goods) {
    const screenPosition = GameHelper.worldPositionToScreenPosition(cell.getWorldPosition());
    const detailDialog = GameUiHelper.createGoodDetailDialog(good, cell.getComponent(UITransform).contentSize, screenPosition);
    LayerHelper.addToUILayer(detailDialog);
    return detailDialog;
  },
};

export default RoleBagUiHelper;
