import { Color, Graphics, isValid, Label, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import LeaderboardStore, { LEADERBOARD_BOARD } from "../../core/LeaderboardStore";
import type { LeaderboardBoard } from "../../core/LeaderboardStore";
import UiHelper from "../../helpers/UiHelper";
import { leaderboardDialogLayout as layout } from "../../../configs/hudLayout";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import type { LeaderboardEntry } from "../../utils/net/ApiModels";

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应） */
const TABS: LeaderboardBoard[] = [LEADERBOARD_BOARD.LEVEL, LEADERBOARD_BOARD.COMBAT, LEADERBOARD_BOARD.KILLS];

/**
 * 排行榜弹窗（#400：等级 / 战力 / 击杀）
 *
 * ## 三个页签就是一个弹窗
 * 三个榜是同一批人、同一份快照的三种排法。分成三个入口等于让玩家先想清楚「我要看哪个」，
 * 而实际上他常常是想「我在等级榜第几、在战力榜第几」连着看。
 *
 * ## 底部那一条「我的名次」不是装饰
 * 榜只留前 N 条（服务端 `LEADERBOARD_TOP_N`，默认 100），九百名的人翻不到自己。
 * 服务端 `me` 接口在**全量排序**里算名次，所以底部这一行永远是对的 ——
 * 它也是这个面板里唯一「每个人都一定看得到自己」的地方。
 *
 * ## 数据从哪来
 * `LeaderboardStore`（HTTP 拉的，不是帧）：打开面板时按当前页签拉一次，切页签各自拉。
 * 顶部那句「共 N 人上榜 · HH:mm 更新」用服务端返回的 `computedAt` ——
 * 榜一分钟才重算一次，把这件事说出来比让玩家怀疑「我升级了怎么没动」要好。
 *
 * ## 谁是我
 * 用 `me` 返回的 `entry.roleId` 判断，而不是本地存档里的角色 id：
 * 榜单里「我」的定义应当由服务端给的那一份说了算（切角色 / 离线都一致）。
 */
export default class LeaderboardDialog {
  /** 弹窗根 */
  private dialog: Node | null = null;
  /** 内容容器（切页 / 数据变化时清空重画） */
  private body: Node | null = null;
  /** 当前页签 */
  private tab: LeaderboardBoard = LEADERBOARD_BOARD.LEVEL;
  private tabNodes = new Map<LeaderboardBoard, Node>();
  private tabLabels = new Map<LeaderboardBoard, Node>();
  /** LeaderboardStore 订阅（打开期间有效） */
  private unsubscribe: (() => void) | null = null;

  /** 打开 / 关闭弹窗（重复点即关闭） */
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
    this.unsubscribe = LeaderboardStore.onChange(() => this.render());
    // 默认停在「等级」：它是玩家最先想到、也最好理解的那个维度
    this.select(LEADERBOARD_BOARD.LEVEL);
  }

  /** 关闭弹窗（订阅退掉） */
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
    TABS.forEach((board, index) => {
      const node = UiHelper.createNode(`${layout.name}_tab_${board}`, new Vec2(layout.tabs.columns[index], layout.tabs.y), layout.tabs.size);
      node.addComponent(Graphics);
      const label = UiHelper.createLabel(
        `${layout.name}_tab_${board}_label`,
        layout.texts.tabs[index],
        layout.tabs.idleText,
        layout.tabs.fontSize,
        new Vec2(),
        layout.tabs.size,
      );
      node.addChild(label);
      node.on(Node.EventType.TOUCH_END, () => this.select(board), this);
      blockClickThrough(node);
      dialog.addChild(node);
      this.tabNodes.set(board, node);
      this.tabLabels.set(board, label);
    });
  }

  private select(board: LeaderboardBoard) {
    this.tab = board;
    this.paintTabs();
    // 每次切页都把这一页重拉一遍：榜是分钟级的，缓存一份十分钟前的只会误导人
    LeaderboardStore.reload(board);
    this.render();
  }

  private paintTabs() {
    TABS.forEach((board) => {
      const node = this.tabNodes.get(board);
      const labelNode = this.tabLabels.get(board);
      if (!node || !isValid(node) || !labelNode) return;
      const active = board === this.tab;
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
    const state = LeaderboardStore.state(this.tab);
    this.renderSummary(body, state.page ? state.page.total : 0, state.page ? state.page.computedAt : 0);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    this.renderRows(content, state.page ? state.page.list : [], state.self ? state.self.entry : null);
    this.renderSelf(body, state.self ? state.self.rank : 0, state.self ? state.self.entry : null);
  }

  /** 顶部小结：共几人上榜 + 这份快照的时刻 */
  private renderSummary(body: Node, total: number, computedAt: number) {
    const text = layout.texts.summary
      .split("{total}")
      .join(`${total}`)
      .split("{updated}")
      .join(this.updatedText(computedAt));
    body.addChild(
      UiHelper.createLabel("leaderboard_summary", text, layout.summary.color, layout.summary.fontSize, layout.summary.position, layout.summary.size),
    );
  }

  /** 名单（空榜 / 加载中 / 失败各有各的文案，不都显示成「空」） */
  private renderRows(content: Node, entries: LeaderboardEntry[], self: LeaderboardEntry | null) {
    const state = LeaderboardStore.state(this.tab);
    if (entries.length === 0) {
      const text = state.loading ? layout.texts.loading : state.failed ? layout.texts.failed : layout.texts.emptyList;
      content.addChild(this.createEmpty(text));
      return;
    }
    entries.forEach((entry) => content.addChild(this.createRow(entry, !!self && entry.roleId === self.roleId)));
  }

  /** 底部固定的「我的名次」：榜外的人靠它确认自己第几 */
  private renderSelf(body: Node, rank: number, entry: LeaderboardEntry | null) {
    const config = layout.selfRow;
    const node = this.createPanel("leaderboard_self", config.size, config.fill, config.border, config.radius);
    node.setPosition(config.position.x, config.position.y, 0);
    const text = rank > 0 && entry ? layout.texts.selfIn.split("{rank}").join(`${rank}`) : layout.texts.selfOut;
    node.addChild(
      UiHelper.createLabel("leaderboard_self_text", text, config.textColor, config.textFontSize, new Vec2(), config.size, Label.HorizontalAlign.CENTER),
    );
    body.addChild(node);
  }

  /** 一条名次：名次（左）+ 名字 + 数值行（右） */
  private createRow(entry: LeaderboardEntry, isMe: boolean) {
    const config = layout.row;
    const node = this.createPanel(
      `leaderboard_row_${entry.roleId}`,
      config.size,
      isMe ? config.selfFill : config.fill,
      isMe ? config.selfBorder : config.border,
      config.radius,
    );
    const rankColor = entry.rank <= config.topRankThreshold ? config.topRankColor : config.rankColor;
    node.addChild(
      UiHelper.createLabel(`leaderboard_rank_${entry.roleId}`, `${entry.rank}`, rankColor, config.rankFontSize, new Vec2(config.rankX, 0), config.rankSize),
    );
    node.addChild(
      UiHelper.createLabel(
        `leaderboard_name_${entry.roleId}`,
        entry.name,
        isMe ? config.topRankColor : config.nameColor,
        config.nameFontSize,
        new Vec2(config.nameX, 0),
        config.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `leaderboard_meta_${entry.roleId}`,
        this.metaText(entry),
        config.metaColor,
        config.metaFontSize,
        new Vec2(config.metaX, 0),
        config.metaSize,
        Label.HorizontalAlign.RIGHT,
      ),
    );
    return node;
  }

  /** 数值行：当前榜的那个数放最前面（其余两个也带着，省得来回切页） */
  private metaText(entry: LeaderboardEntry): string {
    const template =
      this.tab === LEADERBOARD_BOARD.COMBAT ? layout.texts.combatMeta : this.tab === LEADERBOARD_BOARD.KILLS ? layout.texts.killsMeta : layout.texts.levelMeta;
    return template
      .split("{level}")
      .join(`${entry.level}`)
      .split("{combat}")
      .join(`${entry.combat}`)
      .split("{kills}")
      .join(`${entry.kills}`);
  }

  /** 快照时刻：一分钟内说「刚刚」，否则说时分（不显示日期 —— 榜不会隔夜不变） */
  private updatedText(computedAt: number): string {
    if (!computedAt || Date.now() - computedAt < layout.summary.freshMs) return layout.texts.updatedNow;
    const date = new Date(computedAt);
    // 不写 `padStart`：客户端的 tsconfig lib 没到 ES2017，这里手补零
    const hh = `${date.getHours()}`.length < 2 ? `0${date.getHours()}` : `${date.getHours()}`;
    const mm = `${date.getMinutes()}`.length < 2 ? `0${date.getMinutes()}` : `${date.getMinutes()}`;
    return layout.texts.updatedAt.split("{time}").join(`${hh}:${mm}`);
  }

  private createEmpty(text: string) {
    const node = UiHelper.createNode("leaderboard_empty", new Vec2(), layout.list.size);
    node.addChild(UiHelper.createLabel("leaderboard_empty_text", text, layout.row.metaColor, layout.row.nameFontSize, new Vec2(), layout.list.size));
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
    this.tab = LEADERBOARD_BOARD.LEVEL;
    this.tabNodes.clear();
    this.tabLabels.clear();
  }
}
