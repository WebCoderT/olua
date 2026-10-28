import { Color, Label, Node, Size, UITransform, Vec2, isValid } from "cc";
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
    // 命中区：**必须先有 UITransform，再注册任何指针事件**。
    // 追踪栏是自己代码拼出来的 HUD（没有走 UiHelper.createNode），这个节点原本光秃秃的 —— 没有 UITransform，
    // 而引擎在每次指针派发前整理监听列表时会读 `trans!.cameraPriority`（非空断言），
    // 于是「节点在监听列表里 + 没有 UITransform」= 每次鼠标移动/点击都抛
    // `Cannot read properties of null (reading 'cameraPriority')`，整个游戏输入全部失效。
    // 尺寸按行数展开（行从原点往下排），锚点上对齐：命中区正好罩住最多 maxRows 行。
    // 参考 client/FAQ.md「鼠标一动就报 cameraPriority」。
    const hitArea = this.addComponent(UITransform);
    hitArea.setContentSize(layout.width, layout.rowHeight * layout.maxRows);
    hitArea.setAnchorPoint(0.5, 1);
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
    // 一条可显示的都没有就整块收起来：命中区（上面那块 UITransform）是常驻的，
    // 节点还活动着就会让「点屏幕左侧那片空白」也打开任务面板（空态本来什么都不该留）
    this.active = rows.length > 0;
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
