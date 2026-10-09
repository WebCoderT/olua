import { EventTouch, Graphics, Label, Layout, Node, ScrollView, Size, UITransform, Vec2, isValid } from "cc";
import { AnnouncementApi } from "../../utils/net/Api";
import type { AnnouncementView } from "../../../configs/announcement";
import { buildAnnouncementViews, pickNoticeAnnouncements } from "../../../configs/announcement";
import { announcementNoticeDialogLayout as layout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import { blockClickThrough } from "../../utils/input/UiHit";
import { getVisibleSize } from "../../utils/layout/ScreenLayout";
import { clearChildren } from "../../utils/node/NodeTree";

/**
 * 登录页公告提醒（全屏模态）
 *
 * 只在「有生效中的重要公告」时才建节点挂上去；一条都没有（或拉取失败）**静默返回** ——
 * 登录页不该因为公告系统出问题多一个空弹窗，何况此时还没登录、也无从告知玩家（拉取走 silent）。
 *
 * 与游戏内公告板（AnnouncementBoardDialog）有意不同的两点：
 * 1. **不按已读过滤**：停机维护这类公告，玩家每次进游戏前都该看到 —— 判据就是「有没有重要公告」；
 * 2. 挂载点由调用方给：登录场景从不调 LayerManager.initLayer，那个 UI 图层容器根本不在场景树里
 *    （见 GameUiHelper.mountFloatingTip 的说明），挂上去既不渲染也不响应。所以弹窗挂在
 *    登录场景自己的节点上，输入独占也只用「遮罩 TOUCH_* 停冒泡 + 鼠标通道登记」这一套，
 *    不依赖弹窗层级的置顶（登录场景里本来就只有它一个弹窗）。
 */
export default class AnnouncementNoticeDialog {
  /** 弹窗根（未打开时为 null） */
  private dialog: Node | null = null;

  /** 打开：拉取公告 → 只有存在重要公告才挂到 host 上 */
  async open(host: Node): Promise<void> {
    if (this.dialog && isValid(this.dialog)) return;
    let views: AnnouncementView[];
    try {
      const list = await AnnouncementApi.active({ silent: true });
      // 已读记录这里刻意不参与（见类注释第 1 条）：读到的 id 传空数组
      views = pickNoticeAnnouncements(buildAnnouncementViews(list, []));
    } catch {
      return;
    }
    if (views.length === 0) return;
    // 拉取期间可能已经切走场景（登录成功 → Loading → 选角），此时不再建节点
    if (!isValid(host)) return;
    this.dialog = this.create(views);
    host.addChild(this.dialog);
  }

  /** 关闭并销毁 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
  }

  /** 组装弹窗（几何、配色与用图全部来自 configs/hudLayout.announcementNoticeDialogLayout） */
  private create(views: AnnouncementView[]): Node {
    const dialog = new Node(layout.name);
    // 全屏尺寸取「可见区」而不是设计分辨率：任意窗口宽高比都要盖满（与确认框同一口径）
    const screenSize = getVisibleSize();
    dialog.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    // 遮罩：黑色半透明 + 兼作下层点击的拦截层
    const mask = new Node(`${layout.name}_mask`);
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    dialog.addChild(mask);
    // 居中面板
    const panel = UiHelper.createSprite(layout.panel.name, layout.panel.background, new Vec2(), layout.panel.size);
    dialog.addChild(panel);
    const title = layout.titleLabel;
    panel.addChild(UiHelper.createLabel(title.name, layout.title, title.color, title.fontSize, title.position, title.size));
    // 公告列表（纵向滚动，每条自己撑高）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    const content = list.getComponent(ScrollView).content;
    // 条目间距取配置：createScrollView 的默认间距是给卡片列表用的
    content.getComponent(Layout).spacingY = layout.item.itemGap;
    clearChildren(content);
    views.forEach((view, index) => content.addChild(this.createItem(view, index)));
    panel.addChild(list);
    // 「我知道了」：关掉即销毁（公告板里才是查阅全部公告的地方）
    const confirmButton = GameUiHelper.createMiddleButton(layout.confirmButton.name, layout.confirmButton.text, layout.confirmButton.position);
    confirmButton.on(Node.EventType.TOUCH_END, () => this.close(), this);
    panel.addChild(confirmButton);
    this.setupInputOwnership(dialog);
    return dialog;
  }

  /** 一条重要公告：标题 / 级别 · 时间窗 / 正文（三者都按内容撑高，纵向排列） */
  private createItem(view: AnnouncementView, index: number): Node {
    const item = layout.item;
    const node = UiHelper.createFlexCol(`${layout.name}_item_${index}`, item.rowGap, new Vec2(), new Size(item.width, 0));
    const lines = [
      { text: view.title, style: item.title },
      { text: this.itemMeta(view), style: item.meta },
      { text: view.content, style: item.body },
    ];
    lines.forEach((line, lineIndex) => {
      node.addChild(
        UiHelper.createWrappedLabel(
          `${layout.name}_item_${index}_line_${lineIndex}`,
          line.text,
          line.style.color,
          line.style.fontSize,
          line.style.lineHeight,
          new Vec2(),
          item.width,
          Label.HorizontalAlign.LEFT,
        ),
      );
    });
    return node;
  }

  /** 第二行：级别 · 时间窗（两段文案各自的模板都在 configs/texts） */
  private itemMeta(view: AnnouncementView): string {
    return getText("label_announcement_item_meta", { level: getText(view.levelTextKey), window: view.timeText });
  }

  /**
   * 输入独占：触摸通道让遮罩/面板独占本次触摸，鼠标通道命中即中断
   *
   * 触摸通道必须自己接管：登录页背后是可输入的账号/密码框，按下若穿透过去会弹出软键盘；
   * 鼠标通道交给 blockClickThrough（它登记的是 MOUSE_UP 的中断 + 把抬起交还世界侧）。
   */
  private setupInputOwnership(dialog: Node) {
    blockClickThrough(dialog);
    dialog.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 停住这次触摸的冒泡（不再传给下层的输入框与按钮） */
  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }
}
