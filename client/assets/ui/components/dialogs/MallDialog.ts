import { Button, Color, Graphics, isValid, Label, Node, Size, UIOpacity, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import { buttonTone, mallDialogLayout, T } from "../../../configs/hudLayout";
import { trackUiPress } from "../../utils/input/Pointer";
import { getMallCategories, getMallDailyLimit, getMallPrice, getMallRequiredLevel, getMallStock, isMallGoodListed, mallGoodCategoryOf } from "../../../configs/game-config";
import { getEquipmentNameParts } from "../../../configs/equipments";
import { getSellableGoods } from "../../../configs/items";
import { getText } from "../../../configs/texts";
import { Goods, isEquipment } from "../../../types/good";
import type { MallLimit } from "../../utils/net/ApiModels";

/** 弹窗布局（几何、用图与列表参数统一见 configs/hudLayout.mallDialogLayout） */
const layout = mallDialogLayout;

/**
 * 商城弹窗
 *
 * 商品 = 运营在管理端**手动上架**的物品（#758：分类 + 上架清单都在服务端，快照下发；
 * #763 起除了装备变体还有药品）。售价与购买等级每件各自配置。本类只做陈列与交互，
 * 商品表/价格/扣款入包都在数据层：
 * - 分类：顶部页签按快照 `mallCategories` 陈列，点页签切到该分类的商品（没建分类就显示空提示）
 * - 列表：当前分类内分页陈列，每页 3 列 × rowsPerPage 行卡片；单张卡片 = 图标（鼠标悬停看完整详情）
 *   + 名称两段式 + 「购买」按钮；页脚 = 首页 / 上一页 / 页码 / 下一页 / 末页
 * - 购买：StorageManager.buyMallGood（余额不足/背包满/商品下架都会给出提示，失败时余额与背包都不动）；
 *   **角色等级不够购买等级时按钮置灰禁点**（服务端同样校验，这里只是提前提示）
 * - 绑定元宝余额（购买成功后原地刷新）
 *
 * **药品与装备共用卡片骨架**（#763）：图标 + 名称 + 一行小字 + 购买按钮。差别只有两处 ——
 * 装备的名称是「前缀 + 本体 + 后缀」三段（品质行写前后缀），药品只有单段名称（小字写「药品」）。
 * 详情弹窗走同一个 `createGoodDetailDialog`，它本来就按 `good.type` 分支。
 *
 * **分页而不是滚动**：商品可能上百件。早先的做法是「一次性建满 + 滚动虚拟化」，打开商城时就要把
 * 几百张卡片（每张含 Graphics、图标、两个文字、按钮）全建出来 → 打开明显卡顿。改成分页后每页
 * 只建一页的卡片（columns × rowsPerPage 张），翻页时整页销毁重建 —— 节点数恒定为一页，
 * 打开商城只付一页的成本。
 *
 * 实例由使用方（BottomBar）创建持有，不导出全局单例。
 */
export default class MallDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 商品卡片区（分页容器：卡片与页脚页控件都挂在它下面） */
  private cardArea: Node | null = null;
  /** 当前页的卡片（翻页整批销毁重建，任何时刻只有一页的节点） */
  private cards: Node[] = [];
  /** 分类（打开时取一次，服务端已排好序）与当前页签 */
  private categories: Array<{ id: string; label: string }> = [];
  private activeCategory = "";
  /** 分类页签节点（切换页签时改底色/透明度，不重建） */
  private tabNodes: Node[] = [];
  /** 当前分类的商品（打开时取一次上架清单，切页签/翻页只切当前这一页，不遍历全表建节点） */
  private goods: Goods[] = [];
  /** 当前页码（0 起）与总页数 */
  private page = 0;
  private pageCount = 1;
  /** 页脚翻页控件（翻页后刷新页码文字与首/末页按钮的可用状态） */
  private pageIndicator: Node | null = null;
  private firstPageButton: Node | null = null;
  private prevPageButton: Node | null = null;
  private nextPageButton: Node | null = null;
  private lastPageButton: Node | null = null;
  /** 绑定元宝余额标签（购买成功后刷新） */
  private bindGoldLabel: Node | null = null;
  /** 空分类提示（当前分类没有商品 / 还没建分类时显示） */
  private emptyTip: Node | null = null;
  /** 悬停详情（同一时刻最多一个：换悬停、翻页、关弹窗都会先收掉它） */
  private detailDialog: Node | null = null;
  /**
   * 限购 / 库存（#846）：`goodId → 今日已购 / 已售 / 库存`
   *
   * 打开时异步拉一次（`StorageManager.loadMallLimits`），拉到后重绘当前页；购买回执里也带同一组数，
   * 买完就地更新。**空 Map 也能正常陈列与购买** —— 拉失败只是卡片上少了那几个小字。
   */
  private limits = new Map<string, MallLimit>();

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
    this.goods = [];
    this.categories = [];
    this.tabNodes = [];
    this.activeCategory = "";
    this.page = 0;
    this.pageCount = 1;
    this.cardArea = null;
    this.pageIndicator = null;
    this.firstPageButton = null;
    this.prevPageButton = null;
    this.nextPageButton = null;
    this.lastPageButton = null;
    this.bindGoldLabel = null;
    this.emptyTip = null;
    this.limits = new Map();
    this.dialog?.destroy();
    this.dialog = null;
  }

  //#region 组装

  /** 组装弹窗：标准弹窗框 + 余额胶囊 + 商品分页（08-mall 稿，矢量面板，不再用整图背景） */
  private build() {
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size, layout.eyebrow);
    // 标准框的 × 只销毁节点；商城持有一页卡片与悬停详情的引用，走 close() 统一收尾
    dialog.getChildByName(`${layout.name}_close_button`)?.on(Node.EventType.TOUCH_END, () => this.close(), this);
    // 余额胶囊（稿 .balance：暗底胶囊 + 金点 + 文字，右上角）
    const balance = GameUiHelper.createGlassPlate("mall_balance", layout.balance.size, layout.balance.size.height / 2, T.line[2], T.surface.scrim);
    balance.setPosition(layout.balance.position.x, layout.balance.position.y, 0);
    balance.addChild(GameUiHelper.createVectorDot("mall_balance_dot", T.gold[3], new Vec2(-layout.balance.size.width / 2 + 16, 0), new Size(layout.balance.dot, layout.balance.dot)));
    this.bindGoldLabel = UiHelper.createLabel(
      "mall_bind_gold", "", layout.balance.color, layout.balance.fontSize,
      new Vec2(10, 0), new Size(layout.balance.size.width - 34, layout.balance.size.height),
      Label.HorizontalAlign.LEFT,
    );
    balance.addChild(this.bindGoldLabel);
    dialog.addChild(balance);
    // 商品卡片区（分页容器：卡片与页脚都挂在它下面；不建滚动视图）
    const area = UiHelper.createNode(layout.list.name, layout.list.position, layout.list.size);
    this.cardArea = area;
    dialog.addChild(area);
    // 空分类提示（还没建分类 / 当前分类没有上架商品；renderPage 里按内容显隐）
    this.emptyTip = UiHelper.createLabel(layout.emptyTip.name, getText("mall_empty_tip"), layout.emptyTip.color, layout.emptyTip.fontSize, layout.emptyTip.position, layout.emptyTip.size);
    this.emptyTip.active = false;
    dialog.addChild(this.emptyTip);
    // 页脚翻页控件（首页 / 上一页 / 页码 / 下一页 / 末页）
    this.buildPagination(area);
    // 分类与上架清单各取一次（快照已按 sort_order 排好序）：装备 + 药品（#763），按当前分类陈列
    //
    // **必须先于 buildTabs**：页签是按 this.categories 建的，先建页签再取分类，
    // 建出来的就是零个页签 —— 表现为「客户端商城没有分类」（#765）。
    this.categories = getMallCategories().map((row) => ({ id: row.id, label: row.label }));
    this.activeCategory = this.categories[0]?.id ?? "";
    this.goods = getSellableGoods().filter((good) => isMallGoodListed(good.id ?? ""));
    this.pageCount = this.pageCountOf(this.activeCategory);
    // 分类页签（挂在弹窗上、卡片区外 —— 换分类时页签不重建，卡片整页重建）
    this.buildTabs(dialog);
    // 面板页脚（稿 .panel-foot）：购买扣款口径 + 置灰说明
    dialog.addChild(GameUiHelper.createDialogFoot("mall_foot", layout.size.width, layout.foot, getText("mall_foot_left"), getText("mall_foot_right")));
    this.renderPage(0);
    this.refreshBindGold();
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
    // 限购 / 库存在快照里只有配置，「今天买了几个」得问服务端（#846）：
    // 先按配置把卡片画出来，拉到运行数再重绘一次当前页 —— 不阻塞打开，商城不会因为一次失败请求打不开
    void this.loadLimits();
  }

  /** 拉一次限购 / 库存并重绘当前页（失败时保持着配置视图，不影响陈列与购买） */
  private async loadLimits() {
    const limits = await StorageManager.loadMallLimits();
    // 弹窗已经关掉 / 被场景切换销毁：别再往一个不存在的节点上画
    if (!this.dialog || !isValid(this.dialog)) return;
    this.limits = limits;
    this.renderPage(this.page);
  }

  /**
   * 卡片上的名称与品质行（#763 两类商品共用一套骨架）
   *
   * · 装备：三段名（前缀 + 本体 + 后缀），名称与品质行都用**前缀色** —— 与详情弹窗、地面掉落名同源，
   *   不在这里另写色表；
   * · 药品：没有前后缀，名称单段用 `name.plainColor`，类别行写「药品」（`kind.kindColor`）。
   *   那一行不能空着 —— 空着和「品质配置异常」看起来一样。
   */
  private nameOf(good: Goods): { label: string; color: Color; extra: string; extraColor: Color } {
    if (!isEquipment(good)) {
      return {
        label: good.label,
        color: layout.card.name.plainColor,
        extra: getText("mall_good_kind_drug"),
        extraColor: layout.card.kind.kindColor,
      };
    }
    const parts = getEquipmentNameParts(good);
    return {
      label: parts.label,
      color: parts.prefix.color,
      extra: `${parts.prefix.label}${parts.suffix.label}`,
      extraColor: parts.prefix.color,
    };
  }

  /**
   * 卡片品质行里追加的「今日 2/3 · 剩 5」(#846)
   *
   * 配置从快照读（`getMallDailyLimit` / `getMallStock`），运行数从 `this.limits` 读（接口/回执）；
   * 接口还没回来时按「今天买了 0 件、已售 0 件」显示配置那半 —— 不让卡片在两次渲染之间变空白。
   * 不限购（0）与不限量（-1）一个字都不加：没配这两条的商城与加字段之前长得一模一样。
   */
  private limitBitsOf(good: Goods): string {
    const id = good.id ?? "";
    const limit = this.limits.get(id);
    const dailyLimit = limit?.dailyLimit ?? getMallDailyLimit(id);
    const dailyBought = limit?.dailyBought ?? 0;
    const stock = limit?.stock ?? getMallStock(id);
    const sold = limit?.sold ?? 0;
    const bits: string[] = [];
    if (dailyLimit > 0) bits.push(getText("mall_daily_bought", { bought: dailyBought, limit: dailyLimit }));
    if (stock >= 0) bits.push(getText("mall_stock_left", { count: Math.max(0, stock - sold) }));
    return bits.join(getText("mall_extra_sep"));
  }

  /**
   * 创建单张商品卡片（08-mall 稿 .gcard）：顶行（图标 + 名称/类别）→ 限购/库存行 → 购买行（价格左、按钮右）
   * 卡片内几何全部由布局配置推导（padding → 顶行 → stats → 购买行贴底），界面里不写死像素
   * @param roleLevel 角色当前等级（购买等级不足时按钮置灰禁点，文案换「Lv.X 解锁」）
   */
  private createCard(good: Goods, width: number, roleLevel: number) {
    const height = layout.card.height;
    const padding = layout.card.padding;
    const card = UiHelper.createNode(`mall_card_${good.id}`, new Vec2(), new Size(width, height));
    // 卡片底：Graphics 自绘（稿 linear-gradient 170deg surface-3 → surface-2，Graphics 没有渐变用亮带叠；
    // 细灰描边勾卡片），配色见 mallDialogLayout.card 注释
    const graphics = card.addComponent(Graphics);
    graphics.fillColor = T.surface[3];
    graphics.roundRect(-width / 2, -height / 2, width, height, T.radius.r2);
    graphics.fill();
    const bandHeight = height * 0.4;
    graphics.fillColor = T.surface[2];
    graphics.roundRect(-width / 2, -height / 2, width, bandHeight, T.radius.r2);
    graphics.fill();
    graphics.lineWidth = T.border.width;
    graphics.strokeColor = T.line[2];
    graphics.roundRect(-width / 2, -height / 2, width, height, T.radius.r2);
    graphics.stroke();
    // 纵向节奏：顶行贴顶、购买行贴底，中间留给限购/库存行
    const topEdge = height / 2 - padding;
    const iconY = topEdge - layout.card.iconSize.height / 2;
    const textX = -width / 2 + padding + layout.card.iconSize.width + 10;
    const textWidth = width / 2 - padding - textX;
    const nameY = topEdge - layout.card.name.lineHeight / 2;
    const kindY = nameY - layout.card.name.lineHeight / 2 - layout.card.kind.lineHeight / 2;
    // 图标：鼠标悬停显示完整详情（位置按锚点世界坐标现算）
    const icon = UiHelper.createSprite(`mall_good_${good.id}`, good.icon, new Vec2(-width / 2 + padding + layout.card.iconSize.width / 2, iconY), layout.card.iconSize);
    icon.on(Node.EventType.MOUSE_ENTER, () => this.openDetail(good, icon), this);
    // 图标只注册了悬停事件，这条链上（卡片 → 列表 → 弹窗）没有别的「按压起点记录点」，
    // 自己登记一次：按下图标时记下起点，抬起判定才不会拿到上一次按压的旧起点（见 utils/input/Pointer）
    trackUiPress(icon);
    card.addChild(icon);
    // 名称两段式：本体一行（前缀色）+ 前缀/后缀一行（同色小字）——取段与取色同走 getEquipmentNameParts
    // （与详情弹窗、地面掉落名同源，不另写色表）；药品没有前后缀（#763）：名称单段、类别行写「药品」
    const parts = this.nameOf(good);
    const nameLabel = UiHelper.createLabel(
      `mall_card_name_${good.id}`,
      parts.label,
      parts.color,
      layout.card.name.fontSize,
      new Vec2(textX + textWidth / 2, nameY),
      new Size(textWidth, layout.card.name.lineHeight),
      Label.HorizontalAlign.LEFT,
    );
    nameLabel.getComponent(Label)!.overflow = Label.Overflow.SHRINK;
    card.addChild(nameLabel);
    // 类别行（装备 = 前缀+后缀；药品 = 「药品」；那行不能空着 —— 空着和「品质配置异常」看起来一样）
    const kindLabel = UiHelper.createLabel(
      `mall_card_kind_${good.id}`,
      parts.extra,
      parts.extraColor,
      layout.card.kind.fontSize,
      new Vec2(textX + textWidth / 2, kindY),
      new Size(textWidth, layout.card.kind.lineHeight),
      Label.HorizontalAlign.LEFT,
    );
    kindLabel.getComponent(Label)!.overflow = Label.Overflow.SHRINK;
    card.addChild(kindLabel);
    // 限购 / 库存行（#846）：「今日 2/3 · 剩 5」。不限购（0）与不限量（-1）一个字都不加 ——
    // 没配这两条的商城与加这两个字段之前长得一模一样
    const limitOf = this.limitBitsOf(good);
    if (limitOf) {
      card.addChild(
        UiHelper.createLabel(
          `mall_card_stats_${good.id}`,
          limitOf,
          layout.card.stats.color,
          layout.card.stats.fontSize,
          new Vec2(-width / 2 + padding + 60, -6),
          new Size(120, layout.card.stats.lineHeight),
          Label.HorizontalAlign.LEFT,
        ),
      );
    }
    // 购买行（贴底）：价格左（玩家点「购买」之前必须看得到要花多少）、按钮右
    const buyY = -height / 2 + padding + layout.card.buyButton.size.height / 2;
    card.addChild(
      UiHelper.createLabel(
        `mall_card_price_${good.id}`,
        getText("mall_price", { value: getMallPrice(good) }),
        layout.card.price.color,
        layout.card.price.fontSize,
        new Vec2(-width / 2 + padding + layout.card.price.blockWidth / 2, buyY),
        new Size(layout.card.price.blockWidth, layout.card.buyButton.size.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    // 购买：规则判定与提示都在数据层（余额不足/背包满/下架都不会改数据），成功后只刷余额。
    // 购买等级不足（#758）：按钮置灰禁点、文案换「Lv.X 解锁」—— 服务端同样校验（50027），
    // 这里置灰只是让玩家不用点了才被告知。限购买满 / 库存售罄（#846）同理：服务端 50029 / 50030
    const requiredLevel = getMallRequiredLevel(good.id ?? "");
    const levelLocked = requiredLevel > roleLevel;
    const limit = this.limits.get(good.id ?? "");
    const soldOut = limit ? limit.stock >= 0 && limit.sold >= limit.stock : getMallStock(good.id ?? "") === 0;
    const dailyFull = limit ? limit.dailyLimit > 0 && limit.dailyBought >= limit.dailyLimit : false;
    const locked = levelLocked || soldOut || dailyFull;
    const buttonText = levelLocked
      ? getText("mall_level_lock", { level: requiredLevel })
      : soldOut
        ? getText("mall_sold_out")
        : dailyFull
          ? getText("mall_daily_full")
          : getText("label_mall_buy");
    const button = GameUiHelper.createToneButton(`mall_buy_${good.id}`, buttonText, new Vec2(width / 2 - padding - layout.card.buyButton.size.width / 2, buyY), layout.card.buyButton.size, layout.card.buyButton.fontSize, buttonTone.gold);
    if (locked) {
      const buttonComp = button.getComponent(Button);
      if (buttonComp) buttonComp.interactable = false;
      const opacity = button.addComponent(UIOpacity);
      opacity.opacity = 110;
      // 整卡压暗（稿 .gcard.locked / .soldout 的置灰口径）
      const cardOpacity = card.getComponent(UIOpacity) ?? card.addComponent(UIOpacity);
      cardOpacity.opacity = layout.card.lockedOpacity;
    }
    button.on(
      Node.EventType.TOUCH_END,
      async () => {
        const limits = await StorageManager.buyMallGood(good.id ?? "");
        if (!limits) return;
        // 回执带着买完之后的数：就地更新并按新状态重绘当前页（买满 / 售罄的按钮要立刻置灰）
        this.limits.set(limits.goodId, limits);
        this.refreshBindGold();
        this.renderPage(this.page);
      },
      this,
    );
    card.addChild(button);
    return card;
  }

  //#endregion

  //#region 分类页签

  /** 当前分类的商品（没建分类 = 全空；快照没到同样空） */
  private goodsOf(categoryId: string): Goods[] {
    if (!categoryId) return [];
    return this.goods.filter((good) => mallGoodCategoryOf(good.id ?? "") === categoryId);
  }

  /** 某分类的总页数（空分类也按 1 页算，页脚显示「第 1 / 1 页」） */
  private pageCountOf(categoryId: string): number {
    return Math.max(1, Math.ceil(this.goodsOf(categoryId).length / this.pageSize()));
  }

  /**
   * 分类页签（横向一排；几何与配色见 mallDialogLayout.tabs）
   *
   * 分类个数不定（运营随时增删），所以页签宽度按个数压缩：先按配置宽度横排，总宽超过
   * `maxWidth` 就一起收窄，收到 `minWidth` 为止 —— 名字由 Label 的 SHRINK 兜（分类名最长 20 字）。
   * 页签 = ghost 底板按钮：选中金描边金字，未选中灰描边压暗（refreshTabs 重描，不重建节点）。
   */
  private buildTabs(dialog: Node) {
    const t = layout.tabs;
    const count = this.categories.length;
    const pitch = count > 0 ? Math.min(t.size.width + t.gap, (t.maxWidth + t.gap) / count) : t.size.width + t.gap;
    const width = Math.max(t.minWidth, Math.min(t.size.width, pitch - t.gap));
    const step = width + t.gap;
    this.tabNodes = this.categories.map((category, index) => {
      const position = new Vec2(t.position.x + (index - (count - 1) / 2) * step, t.position.y);
      const tab = GameUiHelper.createToneButton(`mall_tab_${category.id}`, category.label, position, new Size(width, t.size.height), t.fontSize, buttonTone.ghost);
      // 页签收窄后长分类名必须缩字，溢出会糊到隔壁页签上
      const tabLabel = tab.getChildByName(`${tab.name}_label`)?.getComponent(Label);
      if (tabLabel) tabLabel.overflow = Label.Overflow.SHRINK;
      tab.on(Node.EventType.TOUCH_END, () => this.switchCategory(category.id), this);
      dialog.addChild(tab);
      return tab;
    });
    this.refreshTabs();
  }

  /** 切到某分类：换当前页签高亮、重算页数并回到第一页 */
  private switchCategory(categoryId: string) {
    if (this.activeCategory === categoryId) return;
    this.activeCategory = categoryId;
    this.refreshTabs();
    this.pageCount = this.pageCountOf(categoryId);
    this.renderPage(0);
  }

  /** 页签高亮：当前分类金描边金字，其余灰描边压暗（不重建节点，切页签零 GC） */
  private refreshTabs() {
    const t = layout.tabs;
    this.tabNodes.forEach((tab, index) => {
      if (!isValid(tab)) return;
      const active = this.categories[index]?.id === this.activeCategory;
      // ghost 底板画在按钮节点自身（createPlateButton 的画法），重描换描边色即可
      GameUiHelper.restyleGlassPlate(tab, tab.getComponent(UITransform)!.contentSize, T.radius.r2, active ? T.gold[2] : T.line[2]);
      const label = tab.getChildByName(`${tab.name}_label`)?.getComponent(Label);
      if (label) label.color = active ? T.gold[4] : T.text[2];
      const opacity = tab.getComponent(UIOpacity) ?? tab.addComponent(UIOpacity);
      opacity.opacity = active ? 255 : t.inactiveOpacity;
    });
  }

  //#endregion

  //#region 分页与刷新

  /** 每页件数 = 列数 × 每页行数（见 mallDialogLayout.card.columns 与 .pagination.rowsPerPage） */
  private pageSize() {
    return layout.card.columns * layout.pagination.rowsPerPage;
  }

  /** 页脚翻页控件（挂在卡片区下；坐标以卡片区中心为原点，几何全在 configs）：ghost 键一排 + 页码居中 */
  private buildPagination(area: Node) {
    const p = layout.pagination;
    this.firstPageButton = this.createPageButton(area, p.firstButton, "label_mall_first_page", () => this.renderPage(0));
    this.prevPageButton = this.createPageButton(area, p.prevButton, "label_mall_prev_page", () => this.renderPage(this.page - 1));
    this.pageIndicator = UiHelper.createLabel(p.pageIndicator.name, "", p.pageIndicator.color, p.pageIndicator.fontSize, p.pageIndicator.position, p.pageIndicator.size);
    area.addChild(this.pageIndicator);
    this.nextPageButton = this.createPageButton(area, p.nextButton, "label_mall_next_page", () => this.renderPage(this.page + 1));
    this.lastPageButton = this.createPageButton(area, p.lastButton, "label_mall_last_page", () => this.renderPage(this.pageCount - 1));
  }

  /** 建一个翻页按钮（ghost 底板按钮 + 居中文字），返回节点供翻页后切换可用状态 */
  private createPageButton(area: Node, cfg: { name: string; position: Vec2 }, textKey: string, onClick: () => void) {
    const button = GameUiHelper.createToneButton(cfg.name, getText(textKey), cfg.position, layout.pagination.buttonSize, layout.pagination.pageIndicator.fontSize, buttonTone.ghost);
    button.on(Node.EventType.TOUCH_END, onClick, this);
    area.addChild(button);
    return button;
  }

  /**
   * 切到某一页（页码先夹进合法范围）：销毁上一页的卡片，再按当前页重建
   *
   * **整页重建是分页的意义所在**：任何时刻场景里只有一页的卡片节点（打开商城也只建第一页），
   * 不再像之前的滚动虚拟化那样先把几百张卡片全建出来；结束后刷新页码与按钮可用状态。
   */
  private renderPage(page: number) {
    const area = this.cardArea;
    if (!area || !isValid(area)) return;
    // 上一页的卡片要销毁 —— 悬停详情跟着收掉（否则图标没了，详情会永久留在屏幕上挡点击）
    this.closeDetail();
    this.page = Math.min(Math.max(page, 0), this.pageCount - 1);
    this.cards.forEach((card) => {
      if (!isValid(card)) return;
      // 先摘出父节点再销毁：destroy 到帧末才生效，留在原地会与新建的卡片重叠一帧
      card.removeFromParent();
      card.destroy();
    });
    this.cards = [];
    const columns = layout.card.columns;
    const pitch = layout.card.height + layout.card.gapY;
    // 卡片宽 = 卡片区宽均分（扣掉列间距）；y 按行从卡片区顶部往下排（卡片区锚点在中心）
    const cardWidth = (layout.list.size.width - (columns - 1) * layout.card.gapX) / columns;
    const start = this.page * this.pageSize();
    const roleLevel = StorageManager.findOnlineRole()?.level ?? 0;
    const pageGoods = this.goodsOf(this.activeCategory).slice(start, start + this.pageSize());
    if (this.emptyTip && isValid(this.emptyTip)) this.emptyTip.active = pageGoods.length === 0;
    pageGoods.forEach((good, index) => {
      const card = this.createCard(good, cardWidth, roleLevel);
      card.setPosition(
        (index % columns - (columns - 1) / 2) * (cardWidth + layout.card.gapX),
        layout.list.size.height / 2 - (Math.floor(index / columns) * pitch + layout.card.height / 2),
      );
      area.addChild(card);
      this.cards.push(card);
    });
    this.refreshPagination();
  }

  /** 刷新页码文字与首/末页按钮的可用状态（已在首页/末页时，对应方向的按钮点不动） */
  private refreshPagination() {
    if (this.pageIndicator && isValid(this.pageIndicator)) {
      this.pageIndicator.getComponent(Label)!.string = getText("mall_page_indicator", { page: this.page + 1, total: this.pageCount });
    }
    const atFirstPage = this.page <= 0;
    const atLastPage = this.page >= this.pageCount - 1;
    this.setPageButtonEnabled(this.firstPageButton, !atFirstPage);
    this.setPageButtonEnabled(this.prevPageButton, !atFirstPage);
    this.setPageButtonEnabled(this.nextPageButton, !atLastPage);
    this.setPageButtonEnabled(this.lastPageButton, !atLastPage);
  }

  /** 翻页按钮可用状态：不可用时连点击一起挡掉（Button.interactable），并整体减淡提示 */
  private setPageButtonEnabled(button: Node | null, enabled: boolean) {
    if (!button || !isValid(button)) return;
    const buttonComp = button.getComponent(Button);
    if (buttonComp) buttonComp.interactable = enabled;
    const opacity = button.getComponent(UIOpacity) ?? button.addComponent(UIOpacity);
    opacity.opacity = enabled ? 255 : 110;
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
  private openDetail(good: Goods, anchor: Node) {
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
