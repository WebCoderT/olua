import { Color, Graphics, Label, Layout, Node, ScrollView, Size, Vec2, isValid } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import MailStore from "../../core/MailStore";
import UiHelper from "../../helpers/UiHelper";
import { items } from "../../../configs/items";
import { mailChannels, mailDialogLayout as layout, mailTexts as texts } from "../../../configs/mail";
import type { MailChannelKey } from "../../../configs/mail";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import type { MailView } from "../../utils/net/ApiModels";

/** 业务码（与 `common/constants/biz-code` 同值）：背包满 / 已领 / 附件没领不能删 */
const CODE_BAG_FULL = 20012;
const CODE_ALREADY_CLAIMED = 50142;
const CODE_UNCLAIMED = 50143;

/** 弹窗对外要的两件事：未读数回给入口红点、公告板由持有方打开 */
export interface MailDialogOptions {
  /** 未读数变化（入口小红点由持有方画，本类不关心红点长什么样） */
  onUnreadChange?: (unread: number) => void;
  /** 打开公告板（公告板块从邮件面板进，见 SmallMap 的入口注释） */
  onOpenAnnouncement?: () => void;
}

/**
 * 邮件面板（#429，频道化 #436）
 *
 * ## 一行一封，不做「左列表 + 右详情」
 * 邮件的正文通常就一两句（系统通知 / 成就奖励说明），附件也能压成一行摘要 ——
 * 再拆成左右两栏只会让「领取」这一件事多两次点击。列表里做三件事就够：
 * 点行标已读、点「领取」领附件、点「删除」删掉。
 *
 * ## 频道页签只筛不请求
 * 服务端一次给全量 + 每个频道的角标，切页签是纯本地动作（见 `MailStore.setChannel`）：
 * 不闪加载态、不会「切回全部要重拉」。角标画在页签右上角，红点口径与入口一致（全量）。
 *
 * ## 一键领取跟着页签走
 * 在「奖励」页签点一键领取只领奖励那栏 —— 玩家清包时只想清奖励，不该顺手动到社交消息。
 *
 * ## 领取失败不清列表
 * 背包满（20012）时只飘一句「先清出格子」，邮件原样留着；玩家清完再点一次即可。
 * 把列表清空或者把邮件藏起来，会让人以为奖励丢了。
 *
 * ## 已领的邮件也能删
 * 附件没领的删不掉（服务端 50143，客户端先把按钮画灰并给提示）——
 * 「删邮件」这个动作不该有替玩家扔掉奖励的可能。
 */
export default class MailDialog {
  private dialog: Node | null = null;
  /** 内容容器（数据变化时清空重画） */
  private body: Node | null = null;
  /** MailStore 订阅（打开期间有效） */
  private unsubscribe: (() => void) | null = null;
  private readonly options: MailDialogOptions;

  constructor(options: MailDialogOptions = {}) {
    this.options = options;
  }

  /** 打开 / 关闭（重复点即关闭） */
  open() {
    if (this.isOpen()) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    blockClickThrough(dialog);
    LayerManager.addDialogToUILayer(dialog);
    this.dialog = dialog;
    this.body = UiHelper.createGroupNode(`${layout.name}_body`, new Vec2());
    dialog.addChild(this.body);
    this.unsubscribe = MailStore.onChange(() => this.render());
    // 每次打开都重拉：邮件是「有没有新的」这件事，缓存一份没有意义
    MailStore.reload();
    this.render();
  }

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

