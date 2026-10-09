import { Button, Graphics, Label, Layout, Node, ScrollView, Vec2, isValid } from "cc";
import { AnnouncementApi } from "../../utils/net/Api";
import type { AnnouncementView } from "../../../configs/announcement";
import { buildAnnouncementViews } from "../../../configs/announcement";
import { announcementBoardDialogLayout as layout, uiImages } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import AnnouncementReadStore from "../../core/AnnouncementReadStore";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";

/**
 * 游戏内公告板（左列表 + 右详情）
 *
 * 数据来源是公共接口 `GET /announcements/active`（**无需令牌**，所以登录页那个提醒弹窗用的是同一个接口）
 * —— 服务端只给「当前生效中」的一批，客户端不自己判断生效与否（那套判据在服务端 SQL 里，见服务端
 * announcement.repository 的 ACTIVE_SQL）。
 *
 * 未读标记的口径：拉回来的那批公告各自与**本地已读记录**（AnnouncementReadStore）比对，
 * 只影响展示（亮色标题 + 圆点）。打开公告板即把这一批全部记为已读，但**标记发生在渲染之后**，
 * 所以本次打开仍然看得到哪几条是新的；已读数同时回调给入口（小地图的未读红点）。
 *
 * 拉取失败走 silent（失败不弹全局提示），改为在右栏给一句兜底说明：公告拉不到不该打断游戏。
 */
export default class AnnouncementBoardDialog {
  /** 弹窗根（未打开时为 null；被关闭按钮销毁后由 isValid 判定为失效） */
  private dialog: Node | null = null;
  /** 左栏条目列表的内容容器（每次拉取重建全部条目） */
  private listContent: Node | null = null;
  /** 右栏：标题 / 级别 · 时间窗 / 正文（标题与元信息复用同一个节点改文本，正文每次重建） */
  private detailTitle: Node | null = null;
  private detailMeta: Node | null = null;
  private bodyScroll: Node | null = null;
  private bodyContent: Node | null = null;
  /** 条目的选中底色节点（按公告 id 索引，切换选中只改 active，不重建列表） */
  private highlights = new Map<string, Node>();
  /** 本次拉到的公告（渲染数据） */
  private views: AnnouncementView[] = [];
  /** 未读条数变化的回调（入口小红点由持有方画，本类不关心红点长什么样） */
  private onUnreadChange: ((unread: number) => void) | null;

  constructor(onUnreadChange?: (unread: number) => void) {
    this.onUnreadChange = onUnreadChange ?? null;
  }

  /** 打开 / 再点一次关闭 */
  open() {
    if (this.isOpen()) {
      this.close();
      return;
    }
    // 场景切换时弹窗会被连带销毁，这里清理失效引用（否则会一直以为它还开着）
    if (this.dialog && !isValid(this.dialog)) this.reset();
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 左：公告列表（可上下滑动）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listContent = list.getComponent(ScrollView).content;
    // 条目间距取配置：createScrollView 的默认间距是给卡片列表用的（太挤）
    this.listContent.getComponent(Layout).spacingY = layout.list.itemGap;
    dialog.addChild(list);
    // 右：标题 / 级别 · 时间窗 / 正文滚动区
    const detail = layout.detail;
    this.detailTitle = UiHelper.createLabel(detail.title.name, "", detail.title.color, detail.title.fontSize, detail.title.position, detail.title.size);
    // 标题单行放不下时缩字号而不是换行：换行会向下顶开下面的元信息与正文区
    this.detailTitle.getComponent(Label).overflow = Label.Overflow.SHRINK;
    dialog.addChild(this.detailTitle);
    this.detailMeta = UiHelper.createLabel(detail.meta.name, "", detail.meta.color, detail.meta.fontSize, detail.meta.position, detail.meta.size);
    dialog.addChild(this.detailMeta);
    const bodyScroll = GameUiHelper.createScrollView(detail.scroll.name, detail.scroll.position, detail.scroll.size);
    this.bodyScroll = bodyScroll;
    this.bodyContent = bodyScroll.getComponent(ScrollView).content;
    dialog.addChild(bodyScroll);
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
    // 拉取完成前先给一句兜底说明，免得右侧一片空
    this.setDetail("", getText("label_announcement_empty"));
    void this.load();
  }

  /** 关闭并销毁（入口的红点状态不受影响：那一批已经被记为已读了） */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  /** 清掉所有与弹窗绑定的引用（弹窗销毁/关闭后旧节点全部失效） */
  private reset() {
    this.dialog = null;
    this.listContent = null;
    this.detailTitle = null;
    this.detailMeta = null;
    this.bodyScroll = null;
    this.bodyContent = null;
    this.highlights.clear();
    this.views = [];
  }

  private isOpen(): boolean {
    return Boolean(this.dialog && isValid(this.dialog) && this.dialog.active);
  }

