import { Node, ScrollView, Size, Vec2 } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import BaseDialog from "./dialog-kit";
import CheckRow from "../panel/CheckRow";
import { items } from "../../../configs/items";
import { isDrug, isEquipment, isLevelScroll, isMoneyItem } from "../../../types/good";
import { autoUseDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import * as AutoBagPrefs from "../../core/storage/auto-bag-prefs";

/**
 * 自动使用弹窗（#1278）
 *
 * 可使用物品的勾选清单：药品 / 货币道具 / 升级卷轴逐项（**装备不进清单** ——
 * 自动穿戴是角色信息弹窗里的独立开关，勾了就自动穿，混在这里会让「穿戴」和「消耗」两种
 * 语义挤在同一个动作里）。材料「暂未开放使用」，天然不进候选。
 *
 * 语义（挂在 RoleUIManager.refreshBag 汇聚点上，见 AutoBagService.onBagChanged）：
 * 勾选后**背包里只要有就自动使用** —— 药品沿用「血蓝不满才喝得动」预检（满血满蓝本来
 * 就会被拒，自动路径静默跳过不刷提示）；货币 = 入账、卷轴 = +1 级。
 * 勾选偏好存本机、按角色分键（auto-bag-prefs），改动即落盘。
 */
export default class AutoUseDialog extends BaseDialog {

  /** 打开/关闭弹窗（BaseDialog.toggle 语义：开着再点即关） */
  open() {
    this.openFrame(
      {
        name: autoUseDialogLayout.name,
        title: autoUseDialogLayout.title,
        eyebrow: autoUseDialogLayout.eyebrow,
        size: autoUseDialogLayout.size,
      },
      (dialog) => this.build(dialog),
    );
  }

  private build(dialog: Node) {
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    const useIds = AutoBagPrefs.getUseIds(role.id);
    const layout = autoUseDialogLayout;
    // 顶部说明行
    dialog.addChild(
      UiHelper.createLabel(
        `${layout.name}_hint`,
        getText("auto_use_hint"),
        layout.hint.color,
        layout.hint.fontSize,
        new Vec2(0, layout.hint.y),
        new Size(layout.hint.width, layout.hint.height),
      ),
    );
    // 可使用物品滚动清单（物品总表按注册序：药品 → 货币 → 卷轴；装备与材料过滤掉）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size, layout.list.rowSpacing, layout.list.padding);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const usable = [...items.values()].filter((good) => !isEquipment(good) && (isDrug(good) || isMoneyItem(good) || isLevelScroll(good)));
    if (!usable.length) {
      dialog.addChild(
        UiHelper.createLabel(
          `${layout.name}_empty`,
          getText("auto_use_empty_list"),
          layout.emptyTip.color,
          layout.emptyTip.fontSize,
          layout.emptyTip.position,
          layout.emptyTip.size,
        ),
      );
    }
    for (const good of usable) {
      const id = good.id ?? "";
      if (!id) continue;
      const row = new CheckRow(
        `${layout.list.name}_${id}`,
        good.label,
        useIds.has(id),
        { width: layout.list.size.width, height: layout.list.rowHeight, fontSize: layout.list.fontSize, color: layout.list.color },
        (checked) => {
          const ids = AutoBagPrefs.getUseIds(role.id);
          if (checked) ids.add(id);
          else ids.delete(id);
          AutoBagPrefs.setUseIds(role.id, ids);
        },
      );
      content.addChild(row);
    }
    dialog.addChild(list);
  }
}
