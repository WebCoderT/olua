import { Color, isValid, Label, Layout, Node, ScrollView, Size, UITransform, Vec2 } from "cc";
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
 * - 列表：滚动浏览全部商品，每行 = 图标（鼠标悬停看完整详情）+ 三段名称 + 「购买」按钮
 * - 购买：StorageManager.buyMallGood（余额不足/背包满/商品下架都会给出提示，失败时余额与背包都不动）
 * - 顶部：全场统一价说明 + 绑定元宝余额（购买成功后原地刷新）
 *
 * **列表虚拟化**：商品有几百件，全开会有几千个节点参与渲染与命中判定、滚动会卡；
 * 于是行节点只在开窗时建一次、位置手动摆（固定行距），再按滚动位置只激活视口附近的几行
 * （见 updateVirtualRows）。手动摆位是必须的 —— 行随激活开关增减，交给 Layout 自动排会把
 * 已关闭的行当不存在、整列塌缩。
 *
 * 实例由使用方（BottomBar）创建持有，不导出全局单例。
 */
export default class MallDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 列表 content（行挂在它下面；虚拟化按它的位置算可见区间） */
  private listContent: Node | null = null;
  /** 商品行（与 getMallGoods() 一一对应，只激活视口附近的几行） */
  private rows: Node[] = [];
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
    this.rows = [];
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
    // 标题与关闭按钮
    dialog.addChild(
      UiHelper.createLabel(`${layout.name}_title`, layout.title, layout.titleStyle.color, layout.titleStyle.fontSize, layout.titleStyle.position, layout.titleStyle.size),
    );
    const closeButton = UiHelper.createButton(`${layout.name}_close_button`, uiImages.closeButton, layout.closeButton.position, layout.closeButton.size);
    closeButton.on(Node.EventType.TOUCH_END, () => this.close(), this);
    dialog.addChild(closeButton);
    // 顶部：全场统一价（价格来自 configs/mall，界面不写死）+ 绑定元宝余额
    dialog.addChild(
      UiHelper.createLabel("mall_price_note", getText("mall_price_note", { price: mallPrice }), layout.priceNote.color, layout.priceNote.fontSize, layout.priceNote.position, layout.priceNote.size),
    );
    this.bindGoldLabel = UiHelper.createLabel("mall_bind_gold", "", layout.bindGold.color, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    // 商品列表（滚动 + 虚拟化）
    const scroll = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    const scrollView = scroll.getComponent(ScrollView)!;
    const content = scrollView.content!;
    // 关掉自动排版：行位置手动摆（虚拟化要开关行节点，见类注释）
    const contentLayout = content.getComponent(Layout)!;
    contentLayout.type = Layout.Type.NONE;
    contentLayout.resizeMode = Layout.ResizeMode.NONE;
    const goods = getMallGoods();
    const pitch = layout.row.height + layout.row.spacing;
    content.getComponent(UITransform)!.setContentSize(layout.list.size.width, goods.length * pitch);
    this.rows = goods.map((good, index) => {
      const row = this.createRow(good);
      // content 锚点在顶部：行从 0 往下依次排（y 为负）
      row.setPosition(0, -(index * pitch + pitch / 2));
      content.addChild(row);
      return row;
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
   * 创建单行商品：图标（悬停看详情）+ 前缀/名称/后缀三段文字 + 「购买」按钮
   * 行内坐标全部由布局配置推导（左缘 = 图标、右缘 = 按钮），界面里不写死像素
   */
  private createRow(good: Equipment) {
    const width = layout.list.size.width;
    const row = UiHelper.createNode(`mall_row_${good.id}`, new Vec2(), new Size(width, layout.row.height));
    // 图标：鼠标悬停显示完整详情（与背包格子同一套零件：位置按锚点世界坐标现算）
    const icon = UiHelper.createSprite(`mall_good_${good.id}`, good.icon, new Vec2(-width / 2 + layout.row.paddingX + layout.row.iconSize.width / 2, 0), layout.row.iconSize);
    icon.on(Node.EventType.MOUSE_ENTER, () => this.openDetail(good, icon), this);
    // 图标只注册了悬停事件，这条链上（行 → 列表 → 弹窗）没有别的「按压起点记录点」，
    // 自己登记一次：按下图标时记下起点，抬起判定才不会拿到上一次按压的旧起点（见 utils/input/Pointer）
    trackUiPress(icon);
    row.addChild(icon);
    // 名称：段文案与取色同走 getEquipmentNameParts（与详情弹窗、地面掉落名同源，不另写色表）；
    // 行内空间有限，三段并成一行用前缀色渲染，逐段配色的完整版在悬停详情里
    const parts = getEquipmentNameParts(good);
    const nameLeft = -width / 2 + layout.row.paddingX + layout.row.iconSize.width + layout.row.name.gapX;
    row.addChild(
      UiHelper.createLabel(
        `mall_row_name_${good.id}`,
        `${parts.prefix.label}${parts.label}${parts.suffix.label}`,
        parts.prefix.color,
        layout.row.name.fontSize,
        new Vec2(nameLeft + layout.row.name.width / 2, 0),
        new Size(layout.row.name.width, layout.row.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    // 购买：规则判定与提示都在数据层（余额不足/背包满/下架都不会改数据），成功后只刷余额
    const button = UiHelper.createButton(
      `mall_buy_${good.id}`,
      uiImages.smallButtonBackground,
      new Vec2(width / 2 - layout.row.paddingX - layout.row.buyButton.size.width / 2, 0),
      layout.row.buyButton.size,
    );
    button.addChild(UiHelper.createLabel(`${button.name}_label`, getText("label_mall_buy"), Color.WHITE, layout.row.buyButton.fontSize, new Vec2(), layout.row.buyButton.size));
    button.on(
      Node.EventType.TOUCH_END,
      () => {
        if (StorageManager.buyMallGood(good.id ?? "")) this.refreshBindGold();
      },
      this,
    );
    row.addChild(button);
    return row;
  }

  //#endregion

  //#region 虚拟化与刷新

  /**
   * 按滚动位置只激活视口附近的商品行（上下各多留 virtualBuffer 行，滚动时不露白）
   * content 锚点在顶部：初始 y = 视口半高（顶边对齐视口顶边），往下滚 y 变大
   */
  private updateVirtualRows() {
    const content = this.listContent;
    if (!content || !isValid(content)) return;
    const viewHeight = layout.list.size.height;
    const scrolled = Math.max(0, content.position.y - viewHeight / 2);
    const pitch = layout.row.height + layout.row.spacing;
    const first = Math.max(0, Math.floor(scrolled / pitch) - layout.virtualBuffer);
    const last = Math.min(this.rows.length - 1, Math.ceil((scrolled + viewHeight) / pitch) + layout.virtualBuffer);
    this.rows.forEach((row, index) => {
      row.active = index >= first && index <= last;
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
    // 本节点接下来要注册 MOUSE_LEAVE，按压起点登记必须齐（幂等：createRow 里已登记过同一节点）
    trackUiPress(anchor);
    // 移出、或图标被销毁（关弹窗、行被销毁）都要收掉详情：
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
