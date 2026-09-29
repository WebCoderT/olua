import { Node } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { Equipment, EQUIPMENT_TYPE, Goods } from "../../../types/good";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";

/** 可穿戴的装备类型集合 */
const wearableTypes = new Set<EQUIPMENT_TYPE>([
  EQUIPMENT_TYPE.CLOTH,
  EQUIPMENT_TYPE.ACCESSORIES,
  EQUIPMENT_TYPE.BELT,
  EQUIPMENT_TYPE.HELMET,
  EQUIPMENT_TYPE.NECKLACE,
  EQUIPMENT_TYPE.RING,
  EQUIPMENT_TYPE.SCAPULAR,
  EQUIPMENT_TYPE.SHINGUARD,
  EQUIPMENT_TYPE.SHOES,
  EQUIPMENT_TYPE.WEAPON,
  EQUIPMENT_TYPE.WRISTBAND,
  EQUIPMENT_TYPE.OTHER1,
  EQUIPMENT_TYPE.OTHER2,
]);

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
      this.readBagDataAndShow();
    }
  }

  /** 读取背包数据并显示 */
  private readBagDataAndShow() {
    this.role.bag.forEach((row, rowIndex) => {
      row.forEach((good, colIndex) => {
        if (good) {
          GameUiHelper.createGood(this.cells[rowIndex][colIndex], good);
          // 添加点击事件
          this.cells[rowIndex][colIndex].on(
            Node.EventType.TOUCH_END,
            () => {
              this.useGood(this.cells[rowIndex][colIndex], good);
            },
            this,
          );
        }
      });
    });
    LayerManager.addToUILayer(this.dialog);
  }

  /** 使用物品 */
  private useGood(cell: Node, good: Goods) {
    if (wearableTypes.has(good.type)) {
      StorageManager.changeEquipment(good as Equipment);
    }
  }

  /** 关闭弹窗 */
  close() {
    this.cells.length = 0;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
