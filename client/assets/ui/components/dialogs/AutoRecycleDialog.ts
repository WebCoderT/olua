import { Label, Node, ScrollView, Size, Vec2 } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import BaseDialog from "./dialog-kit";
import CheckRow from "../panel/CheckRow";
import { summarizeBagRecycleBySelection, type BagRecycleSelection } from "../../../configs/items";
import {
  equipmentBySlot,
  equipmentSlotOrder,
  equipmentSlots,
  recycleLevelBands,
} from "../../../configs/equipments";
import type { EQUIPMENT_TYPE } from "../../../types/good";
import { autoRecycleDialogLayout, buttonTone, uiSize } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import * as AutoBagPrefs from "../../core/storage/auto-bag-prefs";

/**
 * 自动回收弹窗（#1289 重做；原 #1278 的「全部装备 + 可卖物品清单」下线）
 *
 * 勾选结构 = **部位 × 等级段**（用户拍板）：
 * · 每个装备部位一节，标题就是部位名（鞋子 / 武器 / 衣服……按管理端槽位排序）；
 * · 标题下方是该部位的等级段选项：`1-10级`、`11-15级`、`16-20级`……（段规则固定，见 recycleLevelBands）；
 * · **只有装备**：药品 / 升级卷轴等非装备物品不进清单 —— 不能勾选不该回收的东西；
 * · 没有装备数据的部位不出现（勾了也没东西可回收，列出来只会让人困惑）。
 *
 * 底部一排两个控件：
 * · 「一键回收」按当前勾选立即执行（两步确认 —— 回收不可撤销）；
 * · 「自动回收」开关（#1289）：开启后 AutoBagService 持续扫描背包，自动回收符合勾选的装备
 *   （偏好落盘 auto-bag-prefs，按角色分键）。
 */
export default class AutoRecycleDialog extends BaseDialog {
  /** 勾选行的节点名前缀（`<PREFIX><slot>_<bandMin>`，读当前勾选用；部位 key 不含下划线） */
  private static readonly ROW_PREFIX = "auto_recycle_band_";
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
    // 部位 × 等级段滚动清单（部位按管理端槽位排序；没有装备数据的部位不出现）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size, layout.list.rowSpacing, layout.list.padding);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const bands = recycleLevelBands();
    const slots = Array.from(equipmentSlotOrder.keys())
      .sort((a, b) => (equipmentSlotOrder.get(a) ?? 0) - (equipmentSlotOrder.get(b) ?? 0))
      .filter((slot) => (equipmentBySlot.get(slot as EQUIPMENT_TYPE)?.size ?? 0) > 0);
    for (const slot of slots) {
      const slotLabel = equipmentSlots.get(slot as EQUIPMENT_TYPE)?.label ?? slot;
      content.addChild(
        UiHelper.createLabel(
          `${AutoRecycleDialog.ROW_PREFIX}title_${slot}`,
          slotLabel,
          layout.sectionTitle.color,
          layout.sectionTitle.fontSize,
          new Vec2(0, 0),
          new Size(layout.list.size.width - layout.list.padding * 2, layout.sectionTitle.height),
        ),
      );
      for (const band of bands) {
        const row = new CheckRow(
          `${AutoRecycleDialog.ROW_PREFIX}${slot}_${band.min}`,
          getText("auto_recycle_band", { min: band.min, max: band.max }),
          (selection.slots[slot] ?? []).indexOf(band.min) !== -1,
          { width: layout.list.size.width - layout.list.padding * 2, height: layout.list.rowHeight, fontSize: layout.list.fontSize, color: layout.list.color },
          () => this.persist(role.id, this.currentSelection()),
        );
        content.addChild(row);
      }
    }
    dialog.addChild(list);
    // 底部一排：「一键回收」（两步确认）+ 「自动回收」开关
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
    const toggleRow = new CheckRow(
      layout.autoToggle.name,
      getText("label_bag_auto_recycle"),
      AutoBagPrefs.getAutoRecycle(role.id),
      { width: layout.autoToggle.width, height: layout.autoToggle.height, fontSize: layout.autoToggle.fontSize, color: layout.autoToggle.color },
      (checked) => AutoBagPrefs.setAutoRecycle(role.id, checked),
    );
    toggleRow.setPosition(layout.autoToggle.position.x, layout.autoToggle.position.y, 0);
    dialog.addChild(toggleRow);
  }

  /** 读滚动清单里当前的勾选（行节点名编码了 `部位_段下界`，勾选态在行自己身上） */
  private currentSelection(): BagRecycleSelection {
    const slots: Record<string, number[]> = {};
    const titlePrefix = `${AutoRecycleDialog.ROW_PREFIX}title_`;
    this.dialog
      ?.getChildByName(autoRecycleDialogLayout.list.name)
      ?.getComponent(ScrollView)
      ?.content?.children.forEach((row) => {
        if (!(row instanceof CheckRow) || !row.isChecked() || row.name.startsWith(titlePrefix)) return;
        const rest = row.name.slice(AutoRecycleDialog.ROW_PREFIX.length);
        const split = rest.lastIndexOf("_");
        if (split <= 0) return;
        const slot = rest.slice(0, split);
        const bandMin = Number(rest.slice(split + 1));
        if (!slot || !Number.isInteger(bandMin) || bandMin <= 0) return;
        (slots[slot] ??= []).push(bandMin);
      });
    return { slots };
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
    this.recycleButton = null;
  }
}
