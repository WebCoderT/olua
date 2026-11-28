import { Graphics, Label, Node, Prefab, Size, UITransform, Vec2, instantiate, isValid } from "cc";
import MessageLogStore from "../../core/MessageLogStore";
import type { MessageLogEntry } from "../../core/MessageLogStore";
import SoundManager from "../../core/SoundManager";
import UiHelper from "../../helpers/UiHelper";
import { HAS_MOUSE, trackUiPress } from "../../utils/input/Pointer";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import { messageLogLayout as layout, T, messageLogPrefab } from "../../../configs/hudLayout";

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
 * ## 骨架与动态的边界（#1361 HUD prefab 化）
 * 面板底板（VectorPlate）/ 标题 / 计数列 / 底部注释 / 摆位锚点在 `ui/prefabs/hud/MessageLog.prefab`，
 * 摆位与配色可在编辑器可视化改；动态零件（容量条 / 收起钮 / 消息行）由代码挂在锚点上绘制，
 * 收起/展开只切显隐与面板尺寸（VectorPlate 随尺寸重画），不重建静态骨架。
 *
 * ## 数据与生命周期
 * - 数据只在 `MessageLogStore`（纯内存：不落存档、不发请求，重新上线即清空）；
 * - 写入方主要是 `ui/core/storage/role-delta-log.ts`（角色数据差分），本类只读；
 * - 本类**不发请求、不存状态**，订阅 onChange 局部重画（行区整块重建，最多 10 行）；
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
  /** 面板底板节点（VectorPlate 随尺寸重画；收起/展开只改它的 contentSize） */
  private plateNode: Node;
  /** 计数 / 上限文本 */
  private countLabel: Label;
  private denLabel: Label;
  /** 容量条绘制层（挂 CapBarAnchor 原点） */
  private capGraphics: Graphics;
  /** 收起钮零件（挂 CollapseAnchor 原点；hover 重绘走 Graphics） */
  private collapseLabel: Label;
  /** 消息行容器（挂 RowsAnchor；整块重建） */
  private rowsAnchor: Node;
  /** 头部零件与它们的 prefab 设计位（收起时挪到剩余面板中心，展开时还原 —— 位置真相仍是 prefab） */
  private headNodes: Node[] = [];
  private headYs: number[] = [];
  /** 底部注释零件（收起时隐藏） */
  private footNodes: Node[] = [];
  /** prefab 根位置（收起/展开按「底边不动」重算中心的基准） */
  private rootHome = { x: 0, y: 0 };

  constructor(prefab: Prefab) {
    super("message_log");
    if (!prefab) {
      console.warn("[message-log] prefab 未注入：请确认 Game 场景的 messageLogPrefab 字段已绑定");
      return;
    }
    // 实例化 prefab：把根节点子树挂到 this（#1361）
    const instance = instantiate(prefab) as Node;
    this.addComponent(UITransform).setContentSize(instance.getComponent(UITransform)!.contentSize);
    const children = instance.children.slice();
    for (const child of children) child.setParent(this);
    this.rootHome = { x: instance.position.x, y: instance.position.y };
    this.setPosition(this.rootHome.x, this.rootHome.y, 0);
    // 面板整体挡穿透：命中区罩住整块，点消息记录不会顺带把角色走过去
    blockClickThrough(this);

    const paths = messageLogPrefab.nodes;
    const nodeOf = (path: string): Node | null => {
      const found = this.getChildByPath(path);
      if (!found) console.warn(`[message-log] prefab 缺节点: ${path}`);
      return found;
    };
    const labelOf = (path: string): Label | null => {
      const comp = nodeOf(path)?.getComponent(Label) ?? null;
      if (!comp) console.warn(`[message-log] 节点缺 Label 组件: ${path}`);
      return comp;
    };
    this.plateNode = nodeOf(paths.plate)!;
    this.countLabel = labelOf(paths.count)!;
    this.denLabel = labelOf(paths.den)!;
    this.rowsAnchor = nodeOf(paths.rows)!;
    const headTitle = nodeOf(paths.headTitle);
    if (headTitle) this.headNodes.push(headTitle);
    for (const path of [paths.count, paths.den, paths.capBar, paths.collapse]) {
      const node = nodeOf(path);
      if (node) this.headNodes.push(node);
    }
    this.headYs = this.headNodes.map((node) => node.position.y);
    for (const path of [paths.footLeft, paths.footRight]) {
      const node = nodeOf(path);
      if (node) this.footNodes.push(node);
    }
    // 底部分隔细线是 prefab 静态 Sprite（FootRule 不在契约里，按名字取；缺了只少一条装饰线）
    const footRule = this.getChildByPath("FootRule");
    if (footRule) this.footNodes.push(footRule);

    // 动态零件建在锚点上（原点挂载，摆位归 prefab 锚点）
    this.capGraphics = nodeOf(paths.capBar)!.addComponent(Graphics);
    this.buildCollapseButton(nodeOf(paths.collapse)!);
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

  /** 局部重画：面板尺寸/位置（收起切换）+ 计数 + 容量条 + 消息行 + 收起钮文字；静态骨架不动 */
  private render() {
    if (!isValid(this)) return;
    const width = layout.size.width;
    const height = this.collapsed ? layout.head.height : layout.size.height;
    const transform = this.getComponent(UITransform);
    if (transform) transform.setContentSize(width, height);
    // 底板随尺寸重画（VectorPlate 每帧比对尺寸）；底边不动地变高/变矮：稿里面板贴屏幕右下，
    // 收起时应当从顶部往下折（底边留在 prefab 设计的 bottom 处）—— 基准是 prefab 根位（#1359 口径）
    this.plateNode.getComponent(UITransform)!.setContentSize(width, height);
    this.setPosition(this.rootHome.x, this.rootHome.y - (layout.size.height - height) / 2);
    // 头部零件挪到剩余面板中心（收起时），展开还原到 prefab 设计位
    const centerY = height / 2 - layout.head.height / 2;
    this.headNodes.forEach((node, index) => {
      node.setPosition(node.position.x, this.collapsed ? centerY : this.headYs[index], 0);
    });
    // 正文与底部注释收起时隐藏（静态骨架不重建，只切显隐）
    this.rowsAnchor.active = !this.collapsed;
    this.footNodes.forEach((node) => (node.active = !this.collapsed));
    // 计数：当前条数（金）+ ` / 1000`（弱化）。数字右对齐到固定槽位，位数变化时后缀不跟着跳
    this.countLabel.string = `${MessageLogStore.count()}`;
    this.denLabel.string = ` / ${MessageLogStore.CAPACITY}`;
    this.repaintCapBar();
    if (!this.collapsed) this.renderRows();
    // 收起钮文字随状态切（文案属内容；按钮底板样式由 Graphics 绘制，不随数据变）
    const cfg = layout.head.collapse;
    this.collapseLabel.string = this.collapsed ? cfg.expandText : cfg.text;
  }

  /** 容量条重画：常色金阶、满格转朱红（稿 `.capbar`；锚点已承载摆位，这里只画当前占比） */
  private repaintCapBar() {
    const bar = layout.head.bar;
    const graphics = this.capGraphics;
    const barWidth = this.capGraphics.node.getComponent(UITransform)!.contentSize.width;
    graphics.clear();
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
  }

  /** 收起钮（稿 `.chat-tools button` 22×22，挂 CollapseAnchor 原点）：点一下折到只剩标题行，再点展开 */
  private buildCollapseButton(anchor: Node) {
    const cfg = layout.head.collapse;
    const graphics = anchor.addComponent(Graphics);
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
    const label = UiHelper.createLabel(
      "message_log_collapse_label", cfg.text, cfg.color, cfg.fontSize, new Vec2(), cfg.size,
    );
    this.collapseLabel = label.getComponent(Label)!;
    anchor.addChild(label);
    // 按钮自己吃掉点击（挡穿透），不冒泡成面板的挡穿透抬起
    blockClickThrough(anchor);
    anchor.on(Node.EventType.TOUCH_END, () => this.toggleCollapse(), this);
    // 点击音：收起/展开是一次真实操作（#685 口径：有动作的按钮才响）
    SoundManager.bindClick(anchor);
    if (HAS_MOUSE) {
      trackUiPress(anchor);
      anchor.on(Node.EventType.MOUSE_ENTER, () => paint(true), this);
      anchor.on(Node.EventType.MOUSE_LEAVE, () => paint(false), this);
    }  }

  /** 正文：最近 `rows.count` 条（时间 + 分类标签 + 文字），空仓给一句安静的空态（挂 RowsAnchor，行区摆位归 prefab 锚点） */
  private renderRows() {
    // 行区整块重建（onChange 全量重画口径；最多 10 行，重建比差量省心且不会漏）
    clearChildren(this.rowsAnchor);
    const rows = layout.rows;
    const left = -layout.size.width / 2 + rows.paddingX;
    // RowsAnchor 中心已对齐行区中心（prefab 设计）；行区顶/底边取相对锚点的 y
    const top = layout.size.height / 2 - layout.head.height - this.rowsAnchor.position.y;
    const footTop = -layout.size.height / 2 + layout.foot.height - this.rowsAnchor.position.y;
    const entries = MessageLogStore.all().slice(-rows.count);
    if (!entries.length) {
      this.rowsAnchor.addChild(
        UiHelper.createLabel(
          "message_log_empty",
          rows.emptyText,
          rows.emptyColor,
          rows.text.fontSize,
          new Vec2(0, (top + footTop) / 2),
          new Size(layout.size.width - rows.paddingX * 2, rows.height),
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
    this.rowsAnchor.addChild(row);
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
