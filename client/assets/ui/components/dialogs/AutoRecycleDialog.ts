import { Label, Node, ScrollView, Size, Vec2 } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import BaseDialog from "./dialog-kit";
import CheckRow from "../panel/CheckRow";
import { items, summarizeBagRecycleBySelection, type BagRecycleSelection } from "../../../configs/items";
import { isEquipment } from "../../../types/good";
import { autoRecycleDialogLayout, buttonTone, uiSize } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import * as AutoBagPrefs from "../../core/storage/auto-bag-prefs";

/**
 * 自动回收弹窗（#1278）
 *
 * 勾选清单 + 弹窗内「一键回收」：
 * · 「全部装备」整类开关（滚动区外常驻 —— 装备变体几百个 id，逐件勾不现实，
 *   回收语义又是整类换钱；这是自动回收的安全边界之一，得一直看得见）；
 * · 可卖非装备物品逐项勾选（药品 / 材料 / 货币 / 卷轴中回收价 > 0 的，与服务端 sellPriceOf 同源）；
 * · 「一键回收」按**当前勾选清单**立即执行（两步确认保留 —— 回收不可撤销）。
 *
 * 语义（挂在 DropManager 的 bag_full 拒绝上，见 AutoBagService.onBagFullRejected）：
 * 勾选后**背包满时自动回收勾选的物品**并自动重拾被拒的掉落物；**未勾选的永远不会被自动回收**。
 * 勾选偏好存本机、按角色分键（auto-bag-prefs），改动即落盘。
 */
export default class AutoRecycleDialog extends BaseDialog {
  /** 「全部装备」开关行（回填勾选态与读取当前态用） */
  private allEquipmentRow: CheckRow | null = null;
  /** 一键回收按钮（两步确认要改文案） */
  private recycleButton: Node | null = null;
  /** 一键回收是否处于待确认态 */
  private recyclePending = false;
  /** 待确认超时定时器 */
  private recycleConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  /** 打开/关闭弹窗（BaseDialog.toggle 语义：开着再点即关） */
  open() {
    this.openFrame(
      {
        name: autoRecycleDialogLayout.name,
        title: autoRecycleDialogLayout.title,
        eyebrow: autoRecycleDialogLayout.eyebrow,
        size: autoRecycleDialogLayout.size,
      },
      (dialog) => this.build(dialog),
    );
  }

  private build(dialog: Node) {
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    const selection = AutoBagPrefs.getRecycleSelection(role.id);
    const layout = autoRecycleDialogLayout;
    // 顶部说明行
    dialog.addChild(
      UiHelper.createLabel(
        `${layout.name}_hint`,
        getText("auto_recycle_hint"),
        layout.hint.color,
        layout.hint.fontSize,
        new Vec2(0, layout.hint.y),
        new Size(layout.hint.width, layout.hint.height),
      ),
    );
    // 「全部装备」整类开关（滚动区外，常驻可见）
    const allRow = new CheckRow(
      layout.allEquipmentRow.name,
      getText("auto_recycle_all_equipment"),
      selection.allEquipment,
      { width: layout.list.size.width, height: layout.allEquipmentRow.height, fontSize: layout.allEquipmentRow.fontSize, color: layout.allEquipmentRow.color },
      (checked) => this.persist(role.id, { allEquipment: checked, ids: this.currentIds() }),
    );
    allRow.setPosition(0, layout.allEquipmentRow.y, 0);
    dialog.addChild(allRow);
    this.allEquipmentRow = allRow;
    // 可卖非装备物品滚动清单（物品总表按注册序：药品 → 货币 → 卷轴 → 材料，过滤回收价 > 0）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size, layout.list.rowSpacing, layout.list.padding);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const sellables = [...items.values()].filter((good) => !isEquipment(good) && good.sellPirce > 0);
    if (!sellables.length) {
      dialog.addChild(
        UiHelper.createLabel(
          `${layout.name}_empty`,
          getText("auto_recycle_empty_list"),
          layout.emptyTip.color,
          layout.emptyTip.fontSize,
          layout.emptyTip.position,
          layout.emptyTip.size,
        ),
      );
    }
    for (const good of sellables) {
      const id = good.id ?? "";
      if (!id) continue;
      const row = new CheckRow(
        `${layout.list.name}_${id}`,
        good.label,
        selection.ids.has(id),
        { width: layout.list.size.width, height: layout.list.rowHeight, fontSize: layout.list.fontSize, color: layout.list.color },
        (checked) => {
          const ids = this.currentIds();
          if (checked) ids.add(id);
          else ids.delete(id);
          this.persist(role.id, { allEquipment: this.allEquipmentRow?.isChecked() ?? false, ids });
        },
      );
      content.addChild(row);
    }
    dialog.addChild(list);
    // 「一键回收」（两步确认，按当前勾选清单执行 —— 与自动回收同一套判定）
    const recycleButton = GameUiHelper.createToneButton(
      layout.recycleButton.name,
      getText("label_auto_recycle_now"),
      layout.recycleButton.position,
      new Size(160, 36),
      uiSize.middleButtonFontSize,
      buttonTone.gold,
    );
    recycleButton.on(Node.EventType.TOUCH_END, () => this.onRecycleClick(), this);
    dialog.addChild(recycleButton);
    this.recycleButton = recycleButton;
  }

