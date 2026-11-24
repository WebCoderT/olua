import { Graphics, Label, Node, Size, UITransform, Vec2, isValid } from "cc";
import MessageLogStore from "../../core/MessageLogStore";
import type { MessageLogEntry } from "../../core/MessageLogStore";
import SoundManager from "../../core/SoundManager";
import UiHelper from "../../helpers/UiHelper";
import { HAS_MOUSE, trackUiPress } from "../../utils/input/Pointer";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import { messageLogLayout as layout, T } from "../../../configs/hudLayout";

/**
 * 消息记录（#1224 建 / #1229 扩成个人流水：HUD 右下角常驻，稿 `design/olua-ui/screens/04-hud.html` 的 `.mlog`）
 *
 * ## 它显示什么
 * 与「我」相关的一切变化：经验 / 等级 / 货币 / 物品获得与消耗 / 成长（点数、四维、战力、技能、
 * 战魂、称号、军衔、装备、时装）/ 任务 / 系统提示；聊天对话不进这里 —— 聊天在左下常驻窗。
 * 标题行：标题 + 当前条数 / 上限 + 3px 容量条（满格转朱红）+ 收起钮；
 * 正文：最近 `rows.count` 条，每行「时间 + 分类标签 + 正文」；底部注明「不含聊天对话 / 满 1000 条自动清空」。
 * 分类是数据驱动的（`layout.rows.tagTexts` / `tagColors`）：加一类只改 configs/layout，本文件不动。
 *
 * ## 数据与生命周期
 * - 数据只在 `MessageLogStore`（纯内存：不落存档、不发请求，重新上线即清空）；
 * - 写入方主要是 `ui/core/storage/role-delta-log.ts`（角色数据差分），本类只读；
 * - 本类**不发请求、不存状态**，订阅 onChange 整块重画（最多 10 行，比差量更新省心且不会漏）；
 * - 离开游戏场景时组合根先 `dispose()` 再 `MessageLogStore.clear()`（#1188 口径：先退订再 reset，
 *   否则销毁期 emit 会摸到被 `_destruct` 置 null 的字段）。
 *
 * ## 交互
 * 面板整体挡穿透（点它不该顺带走一步）；只有右上角收起钮是按钮：点一下折到只剩标题行、再点展开。
 */
export default class MessageLog extends Node {
  /** MessageLogStore 订阅（销毁时退订） */
  private unsubscribe: (() => void) | null = null;
  /** 收起态（只影响本组件的显示，不进存档 —— 会话内即时生效即可） */
  private collapsed = false;
  /** 底板（本节点自带的 Graphics：面板框 + 铆钉 + 分隔线都画在这里） */
  private plate: Graphics;

  constructor() {
    super("message_log");
    const transform = this.addComponent(UITransform);
    transform.setContentSize(layout.size);
    // 面板整体挡穿透：命中区罩住整块，点消息记录不会顺带把角色走过去
    blockClickThrough(this);
    this.plate = this.addComponent(Graphics);
    this.unsubscribe = MessageLogStore.onChange(() => this.render());
    this.render();
  }

  /** 释放订阅（组合根在 Game.onDestroy 里调用，之后节点随场景销毁） */
  dispose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** 整块重画：底板 + 标题行（含计数/容量条/收起钮）+ 最近若干行 + 底部注释 */
  private render() {
    if (!isValid(this)) return;
    const width = layout.size.width;
    const height = this.collapsed ? layout.head.height : layout.size.height;
    const transform = this.getComponent(UITransform);
    if (transform) transform.setContentSize(width, height);
    // 底边不动地变高/变矮：稿里面板贴屏幕右下，收起时应当从顶部往下折（底边留在 bottom 处）
    this.setPosition(layout.position.x, layout.position.y - (layout.size.height - height) / 2);
    clearChildren(this);
    this.drawPlate(width, height);
    this.addHead(width, height);
    if (!this.collapsed) {
      this.addRows(width, height);
      this.addFoot(width, height);
    }
  }

  /** 底板：半透明面板 + 1px 金线 + 左上铆钉（稿 `.panel` / `.panel--rivet` 只留左上那颗） */
  private drawPlate(width: number, height: number) {
    this.plate.clear();
    this.plate.fillColor = layout.fill;
    this.plate.roundRect(-width / 2, -height / 2, width, height, layout.radius);
    this.plate.fill();
    this.plate.lineWidth = T.border.width;
    this.plate.strokeColor = layout.border;
    this.plate.roundRect(-width / 2, -height / 2, width, height, layout.radius);
    this.plate.stroke();
    this.plate.fillColor = layout.rivet.color;
    this.plate.circle(-width / 2 + layout.rivet.offset, height / 2 - layout.rivet.offset, layout.rivet.size / 2);
    this.plate.fill();
  }

