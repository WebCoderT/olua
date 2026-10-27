import { Color, Graphics, Label, isValid, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import AchievementStore from "../../core/AchievementStore";
import UiHelper from "../../helpers/UiHelper";
import {
  achievementCategories,
  achievementDialogLayout as layout,
  achievementTexts as texts,
} from "../../../configs/achievement";
import type { AchievementCategory } from "../../../configs/achievement";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import type { AchievementView } from "../../utils/net/ApiModels";

/** 背包满的业务码（与 `common/constants/biz-code` 的 MALL_BAG_FULL 同值） */
const CODE_BAG_FULL = 20012;

/**
 * 成就面板（#401）
 *
 * ## 一个弹窗 + 三个分类页签
 * 成就是「我这角色的成就墙」，分类（战斗 / 成长 / 探索）只是同一份列表的三种筛法 ——
 * 分成三个入口等于让玩家先想清楚「这条算什么类」，而他想看的往往只是「还有哪些没拿」。
 *
 * ## 为什么进度不在这里算
 * 服务端给的是**已经钳好的 progress / target**，并且已经判好 `achieved`：
 * 累计型的进度来自事件记账、状态型的进度是查询时现算的 —— 客户端再算一遍只会
 * 与服务端漂移（比如「背包里刚好有 20 张兽皮」这种）。这里只负责画。
 *
 * ## 领取按钮的三态
 * 未达成（灰、不可点）/ 可领（绿、可点）/ 已领（灰、不可点）。
 * 点领取失败时**不把整份列表清空**：背包满（20012）时玩家清完格子直接再点一次就行。
 */
export default class AchievementDialog {
  private dialog: Node | null = null;
  /** 内容容器（切页 / 数据变化时清空重画） */
  private body: Node | null = null;
  /** 当前分类 */
  private category: AchievementCategory = achievementCategories[0];
  private tabNodes = new Map<AchievementCategory, Node>();
  private tabLabels = new Map<AchievementCategory, Node>();
  /** AchievementStore 订阅（打开期间有效） */
  private unsubscribe: (() => void) | null = null;

  /** 打开 / 关闭（重复点即关闭） */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    this.dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    blockClickThrough(this.dialog);
    LayerManager.addDialogToUILayer(this.dialog);
    this.createTabs();
    this.body = UiHelper.createGroupNode(`${layout.name}_body`, new Vec2());
    this.dialog.addChild(this.body);
    this.unsubscribe = AchievementStore.onChange(() => this.render());
    // 默认停在「战斗」：它是玩家最先接触的一类（打怪就有）
    this.select(achievementCategories[0]);
  }

  /** 关闭（订阅退掉） */
  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  isOpen(): boolean {
    return !!this.dialog && isValid(this.dialog) && this.dialog.active;
  }

  //#region 页签

  private createTabs() {
    const dialog = this.dialog;
    if (!dialog) return;
    this.tabNodes.clear();
    this.tabLabels.clear();
    achievementCategories.forEach((category, index) => {
      const node = UiHelper.createNode(
        `${layout.name}_tab_${category}`,
        new Vec2(layout.tabs.columns[index], layout.tabs.y),
        layout.tabs.size,
      );
      node.addComponent(Graphics);
      const label = UiHelper.createLabel(
        `${layout.name}_tab_${category}_label`,
        texts.tabs[index],
        layout.tabs.idleText,
        layout.tabs.fontSize,
        new Vec2(),
        layout.tabs.size,
      );
      node.addChild(label);
      node.on(Node.EventType.TOUCH_END, () => this.select(category), this);
      blockClickThrough(node);
      dialog.addChild(node);
      this.tabNodes.set(category, node);
      this.tabLabels.set(category, label);
    });
  }

  private select(category: AchievementCategory) {
    this.category = category;
    this.paintTabs();
    // 每次切页都重拉：状态型成就的进度取决于角色当前状态（等级 / 战力 / 背包），缓存没意义
    AchievementStore.reload();
    this.render();
  }

  private paintTabs() {
    achievementCategories.forEach((category) => {
      const node = this.tabNodes.get(category);
      const labelNode = this.tabLabels.get(category);
      if (!node || !isValid(node) || !labelNode) return;
      const active = category === this.category;
      const graphics = node.getComponent(Graphics);
      if (graphics) {
        const size = layout.tabs.size;
        graphics.clear();
        graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, layout.tabs.radius);
        graphics.fillColor = active ? layout.tabs.activeFill : layout.tabs.idleFill;
        graphics.fill();
        if (!active) {
          graphics.lineWidth = 1;
          graphics.strokeColor = layout.tabs.idleBorder;
          graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, layout.tabs.radius);
          graphics.stroke();
        }
      }
      const label = labelNode.getComponent(Label);
      if (label) label.color = active ? layout.tabs.activeText : layout.tabs.idleText;
    });
  }

  //#endregion

  //#region 渲染

  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    const state = AchievementStore.get();
    this.renderSummary(body, state.data ? state.data.summary : null);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const rows = state.data ? state.data.achievements.filter((row) => row.category === this.category) : [];
    this.renderRows(content, rows, state.loading, state.failed, state.busyId);
  }

  /** 顶部小结：已达成 / 总数 / 已领 */
  private renderSummary(body: Node, summary: { total: number; achieved: number; claimed: number } | null) {
    const text = summary
      ? texts.summary
          .split("{achieved}")
          .join(`${summary.achieved}`)
          .split("{total}")
          .join(`${summary.total}`)
          .split("{claimed}")
          .join(`${summary.claimed}`)
      : "";
    body.addChild(
      UiHelper.createLabel(
        "achievement_summary",
        text,
        layout.summary.color,
        layout.summary.fontSize,
        layout.summary.position,
        layout.summary.size,
      ),
    );
  }

  /** 一行列表（空 / 加载中 / 失败各有各的文案，不都显示成「空」） */
  private renderRows(content: Node, rows: AchievementView[], loading: boolean, failed: boolean, busyId: string) {
    if (rows.length === 0) {
      const text = loading ? texts.loading : failed ? texts.failed : texts.emptyList;
      content.addChild(this.createEmpty(text));
      return;
    }
    rows.forEach((row) => content.addChild(this.createRow(row, busyId === row.id)));
  }

  /** 一条成就：名称 + 描述 + 进度 + 状态按钮 */
  private createRow(row: AchievementView, busy: boolean) {
    const config = layout.row;
    const node = this.createPanel(
      `achievement_row_${row.id}`,
      config.size,
      row.achieved && !row.claimed ? config.achievedFill : config.fill,
      row.achieved && !row.claimed ? config.achievedBorder : config.border,
      config.radius,
    );
    node.addChild(
      UiHelper.createLabel(
        `achievement_name_${row.id}`,
        row.label,
        config.nameColor,
        config.nameFontSize,
        config.namePosition,
        config.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `achievement_desc_${row.id}`,
        // 隐藏成就没达成时不剧透条件（描述换成一句提示）
        row.hidden && !row.achieved ? texts.hiddenHint : row.description,
        config.descColor,
        config.descFontSize,
        config.descPosition,
        config.descSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `achievement_progress_${row.id}`,
        texts.progress.split("{progress}").join(`${row.progress}`).split("{target}").join(`${row.target}`),
        config.progressColor,
        config.progressFontSize,
        config.progressPosition,
        config.progressSize,
      ),
    );
    node.addChild(this.createAction(row, busy));
    return node;
  }

  /** 状态按钮：可领（绿）/ 已领（灰）/ 未达成（灰，不可点） */
  private createAction(row: AchievementView, busy: boolean) {
    const config = layout.row;
    const claimable = row.achieved && !row.claimed;
    const node = UiHelper.createNode(`achievement_action_${row.id}`, config.actionPosition, config.actionSize);
    const graphics = node.addComponent(Graphics);
    const size = config.actionSize;
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, config.actionRadius);
    graphics.fillColor = claimable ? config.claimFill : row.claimed ? config.claimedFill : config.lockedFill;
    graphics.fill();
    const text = busy ? texts.claim : row.claimed ? texts.claimed : claimable ? texts.claim : texts.locked;
    node.addChild(
      UiHelper.createLabel(
        `achievement_action_label_${row.id}`,
        text,
        claimable ? config.actionTextColor : config.lockedTextColor,
        config.actionFontSize,
        new Vec2(),
        config.actionSize,
      ),
    );
    if (claimable && !busy) {
      node.on(Node.EventType.TOUCH_END, () => void this.onClaim(row.id), this);
      blockClickThrough(node);
    }
    return node;
  }

  private async onClaim(achievementId: string) {
    const result = await AchievementStore.claim(achievementId);
    if (!this.isOpen()) return;
    if (result.ok) {
      // 背包满时奖励进了邮箱（服务端把整份转成邮件），提示要指路，不然玩家以为没拿到
      GameUiHelper.createTipText(result.mailId ? texts.claimMail : texts.claimSuccess);
      return;
    }
    GameUiHelper.createTipText(result.code === CODE_BAG_FULL ? texts.claimBagFull : texts.claimFailed);
  }

  private createEmpty(text: string) {
    const node = UiHelper.createNode("achievement_empty", new Vec2(), layout.list.size);
    node.addChild(
      UiHelper.createLabel("achievement_empty_text", text, layout.row.descColor, layout.row.nameFontSize, new Vec2(), layout.list.size),
    );
    return node;
  }

  private createPanel(name: string, size: Size, fill: Color, border: Color, radius: number): Node {
    const node = UiHelper.createNode(name, new Vec2(), size);
    const graphics = node.addComponent(Graphics);
    const path = () => graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, radius);
    graphics.fillColor = fill;
    path();
    graphics.fill();
    graphics.lineWidth = 1;
    graphics.strokeColor = border;
    path();
    graphics.stroke();
    blockClickThrough(node);
    return node;
  }

  //#endregion

  private reset() {
    this.dialog = null;
    this.body = null;
    this.category = achievementCategories[0];
    this.tabNodes.clear();
    this.tabLabels.clear();
  }
}
