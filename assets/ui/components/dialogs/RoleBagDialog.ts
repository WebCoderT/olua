import { Node } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { Goods, GOOD_TYPE, isEquipment } from "../../../types/good";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";

/**
 * 角色背包弹窗
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
 */
export default class RoleBagDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 背包节点列表 */
  private cells: Node[][] = [];
  /** 角色信息 */
  private role: Role | null = null;

  /** 打开/关闭弹窗 */
  open() {
    // 打开时读取角色信息
    this.role = StorageManager.findOnlineRole();
    if (this.dialog && this.dialog.active) {
      this.close();
    } else {
      // 弹窗框与背包格子由通用零件拼装
      const dialog = GameUiHelper.createDialog("bag_dialog", "背包");
      const { bagGrid, cells } = GameUiHelper.createRoleBagCells();
      dialog.addChild(bagGrid);
      this.dialog = dialog;
      this.cells = cells;
      // 读取背包数据并显示
      this.showBagData();
      LayerManager.addToUILayer(dialog);
    }
  }

  /** 刷新背包（物品变更后调用，弹窗未打开时忽略） */
  refresh() {
    if (!this.dialog || !this.dialog.active) return;
    this.role = StorageManager.findOnlineRole();
    this.showBagData();
  }

  /** 读取背包数据并填充格子 */
  private showBagData() {
    // 先清空旧内容，避免刷新时叠加（同时移除上一次注册的点击监听）
    this.cells.forEach((row) =>
      row.forEach((cell) => {
        cell.removeAllChildren();
        cell.targetOff(this);
      }),
    );
    this.role?.bag.forEach((row, rowIndex) => {
      row.forEach((good, colIndex) => {
        if (!good) return;
        const cell = this.cells[rowIndex][colIndex];
        GameUiHelper.createGood(cell, good);
        // 添加点击事件
        cell.on(
          Node.EventType.TOUCH_END,
          () => {
            this.useGood(good, rowIndex, colIndex);
          },
          this,
        );
      });
    });
  }

  /** 使用物品（按物品大类分发：装备穿戴、药品服用） */
  private useGood(good: Goods, row: number, col: number) {
    if (isEquipment(good)) {
      StorageManager.changeEquipment(good);
      return;
    }
    if (good.type === GOOD_TYPE.DRUG) {
      StorageManager.useDrug(row, col);
    }
  }

  /** 关闭弹窗 */
  close() {
    this.cells.length = 0;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
