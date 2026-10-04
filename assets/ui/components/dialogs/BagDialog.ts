import { isValid, Label, Node } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import BagGridView, { BagCellAction } from "../panel/BagGridView";
import { bagDialogLayout } from "../../../configs/hudLayout";

/**
 * 背包弹窗
 * 只负责开关与组装（弹窗框 + 背包格子网格 + 底部按钮），并把界面操作翻译成数据层调用：
 * - 左键（触屏点击）→ 使用物品：StorageManager.useGood 按物品大类分发（装备穿戴 / 药品服用 / …）
 * - 右键 → 穿戴装备：StorageManager.equipFromBag（非装备会给出提示）
 * - 「一键整理」→ StorageManager.tidyBag（合并同类可叠加物 + 按等级/部位重排，规则在数据层与配置表）
 * - 「一键回收」→ StorageManager.recycleBagEquipments（背包里的装备整格换成绑定元宝，**两步确认**）
 * 物品的使用规则、成败提示统一在数据层，本类不做任何规则判断，新增物品用法只需改数据层
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
 */
export default class BagDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 背包格子网格 */
  private bagGrid: BagGridView | null = null;
  /** 回收按钮（两步确认要改它的文案，所以留引用） */
  private recycleButton: Node | null = null;
  /** 回收按钮是否处于「待确认」状态（第二次点击才真的回收） */
  private recyclePending = false;
  /** 待确认状态的超时定时器（到点自动复位，见 onRecycleClick） */
  private recycleConfirmTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.recycleButton = null;
    }
    // 弹窗框与背包格子由通用零件拼装
    const dialog = GameUiHelper.createDialog(bagDialogLayout.name, bagDialogLayout.title);
    // 底部「一键整理」：合并同类可叠加物并重排（搬运与提示都在数据层，这里只上报点击）
    const tidyButton = GameUiHelper.createMiddleButton(
      bagDialogLayout.tidyButton.name,
      bagDialogLayout.tidyButton.text,
      bagDialogLayout.tidyButton.position,
    );
    tidyButton.on(
      Node.EventType.TOUCH_END,
      () => {
        // 整理算法不改动存储时会返回 false，这里补一句反馈，免得玩家以为按钮没反应
        if (!StorageManager.tidyBag()) GameUiHelper.createTip("bag_tidy_noop_tip", "背包已经很整齐了");
      },
      this,
    );
    dialog.addChild(tidyButton);
    // 底部「一键回收」：回收不可撤销 → 两步确认（见 onRecycleClick）
    const recycleButton = GameUiHelper.createMiddleButton(
      bagDialogLayout.recycleButton.name,
      bagDialogLayout.recycleButton.text,
      bagDialogLayout.recycleButton.position,
    );
    recycleButton.on(Node.EventType.TOUCH_END, () => this.onRecycleClick(), this);
    dialog.addChild(recycleButton);
    this.recycleButton = recycleButton;
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

  /**
   * 「一键回收」点击：两步确认
   *
   * 回收把背包里的装备整格换成绑定元宝、**不可撤销**，所以不让一次点击就生效：
   * 1. 第一次点击：不改数据，只把件数与可得元宝报给玩家（浮动提示），按钮文案变「确认回收」；
   * 2. 期间再点一次：真的回收（入账与提示都在数据层）；
   * 3. 超时（confirmTimeout）或关掉弹窗：按钮文案复位 —— 下次点击重新从第 1 步开始。
   *
   * 分两步而不是弹一个确认框：不新增节点、不新增鼠标监听（按钮走工厂已登记防穿透），
   * 也避免「确认框盖在弹窗上又要处理层级与穿透」这类输入坑（见 utils/input 的按压归属）
   */
  private onRecycleClick() {
    if (!this.recyclePending) {
      const summary = StorageManager.getBagRecycleSummary();
      if (!summary.count) {
        GameUiHelper.createTip("bag_recycle_empty_tip", "背包里没有可回收的装备");
        return;
      }
      this.recyclePending = true;
      this.setRecycleButtonText(bagDialogLayout.recycleButton.confirmText);
      GameUiHelper.createTip(
        "bag_recycle_confirm_tip",
        `将回收 ${summary.count} 件装备，可得 ${summary.totalPrice} 绑定元宝（再点一次确认）`,
      );
      this.clearRecycleConfirmTimer();
      // 到点自动复位：免得「确认回收」一直挂着，被玩家无意再点
      this.recycleConfirmTimer = setTimeout(() => this.cancelRecycleConfirm(), bagDialogLayout.recycleButton.confirmTimeout);
      return;
    }
    // 确认回收：先复位按钮（回收会刷新背包网格，但按钮不在网格里，只是保持状态干净），再真的搬
    this.cancelRecycleConfirm();
    StorageManager.recycleBagEquipments();
  }

  /** 退出待确认状态：清定时器、复位文案（弹窗已销毁时只清状态，不碰节点） */
  private cancelRecycleConfirm() {
    this.clearRecycleConfirmTimer();
    if (!this.recyclePending) return;
    this.recyclePending = false;
    this.setRecycleButtonText(bagDialogLayout.recycleButton.text);
  }

  private clearRecycleConfirmTimer() {
    if (this.recycleConfirmTimer === null) return;
    clearTimeout(this.recycleConfirmTimer);
    this.recycleConfirmTimer = null;
  }

  /** 改回收按钮文案（按钮工厂把文字放在 `<按钮名>_label` 子节点上） */
  private setRecycleButtonText(text: string) {
    const button = this.recycleButton;
    if (!button || !isValid(button)) return;
    const label = button.getChildByName(`${bagDialogLayout.recycleButton.name}_label`)?.getComponent(Label);
    if (label) label.string = text;
  }

  /** 关闭弹窗 */
  close() {
    this.cancelRecycleConfirm();
    this.recycleButton = null;
    this.bagGrid = null;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
