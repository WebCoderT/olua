import { Color, Graphics, isValid, Label, Node, ScrollView, Size, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import SoundManager from "../../core/SoundManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import { fashionDialogLayout } from "../../../configs/hudLayout";
import { FashionDataEntry } from "../../../configs/game-config";
import { clearChildren } from "../../utils/node/NodeTree";
import { blockClickThrough } from "../../utils/input/UiHit";

/** 弹窗布局（几何、配色与文案统一见 configs/hudLayout.fashionDialogLayout） */
const layout = fashionDialogLayout;

/**
 * 时装弹窗（#377 陈列与穿脱；#596 拥有清单与购买）
 *
 * 与「换装备」最大的区别：**只换外观，不换数值** —— 属性、血量、战斗力都由装备决定，
 * 穿脱时装不重算任何数值。
 *
 * 本类只做陈列与交互：
 * - 列表：全部时装（configs/fashionClothes 的 20 套）四列网格，卡片 = 外观图标 + 名称 + 状态；
 * - 拥有的时装：点卡片穿上/脱下（点已穿戴的那张 = 脱下）；
 * - 未拥有的时装按获取渠道分流（acquireChannel，#596）：
 *   upgrade 且有售价 → 显示价格，点击购买（扣费与清单在服务端）；其余 → 置灰「未开放」；
 * - 顶部一行显示当前穿戴；外观会在关弹窗前就生效（地图上的主角与内观同步刷新）。
 */
export default class FashionDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 图标列表内容节点（卡片全部挂在这里） */
  private listContent: Node | null = null;
  /** 顶部「当前穿戴」标签 */
  private currentLabel: Node | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    this.dialog = GameUiHelper.createDialog(layout.name, layout.title);
    // 顶部：当前穿戴
    this.currentLabel = UiHelper.createLabel(
      "fashion_current",
      "",
      Color.WHITE,
      layout.current.fontSize,
      layout.current.position,
      new Size(540, 24),
    );
    this.dialog.addChild(this.currentLabel);
    // 列表：四列卡片，竖向滚动
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listContent = list.getComponent(ScrollView).content;
    this.dialog.addChild(list);
    // 弹窗整体吃掉点击：否则点在卡片之间的空隙会穿透到下层 UI（见 audit-ui-click-through）
    blockClickThrough(this.dialog);
    LayerManager.addDialogToUILayer(this.dialog);
    this.refresh();
  }

  /** 整体刷新（穿/脱/购买之后调用）：当前穿戴提示 + 卡片状态全部重算 */
  private refresh() {
    const role = StorageManager.findOnlineRole();
    if (!role || !this.listContent) return;
    const wardrobe = StorageManager.getFashionWardrobe();
    const worn = StorageManager.getWornFashion();
    if (this.currentLabel) {
      const label = this.currentLabel.getComponent(Label);
      if (label) {
        const text = worn ? layout.currentText.worn : layout.currentText.none;
        label.string = text.replace("{label}", worn?.label ?? "");
      }
    }
    // 卡片整批重建：20 张的成本可以接受，而且状态（已穿戴/未拥有）只在一处算
    // ⚠️ 不能把卡片直接挂到 content 上：content 带纵向 Layout（CONTAINER），会按列重排它们。
    // 所以先放一个自绘网格节点，卡片在网格里按行列摆，Layout 只负责把这个网格从上往下排。
    clearChildren(this.listContent);
    const columns = layout.card.columns;
    const rows = Math.ceil(wardrobe.length / columns);
    const grid = UiHelper.createNode(
      "fashion_grid",
      new Vec2(),
      new Size(columns * layout.card.size.width + (columns - 1) * layout.card.gap.x, rows * layout.card.size.height + (rows - 1) * layout.card.gap.y),
    );
    this.listContent.addChild(grid);
    wardrobe.forEach((fashion, index) => grid.addChild(this.createCard(fashion, index, rows, worn?.id ?? null)));
  }

  /**
   * 单张卡片：底色 + 图标 + 名称 + 状态
   * @param fashion 时装配置
   * @param index 在衣柜里的序号（决定网格行列）
   * @param rows 网格总行数（决定纵向居中）
   * @param wornId 当前穿戴的时装 id（用于高亮与状态文案）
   */
  private createCard(fashion: FashionDataEntry, index: number, rows: number, wornId: string | null) {
    const card = layout.card;
    const column = index % card.columns;
    const row = Math.floor(index / card.columns);
    // 网格中心为原点：列从左到右、行从上到下（y 向上为正，所以行号越大越负）
    const stepX = card.size.width + card.gap.x;
    const stepY = card.size.height + card.gap.y;
    const x = (column - (card.columns - 1) / 2) * stepX;
    const y = ((rows - 1) / 2 - row) * stepY;
    const node = UiHelper.createNode(`fashion_card_${fashion.id}`, new Vec2(x, y), card.size);
    // 状态优先级：已穿戴 > 已拥有 > 可购买 > 未开放（#596：清单归服务端，本地只读）
    const owned = StorageManager.ownsFashion(fashion.id);
    const equipped = fashion.id === wornId;
    const buyable = !owned && fashion.acquireChannel === "upgrade" && (fashion.sellPrice ?? 0) > 0;
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = owned || equipped ? card.fill : card.lockedFill;
    graphics.roundRect(-card.size.width / 2, -card.size.height / 2, card.size.width, card.size.height, 6);
    graphics.fill();
    graphics.lineWidth = equipped ? 2 : 1;
    graphics.strokeColor = equipped ? card.activeBorder : owned ? card.border : card.lockedBorder;
    graphics.roundRect(-card.size.width / 2, -card.size.height / 2, card.size.width, card.size.height, 6);
    graphics.stroke();
    // 外观图标（没有外观资源的时装也要能展示，用图标占位；未拥有的置灰）
    const icon = GameUiHelper.createImage(`fashion_icon_${fashion.id}`, fashion.icon, card.iconPosition, card.iconSize);
    if (!owned && !equipped) {
      const sprite = icon.getComponent(Sprite);
      if (sprite) sprite.color = card.lockedTint;
    }
    node.addChild(icon);
    const name = UiHelper.createLabel(`fashion_label_${fashion.id}`, fashion.label, Color.WHITE, card.labelFontSize, card.labelPosition, card.labelSize);
    if (!owned && !equipped) {
      const label = name.getComponent(Label);
      if (label) label.color = card.lockedTint;
    }
    node.addChild(name);
    // 状态角标：已穿戴 / 点击穿上 / 价格 / 未开放 / 无外观
    let state: string;
    if (equipped) state = layout.stateText.equipped;
    else if (owned) state = layout.stateText.wearable;
    else if (buyable) state = layout.stateText.buyable.replace("{price}", String(fashion.sellPrice ?? 0));
    else if (fashion.out || fashion.in) state = layout.stateText.locked;
    else state = layout.stateText.unsupported;
    const stateColor = equipped ? card.activeBorder : buyable ? card.buyColor : card.stateColor;
    node.addChild(
      UiHelper.createLabel(`fashion_state_${fashion.id}`, state, stateColor, card.stateFontSize, card.statePosition, new Size(122, 18)),
    );
    // 点卡片：已穿戴 → 脱下；已拥有 → 穿上；可购买 → 购买（成功后整批刷新）。
    // 失败提示由请求层统一出（余额不足等），这里只在成功后刷新。
    // 卡片自己要收点击，必须在鼠标通道登记（否则点在卡片上会穿透到下层 UI）
    blockClickThrough(node);
    // 点击音（#685）：时装卡是手写按钮（穿 / 脱 / 买都走这一张卡）
    SoundManager.bindClick(node);
    node.on(Node.EventType.TOUCH_END, () => {
      if (equipped) {
        void StorageManager.unwearFashion().then((ok) => ok && this.refresh());
      } else if (owned) {
        void StorageManager.wearFashion(fashion.id).then((ok) => ok && this.refresh());
      } else if (buyable) {
        void StorageManager.buyFashion(fashion.id).then((ok) => ok && this.refresh());
      }
    });
    return node;
  }

  /** 关闭弹窗 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  /** 释放引用 */
  private reset() {
    this.dialog = null;
    this.listContent = null;
    this.currentLabel = null;
  }
}
