import { isValid, Label, Node } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import BagGridView, { BagCellAction } from "../panel/BagGridView";
import ConfirmDialog from "./ConfirmDialog";
import { bagDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { BagCellPos } from "../../../types/good";

/**
 * 背包弹窗
 * 只负责开关与组装（弹窗框 + 背包格子网格 + 底部按钮），并把界面操作翻译成数据层调用：
 * - 左键（触屏点击）→ 使用物品：StorageManager.useGood 按物品大类分发（装备穿戴 / 药品服用 / …）
 * - 右键 → 穿戴装备：StorageManager.equipFromBag（非装备会给出提示）
 * - 「一键整理」→ StorageManager.tidyBag（合并同类可叠加物 + 按等级/部位重排，规则在数据层与配置表）
 * - 「一键回收」→ StorageManager.recycleBagEquipments（背包里的装备整格换成绑定元宝，**两步确认**）
 * - 「丢弃」按钮 → 开关丢弃模式，开启后点格子里的物品即丢弃该格（**两步确认**，不可恢复）
 * - **把物品拖到弹窗外面松手** → 弹全屏确认框（确定 = 销毁该格、取消 = 物品回原位，见 onDropOutside）
 * - 按住物品拖到别的格子 → StorageManager.moveBagGood（空格=移动 / 同种可叠加=合并 / 其余=交换；
 *   手势与幽灵图标在 BagGridView 里，落点规则在数据层）
 * 物品的使用/丢弃/搬运规则、成败提示统一在数据层，本类不做任何规则判断，新增物品用法只需改数据层
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
  /** 回收待确认的超时定时器（到点自动复位，见 onRecycleClick） */
  private recycleConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** 丢弃按钮（开关式：进入/退出丢弃模式时改它的文案） */
  private discardButton: Node | null = null;
  /** 是否处于丢弃模式（开启后点击格子 = 丢弃，不再使用/穿戴） */
  private discardMode = false;
  /** 待确认丢弃的格子（两步确认的第一步之后有值，见 onDiscardCell） */
  private pendingDiscard: { row: number; col: number } | null = null;
  /** 丢弃待确认的超时定时器（到点自动放弃） */
  private discardConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** 拖出弹窗后弹出的销毁确认框（全屏模态，挂 UI 层顶层；同一时刻最多一个） */
  private confirmDialog: ConfirmDialog | null = null;

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
      this.discardButton = null;
    }
    // 兜底复位待确认状态与定时器（关弹窗时已清过，这里防场景切换等异常路径残留）
    this.cancelRecycleConfirm();
    this.discardMode = false;
    this.clearDiscardPending();
    this.closeDiscardConfirm();
    // 弹窗框与背包格子由通用零件拼装
    const dialog = GameUiHelper.createDialog(bagDialogLayout.name, bagDialogLayout.title);
    // 底部「一键整理」：合并同类可叠加物并重排（搬运与提示都在数据层，这里只上报点击）
    const tidyButton = GameUiHelper.createMiddleButton(
      bagDialogLayout.tidyButton.name,
      getText("label_bag_tidy"),
      bagDialogLayout.tidyButton.position,
    );
    tidyButton.on(
      Node.EventType.TOUCH_END,
      () => {
        // 底部按钮与丢弃模式互斥：先退出丢弃模式，免得整理完再点格子又丢东西
        this.exitDiscardMode();
        // 整理算法不改动存储时会返回 false，这里补一句反馈，免得玩家以为按钮没反应
        if (!StorageManager.tidyBag()) GameUiHelper.createTip("bag_tidy_noop_tip");
      },
      this,
    );
    dialog.addChild(tidyButton);
    // 底部「一键回收」：回收不可撤销 → 两步确认（见 onRecycleClick）
    const recycleButton = GameUiHelper.createMiddleButton(
      bagDialogLayout.recycleButton.name,
      getText("label_bag_recycle"),
      bagDialogLayout.recycleButton.position,
    );
    recycleButton.on(
      Node.EventType.TOUCH_END,
      () => {
        this.exitDiscardMode();
        this.onRecycleClick();
      },
      this,
    );
    dialog.addChild(recycleButton);
    this.recycleButton = recycleButton;
    // 底部「丢弃」：开关式（开启后点格子即丢弃，不可恢复 → 两步确认见 onDiscardCell）
    const discardButton = GameUiHelper.createMiddleButton(
      bagDialogLayout.discardButton.name,
      getText("label_bag_discard"),
      bagDialogLayout.discardButton.position,
    );
    discardButton.on(Node.EventType.TOUCH_END, () => this.toggleDiscardMode(), this);
    dialog.addChild(discardButton);
    this.discardButton = discardButton;
    this.bagGrid = new BagGridView(
      (row, col, action) => this.onCellAction(row, col, action),
      // 受理区 = 弹窗自身：把物品拖到它外面松手即「要销毁」（确认框见 onDropOutside）
      { area: dialog, onDropOutside: (from) => this.onDropOutside(from) },
    );
    this.bagGrid.refresh(StorageManager.findOnlineRole());
    dialog.addChild(this.bagGrid);
    // 网格区域的触摸被自己收住（拖动不传给弹窗背景，见 BagGridView.setupTouchOwnership），
    // 于是这次 TOUCH_START 到不了弹窗根 —— 在网格上再挂一次「点到我 = 所属弹窗置顶」
    // （鼠标通道不受影响：MOUSE_DOWN 照旧冒泡到弹窗根，这里只是把触摸通道补齐）
    GameUiHelper.bindDialogRaiseOnPress(this.bagGrid);
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
  }

  /** 刷新背包（物品变更后调用，弹窗未打开时忽略） */
  refresh() {
    if (!this.dialog || !isValid(this.dialog) || !this.dialog.active) return;
    // 背包内容一变，之前「待确认」的两份状态就都不可信了：回收报出的件数/元宝、要丢弃的那一格
    // （拖动物品可能把目标格的东西换走或挪走），一律先复位 —— 宁可让玩家重点一次，也不误伤
    this.cancelRecycleConfirm();
    this.clearDiscardPending();
    // 拖出弹窗、正等销毁确认的那件物品同理：格子即将重建，先放开扣留（恢复不透明度，之后节点即销毁）
    this.bagGrid?.releaseDiscardHold();
    this.bagGrid?.refresh(StorageManager.findOnlineRole());
  }

  /**
   * 格子操作：丢弃模式下点格子 = 丢弃；否则左键使用物品、右键穿戴装备
   * 规则判定与提示都在数据层（本类只做模式分流）
   */
  private onCellAction(row: number, col: number, action: BagCellAction) {
    if (this.discardMode) {
      this.onDiscardCell(row, col);
      return;
    }
    if (action === "equip") StorageManager.equipFromBag(row, col);
    else StorageManager.useGood(row, col);
  }

  //#region 丢弃

  /**
   * 「丢弃」按钮：进入 / 退出丢弃模式
   *
   * 用模式开关而不是「长按物品」或「选中格子 + 确认框」：背包没有选中态，也不新增节点与鼠标监听
   * （确认框盖在弹窗上要处理层级与穿透，见 utils/input 的按压归属）；模式开启后点击目标就是格子本身，
   * 且按钮文案变「退出丢弃」，当前处于什么状态一眼可见
   */
  private toggleDiscardMode() {
    if (this.discardMode) {
      this.exitDiscardMode();
      return;
    }
    this.discardMode = true;
    this.setButtonText(this.discardButton, getText("label_bag_discard_exit"));
    GameUiHelper.createTip("bag_discard_mode_tip");
  }

  /** 退出丢弃模式：放弃待确认目标并复位按钮文案（关弹窗时不必调它，见 close） */
  private exitDiscardMode() {
    this.clearDiscardPending();
    if (!this.discardMode) return;
    this.discardMode = false;
    this.setButtonText(this.discardButton, getText("label_bag_discard"));
  }

  /**
   * 丢弃模式下点击格子：两步确认（与「一键回收」「删除角色」同一套口径）
   *
   * 丢弃不可恢复，所以不让一次点击就生效：
   * 1. 第一次点击：不改数据，只把物品名与整格数量报给玩家，并记住这一格；
   * 2. 3 秒内再点**同一格**：真的丢弃（数据层置空 → 落盘 → 刷新网格）；
   * 3. 超时、点了别的格子、退出丢弃模式、点整理/回收或关弹窗：放弃待确认 ——
   *    其中「点别的格子」直接换成新目标，免得玩家想改丢另一件时还得先等它超时
   */
  private onDiscardCell(row: number, col: number) {
    const preview = StorageManager.getBagDiscardPreview(row, col);
    if (!preview) {
      GameUiHelper.createTip("bag_discard_empty_tip");
      return;
    }
    const pending = this.pendingDiscard;
    if (pending && pending.row === row && pending.col === col) {
      // 第二步：确认丢弃（先复位待确认状态再改数据 —— 丢弃会刷新网格，格子节点随之重建）
      this.clearDiscardPending();
      StorageManager.discardBagGood(row, col);
      return;
    }
    // 第一步：记住这一格（点别的格子 = 换目标，先放弃上一个）
    this.clearDiscardPending();
    this.pendingDiscard = { row, col };
    GameUiHelper.createTip("bag_discard_confirm_tip", { name: preview.label, count: preview.count });
    // 到点自动放弃：免得「待确认」一直挂着，被玩家无意再点一次丢掉东西
    this.discardConfirmTimer = setTimeout(() => this.clearDiscardPending(), bagDialogLayout.discardButton.confirmTimeout);
  }

  /** 放弃待确认丢弃（清定时器 + 忘掉目标格；丢弃模式本身不受影响） */
  private clearDiscardPending() {
    if (this.discardConfirmTimer !== null) {
      clearTimeout(this.discardConfirmTimer);
      this.discardConfirmTimer = null;
    }
    this.pendingDiscard = null;
  }

  //#endregion

  //#region 拖出弹窗销毁（全屏确认框）

  /**
   * 把物品拖到背包弹窗**外面**松手：弹全屏确认框（确定 = 销毁整格，取消 = 物品回原位）
   *
   * 与「丢弃」按钮的两步确认目的相同（不可恢复的操作不让一次动作生效），形态不同：
   * 拖动松手是一次性动作 —— 没有可以再点一次的按钮或格子，只能立一个确认框问清楚。
   *
   * 「取消则物品回到原位」不需要任何复原动作：拖动期间**数据从未改过**，
   * 唯一被改的是源格物品的不透明度（拖动压暗 → 扣留保持压暗），取消时放开扣留即恢复原样。
   */
  private onDropOutside(from: BagCellPos) {
    // 前置校验借数据层的预览（空格 / 越界都返回 null）：没有可丢的东西就把扣留放开，安静收场
    const preview = StorageManager.getBagDiscardPreview(from.row, from.col);
    if (!preview) {
      this.bagGrid?.releaseDiscardHold();
      return;
    }
    // 保险：上一次的确认框还挂着（极端时序）先收掉，同一时刻只留一个
    this.closeDiscardConfirm();
    const confirm = new ConfirmDialog({
      title: getText("bag_discard_confirm_title"),
      message: getText("bag_discard_confirm_text", { name: preview.label, count: preview.count }),
      confirmText: getText("label_confirm_ok"),
      cancelText: getText("label_confirm_cancel"),
      // 确定：真的丢弃（落盘 + 刷新背包；扣留由 refresh 统一放开）
      onConfirm: () => {
        this.confirmDialog = null;
        StorageManager.discardBagGood(from.row, from.col);
      },
      // 取消：数据没动过，放开扣留就是「回到原位」
      onCancel: () => {
        this.confirmDialog = null;
        this.bagGrid?.releaseDiscardHold();
      },
    });
    this.confirmDialog = confirm;
    // 确认框自身是全屏模态（盖住整个屏幕并独占输入，见 ConfirmDialog）：挂在 UI 层顶层
    LayerManager.addDialogToUILayer(confirm);
  }

  /** 关掉销毁确认框（关背包弹窗 / 重复弹出前调用；没开着时什么也不做） */
  private closeDiscardConfirm() {
    this.confirmDialog?.destroy();
    this.confirmDialog = null;
  }

  //#endregion

  //#region 回收

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
        GameUiHelper.createTip("bag_recycle_empty_tip");
        return;
      }
      this.recyclePending = true;
      this.setButtonText(this.recycleButton, getText("label_bag_recycle_confirm"));
      GameUiHelper.createTip("bag_recycle_confirm_tip", { count: summary.count, price: summary.totalPrice });
      this.clearRecycleConfirmTimer();
      // 到点自动复位：免得「确认回收」一直挂着，被玩家无意再点
      this.recycleConfirmTimer = setTimeout(() => this.cancelRecycleConfirm(), bagDialogLayout.recycleButton.confirmTimeout);
      return;
    }
    // 确认回收：先复位按钮（回收会刷新背包网格，但按钮不在网格里，只是保持状态干净），再真的搬
    this.cancelRecycleConfirm();
    StorageManager.recycleBagEquipments();
  }

  /** 退出回收的待确认状态：清定时器、复位文案（弹窗已销毁时只清状态，不碰节点） */
  private cancelRecycleConfirm() {
    this.clearRecycleConfirmTimer();
    if (!this.recyclePending) return;
    this.recyclePending = false;
    this.setButtonText(this.recycleButton, getText("label_bag_recycle"));
  }

  private clearRecycleConfirmTimer() {
    if (this.recycleConfirmTimer === null) return;
    clearTimeout(this.recycleConfirmTimer);
    this.recycleConfirmTimer = null;
  }

  //#endregion

  /** 改按钮文案（按钮工厂把文字放在 `<按钮名>_label` 子节点上；按钮已销毁时静默跳过） */
  private setButtonText(button: Node | null, text: string) {
    if (!button || !isValid(button)) return;
    const label = button.getChildByName(`${button.name}_label`)?.getComponent(Label);
    if (label) label.string = text;
  }

  /** 关闭弹窗 */
  close() {
    this.cancelRecycleConfirm();
    // 退出丢弃模式：先清待确认与定时器；节点即将销毁，不必再改按钮文案
    this.clearDiscardPending();
    this.discardMode = false;
    // 销毁确认框挂在 UI 层（不随弹窗销毁），必须显式收掉 —— 否则留一个盖住屏幕的模态黑幕
    this.closeDiscardConfirm();
    // 拖动中关弹窗：幽灵与落点高亮挂在弹窗下会随弹窗销毁，这里先让网格把拖动状态收干净
    this.bagGrid?.cancelDrag();
    this.recycleButton = null;
    this.discardButton = null;
    this.bagGrid = null;
    this.dialog?.destroy();
    this.dialog = null;
  }
}
