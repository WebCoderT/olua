import { Color, Label, Node, Size, Vec2, isValid } from "cc";
import QuestStore from "../../core/QuestStore";
import type { QuestView } from "../../core/QuestStore";
import UiHelper from "../../helpers/UiHelper";
import { questTrackerLayout as layout } from "../../../configs/hudLayout";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";

/**
 * 任务追踪栏（#396：屏幕左侧常驻，显示进行中的任务与进度）
 *
 * ## 为什么要有它
 * 任务系统最怕「接了但不知道去哪看进度」——面板要主动点开，而进度是在打怪时变化的。
 * 追踪栏把「现在做的事」摆在常驻 HUD 上：最多三条（可交付排最前），点一下就开面板。
 *
 * ## 数据
 * 全部来自 `QuestStore`（订阅 onChange 就地重画）。这里**不发请求、不存状态**，
 * 重画是整块清空重建 —— 最多三行，比差量更新省心且不会漏。
 *
 * ## 与聊天气泡的位置关系
 * 聊天气泡从 y=290 往下、最多三条（到 222），追踪栏从 190 往下 —— 见
 * `configs/layout/hud` 的 questTrackerLayout 注释。
 */
export default class QuestTracker extends Node {
  /** 打开任务面板（由 BottomBar 持有的那个弹窗提供） */
  private readonly onOpen: () => void;
  /** QuestStore 订阅（销毁时退订） */
  private unsubscribe: (() => void) | null = null;

  constructor(onOpen: () => void) {
    super("quest_tracker");
    this.onOpen = onOpen;
    this.setPosition(layout.position.x, layout.position.y);
    // 点追踪栏 = 开任务面板（不穿透到世界，否则会顺带走一步）
    blockClickThrough(this);
    this.on(Node.EventType.TOUCH_END, () => this.onOpen(), this);
    this.unsubscribe = QuestStore.onChange(() => this.render());
    this.render();
  }

  /** 释放订阅（组合根在 Game.destroy 里调用，之后节点随场景销毁） */
  dispose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** 整块重画：进行中的任务（可交付排前，最多 layout.maxRows 条）+ 溢出提示 */
  private render() {
    if (!isValid(this)) return;
    clearChildren(this);
    const views = QuestStore.active();
    const rows = views.slice(0, layout.maxRows);
    rows.forEach((view, index) => this.addRow(view, index));
    const overflow = views.length - rows.length;
    if (overflow > 0) {
      this.addLabel(
        "quest_tracker_more",
        layout.moreText.split("{count}").join(`${overflow}`),
        layout.moreColor,
        rows.length,
      );
    }
  }

  /** 一行：任务名 + 进度（可交付整行转绿） */
  private addRow(view: QuestView, index: number) {
    const ready = view.status === "ready";
    const progress = ready
      ? layout.texts.ready
      : layout.texts.progress.split("{done}").join(`${view.progress}`).split("{total}").join(`${view.target}`);
    this.addLabel(`quest_tracker_row_${view.quest.id}`, `${view.quest.label}  ${progress}`, ready ? layout.readyColor : layout.nameColor, index);
  }

  private addLabel(name: string, text: string, color: Color, index: number) {
    const label = UiHelper.createLabel(
      name,
      text,
      color,
      layout.fontSize,
      new Vec2(0, -index * layout.rowHeight),
      new Size(layout.width, layout.rowHeight),
      Label.HorizontalAlign.LEFT,
    );
    this.addChild(label);
  }
}