  /** 拉取生效中公告并渲染（失败在右栏给说明，红点保持原状） */
  private async load() {
    try {
      const list = await AnnouncementApi.active({ silent: true });
      // 拉取期间可能已经关掉弹窗或切了场景：此时不再碰节点
      if (!this.isOpen() || !this.listContent) return;
      this.render(buildAnnouncementViews(list, AnnouncementReadStore.getReadIds()));
    } catch {
      if (!this.isOpen()) return;
      clearChildren(this.listContent);
      this.highlights.clear();
      this.setDetail("", getText("label_announcement_load_failed"));
    }
  }

  /** 渲染列表与详情（列表按「重要在前」的顺序重建，选中第一条） */
  private render(views: AnnouncementView[]) {
    this.views = views;
    this.highlights.clear();
    clearChildren(this.listContent);
    views.forEach((view, index) => this.listContent.addChild(this.createItem(view, index)));
    if (views.length === 0) {
      this.setDetail("", getText("label_announcement_empty"));
    } else {
      this.select(views[0].id);
    }
    this.markAllRead(views);
  }

  /**
   * 打开公告板即把这一批生效中的公告全部记为已读
   *
   * 整批而不是逐条：列表上一次性就能看到全部标题，做成「点开哪条才算哪条已读」只会让未读红点
   * 永远留着（玩家扫一眼标题就知道和自己有没有关系）。调用点固定在**渲染之后**，
   * 本次打开仍然能看到哪几条是新的。
   */
  private markAllRead(views: readonly AnnouncementView[]) {
    const ids: string[] = [];
    views.forEach((view) => ids.push(view.id));
    AnnouncementReadStore.markRead(ids, ids);
    this.onUnreadChange?.(0);
  }

  /** 一个公告条目：选中底色 + 未读圆点 + 标题 + 级别 · 时间窗 */
  private createItem(view: AnnouncementView, index: number) {
    const item = layout.list;
    const card = UiHelper.createNode(`${item.name}_item_${index}`, new Vec2(), item.itemSize);
    const button = card.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 选中底色（先加，压在文字下面；切换选中只改 active，不重建列表）
    const highlight = UiHelper.createNode(`${item.name}_item_selected_${index}`, new Vec2());
    const graphics = highlight.addComponent(Graphics);
    graphics.fillColor = item.selectedFill;
    graphics.rect(-item.itemSize.width / 2, -item.itemSize.height / 2, item.itemSize.width, item.itemSize.height);
    graphics.fill();
    highlight.active = false;
    card.addChild(highlight);
    this.highlights.set(view.id, highlight);
    // 未读圆点（已读的条目不显示）
    if (view.unread) {
      const dot = UiHelper.createSprite(`${item.name}_item_dot_${index}`, uiImages.dot, item.itemDot.position, item.itemDot.size);
      card.addChild(dot);
    }
    // 标题（未读用亮色，已读压暗）+ 级别 · 时间窗
    const titleColor = view.unread ? item.unreadTitleColor : item.readTitleColor;
    card.addChild(UiHelper.createLabel(`${item.name}_item_title_${index}`, view.title, titleColor, item.itemTitleFontSize, item.itemTitle.position, item.itemTitle.size, Label.HorizontalAlign.LEFT));
    card.addChild(UiHelper.createLabel(`${item.name}_item_meta_${index}`, this.itemMeta(view), item.itemMetaColor, item.itemMetaFontSize, item.itemMeta.position, item.itemMeta.size, Label.HorizontalAlign.LEFT));
    card.on(Node.EventType.TOUCH_END, () => this.select(view.id), this);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton）：鼠标通道也要补一次命中拦截
    blockClickThrough(card);
    return card;
  }

  /** 切换选中：只改底色的 active 与右栏内容（列表不重建） */
  private select(id: string) {
    const view = this.views.filter((item) => item.id === id)[0];
    if (!view) return;
    this.highlights.forEach((node, itemId) => {
      if (isValid(node)) node.active = itemId === id;
    });
    this.setDetail(view.title, this.itemMeta(view));
    if (!this.bodyContent) return;
    const body = layout.detail.body;
    clearChildren(this.bodyContent);
    this.bodyContent.addChild(
      UiHelper.createWrappedLabel(body.name, view.content, body.color, body.fontSize, body.lineHeight, new Vec2(), body.width, Label.HorizontalAlign.LEFT),
    );
    // 换了一条公告就把正文滚回顶部；先强制排版再滚 —— 新正文的高度要等排版后才算出来
    this.bodyContent.getComponent(Layout).updateLayout(true);
    this.bodyScroll.getComponent(ScrollView).scrollToTop(0);
  }

  /** 右栏上半部分：标题与元信息（没有内容时元信息位兼作空态/失败提示） */
  private setDetail(title: string, meta: string) {
    if (this.detailTitle) this.detailTitle.getComponent(Label).string = title;
    if (this.detailMeta) this.detailMeta.getComponent(Label).string = meta;
  }

  /** 条目的第二行：级别 · 时间窗（两段文案各自的模板都在 configs/texts） */
  private itemMeta(view: AnnouncementView): string {
    return getText("label_announcement_item_meta", { level: getText(view.levelTextKey), window: view.timeText });
  }
}
