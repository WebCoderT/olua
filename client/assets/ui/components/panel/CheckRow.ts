import { Color, Label, Node, Size, Sprite, UITransform, Vec2 } from "cc";
import UiHelper from "../../helpers/UiHelper";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { uiImages } from "../../../configs/layout/images";

/**
 * 勾选行（#1278）：两态勾选框图 + 文字，整行可点
 *
 * 三个自动弹窗（自动回收 / 自动使用）与角色信息弹窗的「自动穿戴」开关共用同一行样式，
 * 勾选框复用登录页的两态 PNG（`ui/login/icon-checkbox[-checked].png`，uiImages 已登记）。
 * 点击整行切换（不是只点小框）：清单行 24px 高，逐像素瞄准 16px 的框太苛刻。
 */
export default class CheckRow extends Node {
  /** 勾选框 sprite（两态换图用） */
  private checkboxSprite: Sprite | null = null;
  /** 当前勾选态 */
  private checked: boolean;

  /**
   * @param name 节点名
   * @param text 行文字（物品名 / 开关说明）
   * @param checked 初始勾选态
   * @param layout 行几何与字号配色（宽 = 整行可点范围，高 = 行高）
   * @param onToggle 勾选态变化回调（切换后调用；初始态不触发）
   */
  constructor(
    name: string,
    text: string,
    checked: boolean,
    layout: { width: number; height: number; fontSize: number; color: Color },
    onToggle: (checked: boolean) => void,
  ) {
    super(name);
    this.checked = checked;
    this.addComponent(UITransform).setContentSize(layout.width, layout.height);
    // 勾选框（两态图，居左；src 传空串让 createSprite 只建组件，图由 swapCheckboxIcon 统一加载）
    // 引擎坑（#1283）：createNode 底下锚点是默认 (0.5, 0.5)，而下面的 x 全是「行左缘」坐标 ——
    // 锚点不归零的话节点中心被摆在左缘上，文字块整体左移自身宽度的一半（用户实测弹窗文字偏左一半）。
    // 统一改成左缘语义：anchorPoint.x = 0，位置即左缘。
    const box = UiHelper.createSprite(`${name}_checkbox`, "", new Vec2(-layout.width / 2 + 4, 0), new Size(16, 16));
    box.getComponent(UITransform)?.setAnchorPoint(0, 0.5);
    this.checkboxSprite = box.getComponent(Sprite) ?? null;
    this.addChild(box);
    this.swapCheckboxIcon();
    // 行文字（框右侧留 24：框 16 + 间距 8）
    const rowLabel = UiHelper.createLabel(`${name}_label`, text, layout.color, layout.fontSize, new Vec2(-layout.width / 2 + 24, 0), new Size(layout.width - 24, layout.height), Label.HorizontalAlign.LEFT);
    rowLabel.getComponent(UITransform)?.setAnchorPoint(0, 0.5);
    this.addChild(rowLabel);
    // 整行可点：点击音 + 鼠标通道拦截（防穿透，与登录页勾选框同一套口径）+ 触摸切换
    SoundManager.bindClick(this);
    blockClickThrough(this);
    this.on(Node.EventType.TOUCH_END, () => {
      this.setChecked(!this.checked);
      onToggle(this.checked);
    }, this);
  }

  /** 当前勾选态 */
  isChecked(): boolean {
    return this.checked;
  }

  /** 设置勾选态（换两态图；不触发 onToggle —— 回填初始态用） */
  setChecked(checked: boolean): void {
    this.checked = checked;
    this.swapCheckboxIcon();
  }

  /** 按当前勾选态换勾选框图（登录页 swapIcon 同款：加载失败保持原图不闪白） */
  private swapCheckboxIcon(): void {
    if (!this.checkboxSprite) return;
    const src = this.checked ? uiImages.loginCheckboxCheckedIcon : uiImages.loginCheckboxIcon;
    UiHelper.loadSprite(src, (frame) => {
      if (this.checkboxSprite && this.checkboxSprite.isValid) this.checkboxSprite.spriteFrame = frame;
    });
  }
}

/** 网格排布参数（#1304：自动使用 / 自动回收的清单从单列改成一行三列） */
export interface CheckGridSpec {
  /** 内容区宽度（已扣掉滚动区的左右内边距） */
  width: number;
  /** 每行几列 */
  columns: number;
  /** 列间距 */
  columnGap: number;
  /** 行高（= 单格高度） */
  rowHeight: number;
  /** 文字字号与配色（与原来的单列行一致） */
  fontSize: number;
  color: Color;
}

/** 网格里的一个勾选项 */
export interface CheckGridItem {
  /** 勾选行节点名的后半段（自动回收在这里编码「部位_段下界」，见 AutoRecycleDialog.ROW_PREFIX） */
  key: string;
  /** 行文字（物品名 / 等级段） */
  text: string;
  checked: boolean;
}

/** 一次网格排布的参数 */
export interface CheckGridOptions {
  /** 勾选行节点名前缀（前缀 + key 必须全局唯一） */
  namePrefix: string;
  /** 行容器节点名前缀（同一内容区里多次调用必须不同，否则行容器重名） */
  rowPrefix: string;
  items: CheckGridItem[];
  spec: CheckGridSpec;
  /** 勾选态变化回调（key = 上面那个 key） */
  onToggle: (key: string, checked: boolean) => void;
}

/**
 * 把一批勾选项按 `columns` 列铺进滚动内容（#1304）
 *
 * 为什么先装「行容器」而不是直接给 `CheckRow` 设 x：滚动内容是纵向 Layout
 * （`ResizeMode.CONTAINER`），它按**直接子节点**算总高 —— 把 3 个勾选行直接平铺进去，
 * Layout 会把它们当 3 行竖着排，横向位置也一并被覆盖。所以每 `columns` 个勾选项装进一个
 * 固定高度的行容器，行容器里再横向摆列；行容器本身仍是 content 的直接子节点，纵向节奏不变。
 *
 * @returns 建出来的行容器（测试与排版核对用；正常渲染不需要）
 */
export function appendCheckGrid(content: Node, options: CheckGridOptions): Node[] {
  const { spec, items, namePrefix, rowPrefix, onToggle } = options;
  const columns = Math.max(1, Math.floor(spec.columns));
  const columnGap = Math.max(0, spec.columnGap);
  // 等分：最后留的余数（width 除不尽时）不再补到最后一列，避免右边多出一条不规则空隙
  const cellWidth = Math.max(1, Math.floor((spec.width - columnGap * (columns - 1)) / columns));
  const left = -spec.width / 2 + cellWidth / 2;
  const containers: Node[] = [];
  let container: Node | null = null;
  items.forEach((item, index) => {
    const column = index % columns;
    if (column === 0) {
      container = UiHelper.createNode(
        `${rowPrefix}_row_${Math.floor(index / columns)}`,
        new Vec2(0, 0),
        new Size(spec.width, spec.rowHeight),
      );
      content.addChild(container);
      containers.push(container);
    }
    const row = new CheckRow(
      `${namePrefix}${item.key}`,
      item.text,
      item.checked,
      { width: cellWidth, height: spec.rowHeight, fontSize: spec.fontSize, color: spec.color },
      (checked) => onToggle(item.key, checked),
    );
    // 行容器锚点是默认 0.5（左缘 = -width/2），勾选行自己也是 0.5 锚点 → 直接按中心摆
    row.setPosition(left + column * (cellWidth + columnGap), 0, 0);
    container!.addChild(row);
  });
  return containers;
}
