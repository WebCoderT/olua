import { isValid, Node } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import BagGridView, { BagCellAction } from "../panel/BagGridView";
import { bagDialogLayout } from "../../../configs/hudLayout";

/**
 * 背包弹窗
 * 只负责开关与组装（弹窗框 + 背包格子网格），并把手性格子的操作翻译成数据层调用：
 * - 左键（触屏点击）→ 使用物品：StorageManager.useGood 按物品大类分发（装备穿戴 / 药品服用 / …）
 * - 右键 → 穿戴装备：StorageManager.equipFromBag（非装备会给出提示）
 * 物品的使用规则、成败提示统一在数据层，本类不做任何规则判断，新增物品用法只需改数据层
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
 */
export default class BagDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 背包格子网格 */
  private bagGrid: BagGridView | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换中被销毁时清理残留引用
    if (this.dialog && !isValid(this.dialog)) {
      this.dialog = null;
      this.bagGrid = null;
    }
    // 弹窗框与背包格子由通用零件拼装
    const dialog = GameUiHelper.createDialog(bagDialogLayout.name, bagDialogLayout.title);
    this.bagGrid = new BagGridView((row, col, action) => this.onCellAction(row, col, action));
    this.bagGrid.refresh(StorageManager.findOnlineRole());
    dialog.addChild(this.bagGrid);
    this.dialog = dialog;
    LayerManager.addToUILayer(dialog);
  }

  /** 刷新背包（物品变更后调用，弹窗未打开时忽略） */
  refresh() {
    if (!this.dialog || !isValid(this.dialog) || !this.dialog.active) return;
    this.bagGrid?.refresh(StorageManager.findOnlineRole());
  }

  /** 格子操作：左键使用物品、右键穿戴装备（规则判定与提示都在数据层） */
  private onCellAction(row: number, col: number, action: BagCellAction) {
    if (action === "equip") StorageManager.equipFromBag(row, col);
    else StorageManager.useGood(row, col);
  }

  /** 关闭弹窗 */
  close() {
    this.bagGrid = null;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
