import { Color, Graphics, Label, Node, Size, UITransform, Vec2, isValid } from "cc";
import QuestStore from "../../core/QuestStore";
import type { QuestView } from "../../core/QuestStore";
import SoundManager from "../../core/SoundManager";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";
import { HAS_MOUSE, trackUiPress } from "../../utils/input/Pointer";
import { questTrackerLayout as layout } from "../../../configs/hudLayout";
import { buttonTone } from "../../../configs/hudLayout";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";

/**
 * 任务追踪栏（#396：屏幕左侧常驻，显示进行中的任务与进度）
 *
 * ## 为什么要有它
 * 任务系统最怕「接了但不知道去哪看进度」——面板要主动点开，而进度是在打怪时变化的。
 * 追踪栏把「现在做的事」摆在常驻 HUD 上：最多三条（可交付排最前），点一下就开面板。
 *
 * ## 两个入口（#1191，稿 04-hud）
 * - **整块点击** = 任务面板（接 / 交付都在那里）——原有行为；
 * - **标题行「详」按钮** = 任务详情弹窗（描述 / 进度条 / 奖励 / 交付 NPC 展开）——
 *   面板管「接交付」、详情管「看得懂」，两个入口并存。
 * 按钮注册了自己的 TOUCH_END 并挡穿透，不会冒泡成「整块点击」。
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
  /** 打开任务详情弹窗（#1191，BottomBar 持有的 QuestDetailDialog） */
  private readonly onOpenDetail: () => void;
  /** QuestStore 订阅（销毁时退订） */
  private unsubscribe: (() => void) | null = null;

  constructor(onOpen: () => void, onOpenDetail: () => void) {
    super("quest_tracker");
    this.onOpen = onOpen;
    this.onOpenDetail = onOpenDetail;
    this.setPosition(layout.position.x, layout.position.y);
    // 命中区：**必须先有 UITransform，再注册任何指针事件**。
    // 追踪栏是自己代码拼出来的 HUD（没有走 UiHelper.createNode），这个节点原本光秃秃的 —— 没有 UITransform，
    // 而引擎在每次指针派发前整理监听列表时会读 `trans!.cameraPriority`（非空断言），
    // 于是「节点在监听列表里 + 没有 UITransform」= 每次鼠标移动/点击都抛
    // `Cannot read properties of null (reading 'cameraPriority')`，整个游戏输入全部失效。
    // 尺寸按行数展开（行从原点往下排），锚点上对齐：命中区正好罩住最多 maxRows 行。
    // 参考 client/FAQ.md「鼠标一动就报 cameraPriority」。
    const hitArea = this.addComponent(UITransform);
    hitArea.setContentSize(layout.width, layout.head.height + layout.rowHeight * layout.maxRows);
    hitArea.setAnchorPoint(0.5, 1);
    // 点追踪栏 = 开任务面板（不穿透到世界，否则会顺带走一步）
    blockClickThrough(this);
    this.on(Node.EventType.TOUCH_END, () => this.onOpen(), this);
    // 点击音（#685）：整块追踪栏是「开任务面板」的按钮
    SoundManager.bindClick(this);
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

  /** 整块重画：标题行 + 进行中的任务（可交付排前，最多 layout.maxRows 条）+ 溢出提示 */
  private render() {
    if (!isValid(this)) return;
    clearChildren(this);
    const views = QuestStore.active();
    const rows = views.slice(0, layout.maxRows);
    // 一条可显示的都没有就整块收起来：命中区（上面那块 UITransform）是常驻的，
    // 节点还活动着就会让「点屏幕左侧那片空白」也打开任务面板（空态本来什么都不该留）
    this.active = rows.length > 0;
    if (!this.active) return;
    this.addHead(views.length);
    rows.forEach((view, index) => this.addRow(view, index));
    const overflow = views.length - rows.length;
    if (overflow > 0) {
      this.addLabel(
        "quest_tracker_more",
        layout.moreText.split("{count}").join(`${overflow}`),
        layout.moreColor,
        rows.length,
        layout.moreFontSize,
      );
    }
  }

  /**
   * 标题行（稿 `.quests .head`）：`任务` 13px 金-4 + `进行中 / 全部` 10px text-4 + 一条向右渐隐的细线
   * + 右端「详」按钮（#1191：直达任务详情弹窗，与整块点击开面板并存）
   * @param total 进行中的任务总数（计数左半）；分母取任务总表
   */
  private addHead(total: number) {
    const head = layout.head;
    const titleNode = UiHelper.createLabel(
      "quest_tracker_head_title",
      head.title,
      head.titleColor,
      head.titleFontSize,
      new Vec2(-layout.width / 2 + 20, -head.height / 2),
      new Size(50, 16),
      Label.HorizontalAlign.LEFT,
    );
    const title = titleNode.getComponent(Label);
    if (title) title.spacingX = head.titleSpacingX;
    this.addChild(titleNode);
    const count = QuestStore.views().length;
    this.addChild(
      UiHelper.createLabel(
        "quest_tracker_head_count",
        `${total} / ${count}`,
        head.countColor,
        head.countFontSize,
        new Vec2(-layout.width / 2 + head.countX + 20, -head.height / 2),
        new Size(60, 14),
        Label.HorizontalAlign.LEFT,
      ),
    );
    // 渐隐细线（稿 `linear-gradient(90deg,line-2,transparent)`）：右半段按列切条，alpha 递减；
    // 右缘前给「详」按钮留 endGap，细线不再顶到边（稿里细线是 flex:1 被按钮挤短，同义）
    const ruleLeft = -layout.width / 2 + 20 + head.rule.startOffset;
    const ruleRight = layout.width / 2 - (head.rule.endGap ?? 0);
    const ruleWidth = ruleRight - ruleLeft;
    const steps = 12;
    const stepWidth = ruleWidth / steps;
    const ruleNode = UiHelper.createNode("quest_tracker_head_rule", new Vec2(0, -head.height / 2), new Size(ruleWidth, 1));
    const graphics = ruleNode.addComponent(Graphics);
    for (let i = 0; i < steps; i++) {
      const tint = head.rule.color.clone();
      tint.a = Math.round(head.rule.color.a * (1 - (i + 0.5) / steps));
      if (tint.a <= 0) continue;
      graphics.fillColor = tint;
      graphics.rect(ruleLeft + i * stepWidth, -0.5, stepWidth + 0.5, 1);
      graphics.fill();
    }
    this.addChild(ruleNode);
    // 「详」按钮（金框小键）：按钮自己吃掉点击（挡穿透），不冒泡成整块的「开面板」
    const detail = GameUiHelper.createToneButton(
      "quest_tracker_detail_button",
      head.detailButton.text,
      new Vec2(layout.width / 2 - head.detailButton.size.width / 2, -head.height / 2),
      head.detailButton.size,
      head.detailButton.fontSize,
      buttonTone.gold,
    );
    blockClickThrough(detail);
    detail.on(Node.EventType.TOUCH_END, () => this.onOpenDetail(), this);
    this.addChild(detail);
  }

  /** 一行：任务名（左）+ 进度（右；可交付整行转绿）+ hover 淡染底（#1191，触屏不画） */
  private addRow(view: QuestView, index: number) {
    const ready = view.status === "ready";
    const progress = ready
      ? layout.texts.ready
      : layout.texts.progress.split("{done}").join(`${view.progress}`).split("{total}").join(`${view.target}`);
    const color = ready ? layout.readyColor : layout.nameColor;
    const y = -layout.head.height - layout.rowHeight / 2 - index * layout.rowHeight;
    // 行容器：底板 + 两段文字挂它下面；hover 高亮只重画底板，不重建文字
    const row = UiHelper.createNode(`quest_tracker_row_${view.quest.id}`, new Vec2(0, y), new Size(layout.width, layout.rowHeight));
    const hover = row.addComponent(Graphics);
    const paintHover = (on: boolean) => {
      hover.clear();
      if (!on) return;
      hover.fillColor = layout.rowHover;
      const half = layout.width / 2;
      const halfH = layout.rowHeight / 2;
      const r = layout.rowRadius;
      hover.moveTo(-half + r, -halfH);
      hover.lineTo(half - r, -halfH);
      hover.arc(half - r, -halfH + r, r, -Math.PI / 2, 0, false);
      hover.lineTo(half, halfH - r);
      hover.arc(half - r, halfH - r, r, 0, Math.PI / 2, false);
      hover.lineTo(-half + r, halfH);
      hover.arc(-half + r, halfH - r, r, Math.PI / 2, Math.PI, false);
      hover.lineTo(-half, -halfH + r);
      hover.arc(-half + r, -halfH + r, r, Math.PI, (3 * Math.PI) / 2, false);
      hover.close();
      hover.fill();
    };
    paintHover(false);
    row.addChild(
      UiHelper.createLabel(
        `quest_tracker_row_name_${view.quest.id}`,
        `${view.quest.label}`,
        color,
        layout.fontSize,
        new Vec2(-layout.width / 2 + (layout.width - 130) / 2, 0),
        new Size(layout.width - 130, layout.rowHeight),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    row.addChild(
      UiHelper.createLabel(
        `quest_tracker_row_progress_${view.quest.id}`,
        progress,
        ready ? layout.readyColor : layout.progressColor,
        layout.progressFontSize,
        new Vec2(layout.width / 2 - 60, 0),
        new Size(120, layout.rowHeight),
        Label.HorizontalAlign.RIGHT,
        Label.VerticalAlign.CENTER,
      ),
    );
    // hover 高亮只在有鼠标的环境有意义（触屏没有悬停态，画了也永远看不见）。
    // 行不挡点击（点行 = 冒泡给整块开面板），但 hover 监听要登记按压起点
    // （audit-ui-click-through：抬起会用到起点，没登记就吃到上一次按压的脏起点）
    if (HAS_MOUSE) {
      trackUiPress(row);
      row.on(Node.EventType.MOUSE_ENTER, () => paintHover(true), this);
      row.on(Node.EventType.MOUSE_LEAVE, () => paintHover(false), this);
    }
    this.addChild(row);
  }

  private addLabel(name: string, text: string, color: Color, y: number, fontSize: number, width = layout.width) {
    const label = UiHelper.createLabel(
      name,
      text,
      color,
      fontSize,
      new Vec2(-layout.width / 2 + width / 2, y),
      new Size(width, layout.rowHeight),
      Label.HorizontalAlign.LEFT,
    );
    this.addChild(label);
  }
}