  /** 标题行：标题 + `N / 1000` + 容量条 + 收起钮（稿 `.mlog-head`） */
  private addHead(width: number, height: number) {
    const head = layout.head;
    const left = -width / 2 + head.paddingX;
    const right = width / 2 - head.paddingX;
    const centerY = height / 2 - head.height / 2;
    // 标题（左对齐，金-4，字距同稿）
    const titleWidth = head.countX - 4;
    const title = UiHelper.createLabel(
      "message_log_head_title",
      head.title,
      head.titleColor,
      head.titleFontSize,
      new Vec2(left + titleWidth / 2, centerY),
      new Size(titleWidth, head.height),
      Label.HorizontalAlign.LEFT,
    );
    const titleLabel = title.getComponent(Label);
    if (titleLabel) titleLabel.spacingX = head.titleSpacingX;
    this.addChild(title);
    // 计数：当前条数（金）+ ` / 1000`（弱化）。数字右对齐到固定槽位，位数变化时后缀不跟着跳
    const count = MessageLogStore.count();
    this.addChild(
      UiHelper.createLabel(
        "message_log_head_count",
        `${count}`,
        head.countColor,
        head.countFontSize,
        new Vec2(left + head.countX + head.numWidth / 2, centerY),
        new Size(head.numWidth, head.height),
        Label.HorizontalAlign.RIGHT,
      ),
    );
    this.addChild(
      UiHelper.createLabel(
        "message_log_head_count_den",
        ` / ${MessageLogStore.CAPACITY}`,
        head.countDenColor,
        head.countFontSize,
        new Vec2(left + head.countX + head.numWidth + head.denWidth / 2, centerY),
        new Size(head.denWidth, head.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    this.addCapBar(left, right, centerY);
    this.addCollapseButton(right, centerY);
  }

  /** 容量条：常色金阶、满格转朱红（稿 `.capbar`；宽度吃掉计数与收起钮之间的剩余空间） */
  private addCapBar(left: number, right: number, centerY: number) {
    const bar = layout.head.bar;
    const barLeft = left + layout.head.countX + layout.head.numWidth + layout.head.denWidth + bar.gap;
    const barRight = right - layout.head.collapse.size.width - bar.gap;
    const barWidth = barRight - barLeft;
    if (barWidth <= 0) return;
    const node = UiHelper.createNode("message_log_cap_bar", new Vec2((barLeft + barRight) / 2, centerY), new Size(barWidth, bar.height));
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = bar.bg;
    graphics.roundRect(-barWidth / 2, -bar.height / 2, barWidth, bar.height, bar.radius);
    graphics.fill();
    const ratio = Math.min(1, MessageLogStore.count() / MessageLogStore.CAPACITY);
    if (ratio > 0) {
      const fillWidth = Math.max(bar.height, barWidth * ratio);
      graphics.fillColor = ratio >= 1 ? bar.full : bar.fill;
      graphics.roundRect(-barWidth / 2, -bar.height / 2, fillWidth, bar.height, bar.radius);
      graphics.fill();
    }
    this.addChild(node);
  }

  /** 收起钮（稿 `.chat-tools button` 22×22）：点一下折到只剩标题行，再点展开 */
  private addCollapseButton(right: number, centerY: number) {
    const cfg = layout.head.collapse;
    const button = UiHelper.createNode("message_log_collapse", new Vec2(right - cfg.size.width / 2, centerY), cfg.size);
    const graphics = button.addComponent(Graphics);
    const paint = (hover: boolean) => {
      graphics.clear();
      graphics.fillColor = cfg.fill;
      graphics.roundRect(-cfg.size.width / 2, -cfg.size.height / 2, cfg.size.width, cfg.size.height, cfg.radius);
      graphics.fill();
      graphics.lineWidth = T.border.width;
      graphics.strokeColor = hover ? cfg.hoverColor : cfg.border;
      graphics.roundRect(-cfg.size.width / 2, -cfg.size.height / 2, cfg.size.width, cfg.size.height, cfg.radius);
      graphics.stroke();
    };
    paint(false);
    button.addChild(
      UiHelper.createLabel("message_log_collapse_label", this.collapsed ? cfg.expandText : cfg.text, cfg.color, cfg.fontSize, new Vec2(), cfg.size),
    );
    // 按钮自己吃掉点击（挡穿透），不冒泡成面板的挡穿透抬起
    blockClickThrough(button);
    button.on(Node.EventType.TOUCH_END, () => this.toggleCollapse(), this);
    // 点击音：收起/展开是一次真实操作（#685 口径：有动作的按钮才响）
    SoundManager.bindClick(button);
    if (HAS_MOUSE) {
      trackUiPress(button);
      button.on(Node.EventType.MOUSE_ENTER, () => paint(true), this);
      button.on(Node.EventType.MOUSE_LEAVE, () => paint(false), this);
    }
    this.addChild(button);
  }

  /** 正文：最近 `rows.count` 条（时间 + 分类标签 + 文字），空仓给一句安静的空态 */
  private addRows(width: number, height: number) {
    const rows = layout.rows;
    const left = -width / 2 + rows.paddingX;
    const top = height / 2 - layout.head.height;
    const entries = MessageLogStore.all().slice(-rows.count);
    if (!entries.length) {
      const footTop = -height / 2 + layout.foot.height;
      this.addChild(
        UiHelper.createLabel(
          "message_log_empty",
          rows.emptyText,
          rows.emptyColor,
          rows.text.fontSize,
          new Vec2(0, (top + footTop) / 2),
          new Size(width - rows.paddingX * 2, rows.height),
        ),
      );
      return;
    }
    entries.forEach((entry, index) => this.addRow(entry, index, left, top - index * rows.height - rows.height / 2));
  }

  /** 一行：时间（弱化等宽）+ 分类标签（36×18 圆角块）+ 正文（单行，超出裁掉） */
  private addRow(entry: MessageLogEntry, index: number, left: number, y: number) {
    const rows = layout.rows;
    const row = UiHelper.createNode(`message_log_row_${index}`, new Vec2(0, y), new Size(layout.size.width, rows.height));
    row.addChild(
      UiHelper.createLabel(
        `message_log_row_time_${index}`,
        this.clockLabel(entry.timestamp),
        rows.time.color,
        rows.time.fontSize,
        new Vec2(left + rows.timeWidth / 2, 0),
        new Size(rows.timeWidth, rows.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    const tagX = left + rows.timeWidth + rows.gap + rows.tag.width / 2;
    const tag = UiHelper.createNode(`message_log_row_tag_${index}`, new Vec2(tagX, 0), new Size(rows.tag.width, rows.tag.height));
    const graphics = tag.addComponent(Graphics);
    graphics.fillColor = rows.tag.fill;
    graphics.roundRect(-rows.tag.width / 2, -rows.tag.height / 2, rows.tag.width, rows.tag.height, rows.tag.radius);
    graphics.fill();
    graphics.lineWidth = T.border.width;
    graphics.strokeColor = rows.tag.border;
    graphics.roundRect(-rows.tag.width / 2, -rows.tag.height / 2, rows.tag.width, rows.tag.height, rows.tag.radius);
    graphics.stroke();
    tag.addChild(
      UiHelper.createLabel(
        `message_log_row_tag_label_${index}`,
        rows.tagTexts[entry.category],
        rows.tagColors[entry.category],
        rows.tag.fontSize,
        new Vec2(),
        new Size(rows.tag.width, rows.tag.height),
      ),
    );
    row.addChild(tag);
    const textLeft = tagX + rows.tag.width / 2 + rows.gap;
    const textWidth = layout.size.width / 2 - rows.paddingX - textLeft;
    row.addChild(
      UiHelper.createLabel(
        `message_log_row_text_${index}`,
        entry.text,
        rows.text.color,
        rows.text.fontSize,
        new Vec2(textLeft + textWidth / 2, 0),
        new Size(textWidth, rows.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    this.addChild(row);
  }

  /** 底部注释：分隔细线 + 左「系统消息 · 不含聊天对话」+ 右「满 1000 条自动清空 · 重新累计」 */
  private addFoot(width: number, height: number) {
    const foot = layout.foot;
    const left = -width / 2 + foot.paddingX;
    const right = width / 2 - foot.paddingX;
    const centerY = -height / 2 + foot.height / 2;
    const ruleY = -height / 2 + foot.height;
    this.plate.lineWidth = 1;
    this.plate.strokeColor = foot.ruleColor;
    this.plate.moveTo(left, ruleY);
    this.plate.lineTo(right, ruleY);
    this.plate.stroke();
    const halfWidth = (right - left) / 2;
    this.addChild(
      UiHelper.createLabel(
        "message_log_foot_left",
        foot.left,
        foot.leftColor,
        foot.fontSize,
        new Vec2(left + halfWidth / 2 - 4, centerY),
        new Size(halfWidth, foot.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    this.addChild(
      UiHelper.createLabel(
        "message_log_foot_right",
        foot.right,
        foot.rightColor,
        foot.fontSize,
        new Vec2(left + halfWidth * 1.5 + 4, centerY),
        new Size(halfWidth, foot.height),
        Label.HorizontalAlign.RIGHT,
      ),
    );
  }

  /** 收起 / 展开（只重画本块，不碰仓） */
  private toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.render();
  }

  /** 时间显示 HH:MM（客户端本地时间；客户端 tsconfig 的 lib 不到 ES2017，padStart 用不了，用切片补零） */
  private clockLabel(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => `0${value}`.slice(-2);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}