  //#region 渲染

  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    const state = MailStore.get();
    const box = state.data;
    // 红点跟着这一份走（未读 + 未领都算「有东西要处理」，永远是全量而不是当前频道）
    this.options.onUnreadChange?.(box ? box.unread + box.unclaimed : 0);
    this.renderHeader(body, box ? box.unclaimed : 0);
    this.renderTabs(body);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const layoutComponent = content.getComponent(Layout);
    if (layoutComponent) layoutComponent.spacingY = layout.row.gap;
    const rows = MailStore.visible(state);
    if (rows.length === 0) {
      // 两种空要分开：整箱为空 vs 这一栏为空（后者切到「全部」还能看到别的）
      const text = state.loading
        ? texts.loading
        : state.failed
          ? texts.failed
          : box && box.mails.length > 0
            ? texts.emptyChannel
            : texts.emptyList;
      content.addChild(
        UiHelper.createLabel(
          "mail_empty_text",
          text,
          layout.row.descColor,
          layout.row.titleFontSize,
          new Vec2(),
          layout.list.size,
        ),
      );
      return;
    }
    for (const row of rows) content.addChild(this.createRow(row, state.busyId === row.id || state.busyId === "*"));
  }

  /** 频道页签行（五个，横排居中；带未读角标） */
  private renderTabs(body: Node) {
    const config = layout.tabs;
    const state = MailStore.get();
    const counts = new Map<string, number>();
    for (const summary of state.data?.channels ?? []) counts.set(summary.channel, summary.unread);
    const total = state.data?.unread ?? 0;
    // 整行居中：n 个页签 + (n-1) 个间距
    const count = mailChannels.length;
    const rowWidth = count * config.width + (count - 1) * config.gap;
    const startX = -rowWidth / 2 + config.width / 2;
    mailChannels.forEach((channel, index) => {
      const unread = channel.key === "all" ? total : (counts.get(channel.key) ?? 0);
      body.addChild(this.createTab(channel.key, channel.label, unread, startX + index * (config.width + config.gap)));
    });
  }

  /** 单个页签：底色区分选中态，右上角挂未读角标 */
  private createTab(key: MailChannelKey, text: string, unread: number, x: number) {
    const config = layout.tabs;
    const active = MailStore.get().channel === key;
    const node = UiHelper.createNode(`mail_tab_${key}`, new Vec2(x, config.y), new Size(config.width, config.height));
    const size = new Size(config.width, config.height);
    const graphics = node.addComponent(Graphics);
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, config.radius);
    graphics.fillColor = active ? config.activeFill : config.fill;
    graphics.fill();
    node.addChild(
      UiHelper.createLabel(
        `mail_tab_label_${key}`,
        text,
        active ? config.activeTextColor : config.textColor,
        config.fontSize,
        new Vec2(),
        size,
      ),
    );
    if (unread > 0) node.addChild(this.createDot(key, unread));
    node.on(Node.EventType.TOUCH_END, () => MailStore.setChannel(key), this);
    blockClickThrough(node);
    return node;
  }

  /** 未读角标（>9 显示 9+：两位数会把小圆点撑变形） */
  private createDot(key: MailChannelKey, unread: number) {
    const config = layout.tabs;
    const node = UiHelper.createNode(
      `mail_tab_dot_${key}`,
      config.dotOffset,
      new Size(config.dotRadius * 2, config.dotRadius * 2),
    );
    const graphics = node.addComponent(Graphics);
    graphics.circle(0, 0, config.dotRadius);
    graphics.fillColor = config.dotFill;
    graphics.fill();
    node.addChild(
      UiHelper.createLabel(
        `mail_tab_dot_label_${key}`,
        unread > config.dotCap ? texts.dotOverflow : `${unread}`,
        config.dotTextColor,
        config.dotFontSize,
        new Vec2(),
        new Size(config.dotRadius * 2, config.dotRadius * 2),
      ),
    );
    return node;
  }

  /** 顶部：小结（全量）+ 一键领取（当前频道）+ 公告入口 */
  private renderHeader(body: Node, unclaimed: number) {
    const state = MailStore.get();
    const box = state.data;
    const summary = texts.summary
      .split("{unread}")
      .join(`${box ? box.unread : 0}`)
      .split("{unclaimed}")
      .join(`${unclaimed}`);
    body.addChild(
      UiHelper.createLabel(
        "mail_summary",
        summary,
        layout.summary.color,
        layout.summary.fontSize,
        layout.summary.position,
        layout.summary.size,
      ),
    );
    // 一键领取只对「当前这一栏」生效：没有待领就别把它画成能点
    const pending = this.unclaimedIn(state.channel);
    body.addChild(this.createButton("mail_claim_all", texts.claimAll, layout.claimAll, pending > 0, () => void this.onClaimAll()));
    body.addChild(
      this.createButton("mail_announcement", texts.announcement, layout.announcement, true, () => this.options.onOpenAnnouncement?.()),
    );
  }

  /** 当前页签下有多少封待领（`all` 用全局数字） */
  private unclaimedIn(channel: MailChannelKey): number {
    const box = MailStore.get().data;
    if (!box) return 0;
    if (channel === "all") return box.unclaimed;
    return box.channels.find((item) => item.channel === channel)?.unclaimed ?? 0;
  }

  /** 一封邮件：标题（未读更亮）+ 附件摘要 / 正文 + 领取 + 删除 */
  private createRow(row: MailView, busy: boolean) {
    const config = layout.row;
    const node = this.createPanel(
      `mail_row_${row.id}`,
      config.size,
      row.read ? config.fill : config.unreadFill,
      row.read ? config.border : config.unreadBorder,
      config.radius,
    );
    const title = UiHelper.createLabel(
      `mail_title_${row.id}`,
      row.title,
      row.read ? config.titleColor : config.unreadTitleColor,
      config.titleFontSize,
      config.titlePosition,
      config.titleSize,
      Label.HorizontalAlign.LEFT,
    );
    title.getComponent(Label).overflow = Label.Overflow.SHRINK;
    node.addChild(title);
    const desc = UiHelper.createLabel(
      `mail_desc_${row.id}`,
      this.describe(row),
      config.descColor,
      config.descFontSize,
      config.descPosition,
      config.descSize,
      Label.HorizontalAlign.LEFT,
    );
    desc.getComponent(Label).overflow = Label.Overflow.CLAMP;
    node.addChild(desc);
    node.addChild(this.createAction(row, busy));
    node.addChild(this.createRemove(row, busy));
    // 点行标已读（已读的行不用再请求）
    if (!row.read && !busy) node.on(Node.EventType.TOUCH_END, () => void this.onRead(row.id), this);
    return node;
  }

  /** 附件摘要（金币 / 经验 / 物品）；没有附件就显示正文 */
  private describe(row: MailView): string {
    const parts: string[] = [];
    if (row.gold > 0) parts.push(texts.gold.split("{count}").join(`${row.gold}`));
    if (row.exp > 0) parts.push(texts.exp.split("{count}").join(`${row.exp}`));
    for (const item of row.attachments) {
      const name = items.get(item.goodId)?.label ?? item.goodId;
      parts.push(texts.item.split("{name}").join(name).split("{count}").join(`${item.count}`));
    }
    return parts.length > 0 ? parts.join(texts.separator) : row.body || texts.noAttachment;
  }

  /** 领取按钮：可领（绿）/ 已领（灰，不绑点击） */
  private createAction(row: MailView, busy: boolean) {
    const config = layout.row;
    const node = UiHelper.createNode(`mail_action_${row.id}`, config.actionPosition, config.actionSize);
    const size = config.actionSize;
    const graphics = node.addComponent(Graphics);
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, config.actionRadius);
    graphics.fillColor = row.claimed ? config.claimedFill : config.claimFill;
    graphics.fill();
    node.addChild(
      UiHelper.createLabel(
        `mail_action_label_${row.id}`,
        busy ? texts.claim : row.claimed ? texts.claimed : texts.claim,
        row.claimed ? config.lockedTextColor : config.actionTextColor,
        config.actionFontSize,
        new Vec2(),
        config.actionSize,
      ),
    );
    if (!row.claimed && !busy) {
      node.on(Node.EventType.TOUCH_END, () => void this.onClaim(row.id), this);
      blockClickThrough(node);
    }
    return node;
  }

  /** 删除按钮：附件没领画灰（点了给一句提示，不静默失败） */
  private createRemove(row: MailView, busy: boolean) {
    const config = layout.row;
    const removable = row.claimed || this.hasNoAttachment(row);
    const node = UiHelper.createNode(`mail_remove_${row.id}`, config.removePosition, config.removeSize);
    const size = config.removeSize;
    const graphics = node.addComponent(Graphics);
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, config.removeRadius);
    graphics.fillColor = removable ? config.removeFill : config.removeDisabledFill;
    graphics.fill();
    node.addChild(
      UiHelper.createLabel(
        `mail_remove_label_${row.id}`,
        texts.remove,
        removable ? config.removeTextColor : config.removeDisabledTextColor,
        config.removeFontSize,
        new Vec2(),
        config.removeSize,
      ),
    );
    if (!busy) {
      node.on(Node.EventType.TOUCH_END, () => void this.onRemove(row, removable), this);
      blockClickThrough(node);
    }
    return node;
  }

  /** 通用小按钮（顶部那两颗） */
  private createButton(
    name: string,
    text: string,
    config: { position: Vec2; size: Size; radius: number; fill: Color; textColor: Color; fontSize: number },
    enabled: boolean,
    onTap: () => void,
  ) {
    const node = UiHelper.createNode(name, config.position, config.size);
    const size = config.size;
    const graphics = node.addComponent(Graphics);
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, config.radius);
    graphics.fillColor = enabled ? config.fill : layout.claimAll.disabledFill;
    graphics.fill();
    node.addChild(
      UiHelper.createLabel(
        `${name}_label`,
        text,
        enabled ? config.textColor : layout.claimAll.disabledTextColor,
        config.fontSize,
        new Vec2(),
        config.size,
      ),
    );
    if (enabled) {
      node.on(Node.EventType.TOUCH_END, onTap, this);
      blockClickThrough(node);
    }
    return node;
  }

  private createPanel(name: string, size: Size, fill: Color, border: Color, radius: number) {
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

  private hasNoAttachment(row: MailView): boolean {
    return row.gold <= 0 && row.exp <= 0 && row.attachments.length === 0;
  }

  //#endregion

  //#region 动作

  private async onRead(id: string) {
    await MailStore.read(id);
  }

  private async onClaim(id: string) {
    const result = await MailStore.claim(id);
    if (!this.isOpen()) return;
    if (result.ok) {
      GameUiHelper.createTipText(texts.claimSuccess);
      return;
    }
    GameUiHelper.createTipText(this.claimTip(result.code));
  }

  private claimTip(code: number): string {
    if (code === CODE_BAG_FULL) return texts.claimBagFull;
    if (code === CODE_ALREADY_CLAIMED) return texts.claimed;
    return texts.claimFailed;
  }

  private async onClaimAll() {
    const result = await MailStore.claimAll();
    if (!this.isOpen()) return;
    if (result.ok) {
      GameUiHelper.createTipText(
        result.stoppedByBag ? texts.claimAllStopped : texts.claimAllDone.split("{count}").join(`${result.claimedCount}`),
      );
      return;
    }
    GameUiHelper.createTipText(result.code === CODE_BAG_FULL ? texts.claimBagFull : texts.claimFailed);
  }

  private async onRemove(row: MailView, removable: boolean) {
    if (!removable) {
      GameUiHelper.createTipText(texts.removeUnclaimed);
      return;
    }
    const result = await MailStore.remove(row.id);
    if (!this.isOpen()) return;
    if (!result.ok) GameUiHelper.createTipText(result.code === CODE_UNCLAIMED ? texts.removeUnclaimed : texts.removeFailed);
  }

  //#endregion

  private reset() {
    this.dialog = null;
    this.body = null;
  }
}
