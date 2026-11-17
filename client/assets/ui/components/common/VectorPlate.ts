import { _decorator, Color, Component, Graphics, Size, UITransform } from "cc";
import { dialogFrame } from "../../../configs/layout/dialogs";

const { ccclass } = _decorator;

/**
 * 矢量底板组件（弹窗背景不再用九宫格贴图后的替代品）
 *
 * 挂在「自身即弹窗背景」的节点上：按 UITransform 当前尺寸重画深色圆角底板 +
 * 细描边（与 GameUiHelper.createDialogPanel 同一套视觉语言，配色取 layout.dialogFrame.panel）。
 * 每帧比对尺寸，只有变化才 clear + 重画 —— 内容驱动的自适应弹窗（悬停详情 / 物品详情）
 * 被 Layout 撑高后底板跟着长大，静态弹窗则一帧只画一次、之后零开销。
 */
@ccclass("VectorPlate")
export default class VectorPlate extends Component {
  /** 描边色（缺省取弹窗面板描边） */
  public borderColor: Color = dialogFrame.panel.border;
  /** 上次画板时的尺寸（未变化不重画） */
  private lastSize: Size = new Size(0, 0);
  private graphics: Graphics | null = null;

  protected onLoad() {
    this.graphics = this.getComponent(Graphics) ?? this.addComponent(Graphics);
    this.repaint();
  }

  protected update() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const size = transform.contentSize;
    if (size.width === this.lastSize.width && size.height === this.lastSize.height) return;
    this.repaint();
  }

  /** 按当前内容尺寸重画底板（内容变化后下一帧自动触发，也可手动调用立即刷新） */
  public repaint() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastSize = new Size(width, height);
    const style = dialogFrame.panel;
    const g = this.graphics;
    g.clear();
    // 底板：主体色整块 + 顶部一条亮带（与 createDialogPanel 同构，模拟 165deg 渐变的亮端）
    g.fillColor = style.fill;
    g.roundRect(-width / 2, -height / 2, width, height, style.radius);
    g.fill();
    const bandHeight = height * style.fillTopRatio;
    g.fillColor = style.fillTop;
    g.roundRect(-width / 2, height / 2 - bandHeight, width, bandHeight, style.radius);
    g.fill();
    g.lineWidth = style.borderWidth;
    g.strokeColor = this.borderColor;
    g.roundRect(-width / 2, -height / 2, width, height, style.radius);
    g.stroke();
  }
}
