import { Node, Size, Vec2 } from "cc";
import StorageHelper from "../helpers/StorageHelper";
import RoleBagUiHelper from "../helpers/RoleBagUiHelper";
import { Role } from "../../configs/role";
import { Goods, EQUIPMENT_TYPE } from "../../types/common";

interface RoleBagDialog {
  dialog: Node | null;
  // 背包节点列表
  cells: Node[][];
  // 角色信息
  role: Role | null;
  open: Function;
  close: Function;
  // 读取背包数据并显示
  readBagDataAndShow: Function;
  // 使用物品
  useGood: (cell: Node, good: Goods) => void;
}

const RoleBagDialog: RoleBagDialog = {
  // 节点
  dialog: null,
  // 背包节点列表
  cells: [],
  // 角色信息
  role: null,
  // 打开
  open() {
    // 打开时读取角色信息
    RoleBagDialog.role = StorageHelper.findOnlineRole();
    if (RoleBagDialog.dialog && RoleBagDialog.dialog.active) RoleBagDialog.close();
    else {
      const { dialog, cells } = RoleBagUiHelper.createRoleBag();
      RoleBagDialog.dialog = dialog;
      RoleBagDialog.cells = cells;
      // 读取背包数据并显示
      RoleBagDialog.readBagDataAndShow();
    }
  },
  // 读取背包数据并显示
  readBagDataAndShow() {
    RoleBagDialog.role.bag.forEach((row, rowIndex) => {
      row.forEach((good, colIndex) => {
        if (good) {
          RoleBagUiHelper.createGood(RoleBagDialog.cells[rowIndex][colIndex], good);
          // 添加点击事件
          RoleBagDialog.cells[rowIndex][colIndex].on(
            Node.EventType.TOUCH_END,
            () => {
              RoleBagDialog.useGood(RoleBagDialog.cells[rowIndex][colIndex], good);
            },
            this,
          );
        }
      });
    });
  },
  // 使用物品
  useGood(cell, good) {
    switch (good.type) {
      case EQUIPMENT_TYPE.CLOTH:
      case EQUIPMENT_TYPE.ACCESSORIES:
      case EQUIPMENT_TYPE.BELT:
      case EQUIPMENT_TYPE.HELMET:
      case EQUIPMENT_TYPE.NECKLACE:
      case EQUIPMENT_TYPE.RING:
      case EQUIPMENT_TYPE.SCAPULAR:
      case EQUIPMENT_TYPE.SHINGUARD:
      case EQUIPMENT_TYPE.SHOES:
      case EQUIPMENT_TYPE.WEAPON:
      case EQUIPMENT_TYPE.WRISTBAND:
      case EQUIPMENT_TYPE.OTHER1:
      case EQUIPMENT_TYPE.OTHER2:
        StorageHelper.changeEquipment(good);
        break;
    }
  },
  // 关闭
  close() {
    RoleBagDialog.cells.length = 0;
    RoleBagDialog.dialog.destroy();
    RoleBagDialog.dialog = null;
  },
};

export default RoleBagDialog;