  /** 读滚动清单里当前勾着的 id（行节点名编码了物品 id，勾选态在行自己身上） */
  private currentIds(): Set<string> {
    const ids = new Set<string>();
    const prefix = `${autoRecycleDialogLayout.list.name}_`;
    this.dialog?.getChildByName(autoRecycleDialogLayout.list.name)?.getComponent(ScrollView)?.content?.children.forEach((row) => {
      if (row instanceof CheckRow && row.isChecked() && row.name.startsWith(prefix)) {
        ids.add(row.name.slice(prefix.length));
      }
    });
    return ids;
  }

  /** 落盘当前勾选（按角色分键存本机） */
  private persist(roleId: string, selection: BagRecycleSelection): void {
    AutoBagPrefs.setRecycleSelection(roleId, selection);
  }

  /**
   * 「一键回收」点击：两步确认（回收不可撤销，与原背包按钮同一套口径）
   * 1. 第一次点击：不改数据，按当前勾选清单报件数与可得绑定元宝，按钮变「确认回收」；
   * 2. 期间再点一次：真的回收（结算在服务端）；
   * 3. 超时或关弹窗：复位。
   */
  private onRecycleClick() {
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    if (!this.recyclePending) {
      const summary = summarizeBagRecycleBySelection(role.bag, AutoBagPrefs.getRecycleSelection(role.id));
      if (!summary.count) {
        GameUiHelper.createTip("bag_recycle_empty_tip");
        return;
      }
      this.recyclePending = true;
      this.setButtonText(getText("label_bag_recycle_confirm"));
      GameUiHelper.createTip("bag_recycle_confirm_tip", { count: summary.count, price: summary.totalPrice });
      this.clearTimer();
      this.recycleConfirmTimer = setTimeout(() => this.resetRecycleButton(), autoRecycleDialogLayout.recycleButton.confirmTimeout);
      return;
    }
    this.resetRecycleButton();
    void StorageManager.recycleBySelection(AutoBagPrefs.getRecycleSelection(role.id)).then((result) => {
      if (result) GameUiHelper.createTip("bag_recycle_tip", { count: result.count, price: result.total });
    });
  }

  /** 复位按钮文案与待确认态（弹窗已销毁时只清状态不碰节点） */
  private resetRecycleButton() {
    this.clearTimer();
    if (!this.recyclePending) return;
    this.recyclePending = false;
    this.setButtonText(getText("label_auto_recycle_now"));
  }

  private clearTimer() {
    if (this.recycleConfirmTimer !== null) {
      clearTimeout(this.recycleConfirmTimer);
      this.recycleConfirmTimer = null;
    }
  }

  /** 改按钮文案（按钮工厂把文字放在 `<按钮名>_label` 子节点上；按钮已销毁时静默跳过） */
  private setButtonText(text: string) {
    if (!this.recycleButton || !this.recycleButton.isValid) return;
    const label = this.recycleButton.getChildByName(`${this.recycleButton.name}_label`)?.getComponent(Label);
    if (label) label.string = text;
  }

  protected onClose() {
    this.resetRecycleButton();
    this.allEquipmentRow = null;
    this.recycleButton = null;
  }
}
