import { Node } from "cc";
import StorageManager from "../../core/StorageManager";
import { Goods, GOOD_TYPE, isEquipment } from "../../../types/good";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import BagGridView from "../panel/BagGridView";

/** 弹窗名称 */
const DIALOG_NAME = "bag_dialog";

/**
 * 背包弹窗
 * 只负责开关与组装（弹窗框 + 背包格子网格），物品使用规则由本类分发：
 * 装备 → 穿戴；药品 → 服用；其余类型在此扩展
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
 */
export default class BagDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 背包格子网格 */
  private bagGrid: BagGridView | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗框与背包格子由通用零件拼装
    const dialog = GameUiHelper.createDialog(DIALOG_NAME, "背包");
    this.bagGrid = new BagGridView((good, row, col) => this.useGood(good, row, col));
    this.bagGrid.refresh(StorageManager.findOnlineRole());
    dialog.addChild(this.bagGrid);
    this.dialog = dialog;
    LayerManager.addToUILayer(dialog);
  }

  /** 刷新背包（物品变更后调用，弹窗未打开时忽略） */
  refresh() {
    if (!this.dialog || !this.dialog.active) return;
    this.bagGrid?.refresh(StorageManager.findOnlineRole());
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
    this.bagGrid = null;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
