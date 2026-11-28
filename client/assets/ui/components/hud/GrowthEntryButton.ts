import { _decorator, Color, Component, Graphics, UITransform } from "cc";
import { T } from "../../../configs/layout/tokens";

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 成长线入口按钮的外观零件（稿 04-hud `.subbtn`：胶囊底 + 金描边 + 矢量图标，#1381）
 *
 * 静态外观（描边 / 图标形状）由本组件画在自身 Graphics 上并**随 prefab 序列化**
 * （`executeInEditMode`：编辑器里也执行绘制，prefab 所见即运行时所得）；
 * 胶囊底色（Sprite 调色）与文字（Label）在 prefab 里，改版式直接改 prefab。
 *
 * 点击行为不在本组件 —— 运行时由 GrowthEntries 按入口 key 接回调（与 BottomNavButton
 * 的 handlers 同思路），这里只管「长什么样」。
 *
 * @property kind 图标形状："title" 称号（奖牌）/ "soul" 元神（灵焰）；其余值不画图标
 */
@ccclass("GrowthEntryButton")
@executeInEditMode
export default class GrowthEntryButton extends Component {
  /** 图标形状（title 奖牌 / soul 灵焰） */
  @property
  public kind: string = "title";
  /** 胶囊描边（稿 line-2） */
  @property
  public borderColor: Color = T.line[2].clone();
  /** 图标描边色（稿 gold-3） */
  @property
  public iconColor: Color = T.gold[3].clone();

  /** 上次画板时的尺寸（未变化不重画） */
  private lastWidth = 0;
  private lastHeight = 0;
  private graphics: Graphics | null = null;

  protected onLoad() {
    this.graphics = this.getComponent(Graphics) ?? this.addComponent(Graphics);
    this.repaint();
  }

  protected update() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.repaint();
  }

  /** 按当前内容尺寸重画描边与图标（尺寸变化后下一帧自动触发） */
  public repaint() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    const g = this.graphics;
    g.clear();
    // 胶囊描边（圆角矩形，半径 = 高度一半压到边内 0.5px）
    g.lineWidth = 1;
    g.strokeColor = this.borderColor;
    const r = height / 2 - 0.5;
    g.roundRect(-width / 2 + 0.5, -height / 2 + 0.5, width - 1, height - 1, r);
    g.stroke();
    // 矢量图标：左置，中心 x = -width/2 + 13 + 3（与文字留 6px 间距）
    if (this.kind === "title") this.drawMedal(g, -width / 2 + 16, 0);
    else if (this.kind === "soul") this.drawFlame(g, -width / 2 + 16, 0);
  }

  /** 称号图标：奖牌（圆牌 + 下垂绶带两笔），13×13 视框 */
  private drawMedal(g: Graphics, cx: number, cy: number) {
    g.lineWidth = 1.4;
    g.strokeColor = this.iconColor;
    // 牌：圆心略上
    g.circle(cx, cy + 1.6, 3.9);
    g.stroke();
    // 绶带：左右两笔向内收（V 字底）
    g.moveTo(cx - 3.4, cy - 1.6);
    g.lineTo(cx - 1.8, cy - 6);
    g.lineTo(cx, cy - 3.2);
    g.lineTo(cx + 1.8, cy - 6);
    g.lineTo(cx + 3.4, cy - 1.6);
    g.stroke();
  }

  /** 元神图标：灵焰（外焰水滴 + 内焰小滴），13×13 视框 */
  private drawFlame(g: Graphics, cx: number, cy: number) {
    g.lineWidth = 1.4;
    g.strokeColor = this.iconColor;
    // 外焰：顶尖下圆的水滴轮廓
    g.moveTo(cx, cy + 6);
    g.bezierCurveTo(cx + 4.6, cy + 1.4, cx + 4.4, cy - 1.6, cx + 3.4, cy - 3.2);
    g.bezierCurveTo(cx + 2.4, cy - 4.8, cx + 0.8, cy - 5.4, cx, cy - 6.2);
    g.bezierCurveTo(cx - 0.8, cy - 5.4, cx - 2.4, cy - 4.8, cx - 3.4, cy - 3.2);
    g.bezierCurveTo(cx - 4.4, cy - 1.6, cx - 4.6, cy + 1.4, cx, cy + 6);
    g.stroke();
    // 内焰：小水滴
    g.circle(cx, cy + 0.4, 1.7);
    g.stroke();
  }
}
