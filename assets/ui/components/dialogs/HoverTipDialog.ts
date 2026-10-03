import { isValid, Label, Node, UITransform } from "cc";
import { hoverTipLayout } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import { getVisibleSize } from "../../utils/layout/ScreenLayout";

/**
 * 悬停详情数据（状态与技能共用，由 HoverTipManager 组装）
 */
export interface HoverTipData {
  /** 标题（状态/技能名称） */
  title: string;
  /** 标题旁的图标（状态/技能图标，可选） */
  icon?: string;
  /** 信息行（每行一条「名称：值」静态文案） */
  rows: string[];
  /** 动态行初始文案（剩余时间/冷却剩余，每帧由 HoverTipManager 刷新；不传则没有动态行） */
  dynamicRow?: string;
  /** 描述（自动换行，可缺省） */
  description?: string;
}

/**
 * 悬停详情弹窗（自身即弹窗节点，随鼠标悬停动态创建/销毁，见 ui/core/HoverTipManager）
 * 展示：标题（可带图标）+ 信息行 + 动态行（每帧刷新）+ 描述
 * 容器为纵向 Layout 自适应高度（首帧用估算高度摆放，下一帧内容撑开后视觉差在一行以内）
 * 位置摆放在锚点图标旁（优先上方、放不下摆下方、水平夹在屏幕内），见 configs/hudLayout 的 hoverTipLayout
 * 标记了点击穿透：悬停期间不遮挡世界点击
 */
export default class HoverTipDialog extends Node {
  /** 动态行标签（data.dynamicRow 存在时才有） */
  private dynamicLabel: Label | null = null;
  /** 内容高度估算值（Layout 自适应要到下一帧，摆放位置先用它） */
  private readonly estimatedHeight: number;

  constructor(data: HoverTipData) {
    super(hoverTipLayout.name);
    GameUiHelper.applyHoverTipBodyStyle(this);
    let contentHeight = hoverTipLayout.padding * 2 + hoverTipLayout.title.iconSize.height;
    this.addChild(GameUiHelper.createHoverTipTitle(data.title, data.icon));
    const rows = [...data.rows, ...(data.dynamicRow !== undefined ? [data.dynamicRow] : [])];
    rows.forEach((row) => {
      const label = GameUiHelper.createHoverTipRow(row);
      if (row === data.dynamicRow) this.dynamicLabel = label.getComponent(Label);
      this.addChild(label);
      contentHeight += hoverTipLayout.row.size.height + hoverTipLayout.rowSpacing;
    });
    if (data.description) {
      this.addChild(GameUiHelper.createHoverTipDescription(data.description));
      contentHeight += this.estimateDescriptionHeight(data.description) + hoverTipLayout.rowSpacing;
    }
    this.estimatedHeight = contentHeight;
  }

  /** 刷新动态行文案（剩余时间/冷却剩余） */
  updateDynamicText(text: string) {
    if (this.dynamicLabel) this.dynamicLabel.string = text;
  }

  /** 弹窗是否仍有效（Node 子类无 node 属性，供管理器校验） */
  isValidNode(): boolean {
    return isValid(this);
  }

  /** 把弹窗摆在锚点图标旁：优先图标上方，放不下摆下方，都放不下贴屏幕上沿；水平方向夹在屏幕内 */
  placeByAnchor(anchor: Node) {
    // UI 层与相机对齐且无缩放（见 MapPreviewDialog）：锚点世界坐标减 UI 层世界坐标即屏幕中心系坐标
    const layerPosition = LayerManager.UILayer.getWorldPosition();
    const anchorWorld = anchor.getWorldPosition();
    const centerX = anchorWorld.x - layerPosition.x;
    const centerY = anchorWorld.y - layerPosition.y;
    const anchorHalfHeight = (anchor.getComponent(UITransform)?.contentSize.height ?? 0) / 2;
    const width = hoverTipLayout.size.width;
    const { anchorGap, screenMargin } = hoverTipLayout;
    const visibleSize = getVisibleSize();
    const halfWidth = visibleSize.width / 2;
    const halfHeight = visibleSize.height / 2;
    // 图标上方/下方的空闲高度（屏幕中心系：上为正）
    const topFree = halfHeight - (centerY + anchorHalfHeight) - anchorGap;
    const bottomFree = centerY - anchorHalfHeight - anchorGap;
    let anchorY: number;
    let y: number;
    if (topFree >= this.estimatedHeight) {
      anchorY = 0;
      y = centerY + anchorHalfHeight + anchorGap;
    } else if (bottomFree >= this.estimatedHeight) {
      anchorY = 1;
      y = centerY - anchorHalfHeight - anchorGap;
    } else {
      anchorY = 1;
      y = halfHeight - screenMargin;
    }
    const x = Math.min(Math.max(centerX, -halfWidth + screenMargin + width / 2), halfWidth - screenMargin - width / 2);
    this.getComponent(UITransform)!.setAnchorPoint(0.5, anchorY);
    this.setPosition(x, y, 0);
  }

  /** 描述高度估算（Layout 自适应前的摆放依据）：按 12px 字宽 ÷ 行宽估算行数，最多 4 行 */
  private estimateDescriptionHeight(text: string) {
    const { fontSize, lineHeight, size } = hoverTipLayout.description;
    const charsPerLine = Math.max(1, Math.floor(size.width / fontSize));
    const lines = Math.min(4, Math.max(1, Math.ceil(text.length / charsPerLine)));
    return lines * lineHeight;
  }
}
