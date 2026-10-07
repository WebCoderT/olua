import { Color, Graphics, isValid, Label, Layout, Node, ScrollView, Size, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import { Draggable } from "../input/Draggable";
import { blockClickThrough } from "../../utils/input/UiHit";
import { trackUiPress } from "../../utils/input/Pointer";
import { mallDialogLayout, uiImages } from "../../../configs/hudLayout";
import { getMallGoods, mallPrice } from "../../../configs/mall";
import { getEquipmentNameParts } from "../../../configs/equipments";
import { getText } from "../../../configs/texts";
import { Equipment } from "../../../types/good";

/** 弹窗布局（几何、用图与列表参数统一见 configs/hudLayout.mallDialogLayout） */
const layout = mallDialogLayout;

/**
 * 商城弹窗
 *
 * 商品 = 系统内全部装备（含 15 品质变体，见 configs/mall.getMallGoods），统一 1 绑定元宝/件，
 * 买下直接进背包（第一个空格）。本类只做陈列与交互，商品表/价格/扣款入包都在数据层：
 * - 列表：滚动浏览全部商品，每行 3 张卡片 = 图标（鼠标悬停看完整详情）+ 名称两段式 + 「购买」按钮
 * - 购买：StorageManager.buyMallGood（余额不足/背包满/商品下架都会给出提示，失败时余额与背包都不动）
 * - 顶部：全场统一价说明 + 绑定元宝余额（购买成功后原地刷新）
 *
 * **列表虚拟化**：商品有几百件，全开会有几千个节点参与渲染与命中判定、滚动会卡；
 * 于是卡片只在开窗时建一次、位置手动摆（固定行列），再按滚动位置只激活视口附近的几行
 * （见 updateVirtualRows）。手动摆位是必须的 —— 卡片随激活开关增减，交给 Layout 自动排会把
 * 已关闭的卡片当不存在、整列塌缩。
 *
 * 实例由使用方（BottomBar）创建持有，不导出全局单例。
 */
export default class MallDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 列表 content（卡片挂在它下面；虚拟化按它的位置算可见区间） */
  private listContent: Node | null = null;
  /** 商品卡片（与 getMallGoods() 一一对应，只激活视口附近的几行） */
  private cards: Node[] = [];
  /** 绑定元宝余额标签（购买成功后刷新） */
  private bindGoldLabel: Node | null = null;
  /** 悬停详情（同一时刻最多一个：换悬停、滚动、关弹窗都会先收掉它） */
  private detailDialog: Node | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换中被销毁时清理残留引用
    if (this.dialog && !isValid(this.dialog)) this.dialog = null;
    this.build();
  }

  /** 关闭弹窗 */
  close() {
    this.closeDetail();
    this.cards = [];
    this.listContent = null;
    this.bindGoldLabel = null;
    this.dialog?.destroy();
    this.dialog = null;
  }

  //#region 组装

  /** 组装弹窗：背景图 + 标题/关闭 + 价签与余额 + 商品列表 */
  private build() {
    // 弹窗主体 = 商城背景图。不用 createDialogBg：那张图固定是通用弹窗框，商城有自己的门面底图；
    // 拖动与鼠标拦截照旧补上（拖动会跟 ScrollView 抢手势，见 Draggable 的按下点判定）
    const dialog = UiHelper.createSprite(layout.name, layout.background, new Vec2(), layout.size);
    dialog.addComponent(Draggable);
    blockClickThrough(dialog);
    const closeButton = UiHelper.createButton(`${layout.name}_close_button`, uiImages.closeButton, layout.closeButton.position, layout.closeButton.size);
    closeButton.on(Node.EventType.TOUCH_END, () => this.close(), this);
    dialog.addChild(closeButton);
    this.bindGoldLabel = UiHelper.createLabel("mall_bind_gold", "", layout.bindGold.color, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    // 商品列表（滚动 + 虚拟化）
    const scroll = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    const scrollView = scroll.getComponent(ScrollView)!;
    const content = scrollView.content!;
    // 关掉自动排版：卡片位置手动摆（虚拟化要开关卡片节点，见类注释）
    const contentLayout = content.getComponent(Layout)!;
    contentLayout.type = Layout.Type.NONE;
    contentLayout.resizeMode = Layout.ResizeMode.NONE;
    const goods = getMallGoods();
    const columns = layout.card.columns;
    const pitch = layout.card.height + layout.card.gapY;
    const totalRows = Math.ceil(goods.length / columns);
    content.getComponent(UITransform)!.setContentSize(layout.list.size.width, totalRows * pitch);
    // 卡片宽 = 列表宽均分（扣掉列间距）；x 按列以中线对称展开，y 按行从 0 往下排（content 锚点在顶部）
    const cardWidth = (layout.list.size.width - (columns - 1) * layout.card.gapX) / columns;
    this.cards = goods.map((good, index) => {
      const card = this.createCard(good, cardWidth);
      card.setPosition(((index % columns) - (columns - 1) / 2) * (cardWidth + layout.card.gapX), -(Math.floor(index / columns) * pitch + pitch / 2));
      content.addChild(card);
      return card;
    });
    this.listContent = content;
    // 滚动时重算可见区间；悬停详情也一并收掉（那件商品已经被滚走了）
    scrollView.node.on(
      ScrollView.EventType.SCROLLING,
      () => {
        this.closeDetail();
        this.updateVirtualRows();
      },
      this,
    );
    dialog.addChild(scroll);
    this.updateVirtualRows();
    this.refreshBindGold();
    this.dialog = dialog;
    LayerManager.addToUILayer(dialog);
  }

  /**
   * 创建单张商品卡片：图标（悬停看详情）+ 名称两段式（本体一行 + 前缀/后缀一行）+ 「购买」按钮
   * 卡片内几何全部由布局配置推导（顶边距 → 图标 → 名称 → 前后缀 → 按钮），界面里不写死像素
   */
  private createCard(good: Equipment, width: number) {
    const height = layout.card.height;
    const card = UiHelper.createNode(`mall_card_${good.id}`, new Vec2(), new Size(width, height));
    // 卡片底：Graphics 自绘（深色填充 + 细金边）。橱窗底色本来就深，描一圈金边把卡片勾出来；
    // 自绘不依赖底图拉伸（格子底图换个比例拉会歪），配色见 mallDialogLayout.card
    const graphics = card.addComponent(Graphics);
    graphics.fillColor = layout.card.fill;
    graphics.strokeColor = layout.card.borderColor;
    graphics.lineWidth = layout.card.borderWidth;
    graphics.rect(-width / 2, -height / 2, width, height);
    graphics.fill();
    graphics.stroke();
    // 纵向节奏：每件都是「上一件的下缘 − 配置的间距」，改尺寸/间距只动配置
    const iconY = height / 2 - layout.card.paddingTop - layout.card.iconSize.height / 2;
    const nameY = iconY - layout.card.iconSize.height / 2 - layout.card.name.gapY - layout.card.name.lineHeight / 2;
    const extraY = nameY - layout.card.name.lineHeight / 2 - layout.card.extra.gapY - layout.card.extra.lineHeight / 2;
    const buttonY = extraY - layout.card.extra.lineHeight / 2 - layout.card.buyButton.gapY - layout.card.buyButton.size.height / 2;
    // 图标：鼠标悬停显示完整详情（与背包格子同一套零件：位置按锚点世界坐标现算）
    const icon = UiHelper.createSprite(`mall_good_${good.id}`, good.icon, new Vec2(0, iconY), layout.card.iconSize);
    icon.on(Node.EventType.MOUSE_ENTER, () => this.openDetail(good, icon), this);
    // 图标只注册了悬停事件，这条链上（卡片 → 列表 → 弹窗）没有别的「按压起点记录点」，
    // 自己登记一次：按下图标时记下起点，抬起判定才不会拿到上一次按压的旧起点（见 utils/input/Pointer）
    trackUiPress(icon);
    card.addChild(icon);
    // 名称两段式：本体一行（大字）+ 前缀/后缀一行（小字）——取段与取色同走 getEquipmentNameParts
    // （与详情弹窗、地面掉落名同源，不另写色表）；卡片窄，本体名超长时自动缩字（SHRINK），
    // 逐段配色的完整版在悬停详情里
    const parts = getEquipmentNameParts(good);
    const textWidth = width - layout.card.paddingX * 2;
    const nameLabel = UiHelper.createLabel(
      `mall_card_name_${good.id}`,
      parts.label,
      parts.prefix.color,
      layout.card.name.fontSize,
      new Vec2(0, nameY),
      new Size(textWidth, layout.card.name.lineHeight),
    );
    nameLabel.getComponent(Label)!.overflow = Label.Overflow.SHRINK;
    card.addChild(nameLabel);
    card.addChild(
      UiHelper.createLabel(
        `mall_card_extra_${good.id}`,
        `${parts.prefix.label}${parts.suffix.label}`,
        parts.prefix.color,
        layout.card.extra.fontSize,
        new Vec2(0, extraY),
        new Size(textWidth, layout.card.extra.lineHeight),
      ),
    );
    // 购买：规则判定与提示都在数据层（余额不足/背包满/下架都不会改数据），成功后只刷余额
    const button = UiHelper.createButton(`mall_buy_${good.id}`, uiImages.smallButtonBackground, new Vec2(0, buttonY), layout.card.buyButton.size);
    button.addChild(UiHelper.createLabel(`${button.name}_label`, getText("label_mall_buy"), Color.WHITE, layout.card.buyButton.fontSize, new Vec2(), layout.card.buyButton.size));
    button.on(
      Node.EventType.TOUCH_END,
      () => {
        if (StorageManager.buyMallGood(good.id ?? "")) this.refreshBindGold();
      },
      this,
    );
    card.addChild(button);
    return card;
  }

  //#endregion

  //#region 虚拟化与刷新

  /**
   * 按滚动位置只激活视口附近的商品卡片（上下各多留 virtualBuffer 行，滚动时不露白）
   * 先按行算可见行区间，再展开成卡片下标（同一行的卡片一起激活）
   * content 锚点在顶部：初始 y = 视口半高（顶边对齐视口顶边），往下滚 y 变大
   */
  private updateVirtualRows() {
    const content = this.listContent;
    if (!content || !isValid(content)) return;
    const viewHeight = layout.list.size.height;
    const scrolled = Math.max(0, content.position.y - viewHeight / 2);
    const columns = layout.card.columns;
    const pitch = layout.card.height + layout.card.gapY;
    const totalRows = Math.ceil(this.cards.length / columns);
    const firstRow = Math.max(0, Math.floor(scrolled / pitch) - layout.virtualBuffer);
    const lastRow = Math.min(totalRows - 1, Math.ceil((scrolled + viewHeight) / pitch) + layout.virtualBuffer);
    const first = firstRow * columns;
    const last = Math.min(this.cards.length - 1, (lastRow + 1) * columns - 1);
    this.cards.forEach((card, index) => {
      card.active = index >= first && index <= last;
    });
  }

  /** 刷新绑定元宝余额（购买成功后调用） */
  private refreshBindGold() {
    const role = StorageManager.findOnlineRole();
    if (!this.bindGoldLabel || !isValid(this.bindGoldLabel) || !role) return;
    this.bindGoldLabel.getComponent(Label)!.string = getText("label_bind_gold", { value: role.bindGold });
  }

  //#endregion

  //#region 悬停详情

  /** 显示某件商品的完整详情（挂在 UI 层顶层，与物品格子的悬停详情同一套零件） */
  private openDetail(good: Equipment, anchor: Node) {
    this.closeDetail();
    const detail = GameUiHelper.createGoodDetailDialog(good, anchor);
    this.detailDialog = detail;
    LayerManager.addToUILayer(detail);
    // 本节点接下来要注册 MOUSE_LEAVE，按压起点登记必须齐（幂等：createCard 里已登记过同一节点）
    trackUiPress(anchor);
    // 移出、或图标被销毁（关弹窗、卡片被销毁）都要收掉详情：
    // 否则图标没了就不会再触发 MOUSE_LEAVE，详情会永久留在屏幕上并挡住后续点击
    anchor.once(Node.EventType.MOUSE_LEAVE, () => this.closeDetail(), this);
    anchor.once(Node.EventType.NODE_DESTROYED, () => this.closeDetail(), this);
  }

  /** 收掉悬停详情（没开着时什么也不做） */
  private closeDetail() {
    if (this.detailDialog && isValid(this.detailDialog)) this.detailDialog.destroy();
    this.detailDialog = null;
  }

  //#endregion
}
