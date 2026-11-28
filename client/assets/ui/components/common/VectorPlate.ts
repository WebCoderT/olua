import { _decorator, Color, Component, Graphics, Size, UITransform } from "cc";
import { dialogFrame } from "../../../configs/layout/dialogs";
import UiHelper from "../../helpers/UiHelper";

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 矢量底板组件（弹窗背景不再用九宫格贴图后的替代品）
 *
 * 挂在「自身即弹窗背景」的节点上：按 UITransform 当前尺寸重画深色圆角底板 +
 * 细描边 + 顶部亮带 + 内侧高光 + 四角铆钉（与 GameUiHelper.createDialogPanel 同一套视觉语言）。
 * 每帧比对尺寸，只有变化才 clear + 重画 —— 内容驱动的自适应弹窗（悬停详情 / 物品详情）
 * 被 Layout 撑高后底板跟着长大，静态弹窗则一帧只画一次、之后零开销。
 *
 * #1361 HUD prefab 化：全部外观参数改为 **@property** —— prefab 可以序列化本组件，
 * 面板配色（底色/渐变/描边/圆角/铆钉）在 Cocos 编辑器检查器里直接改；
 * `executeInEditMode` 让编辑器里也执行绘制，prefab 所见即运行时所得。
 * 缺省值取 dialogFrame.panel（通用弹窗面板），运行时 addComponent 的旧用法零行为变化。
 */
@ccclass("VectorPlate")
@executeInEditMode
export default class VectorPlate extends Component {
  /** 底板主色 */
  @property
  public fillColor: Color = dialogFrame.panel.fill.clone();
  /** 渐变亮端（顶） */
  @property
  public fillTopColor: Color = dialogFrame.panel.fillTop.clone();
  /** 过渡带占面板高度的比例（自顶向下） */
  @property
  public fillTopRatio: number = dialogFrame.panel.fillTopRatio;
  /** 渐变收尾色（最底端） */
  @property
  public gradientBottomColor: Color = dialogFrame.panel.gradientBottom.clone();
  /** 外框描边色 */
  @property
  public borderColor: Color = dialogFrame.panel.border.clone();
  /** 外框线宽（1px 描边实机不渲染，先用边线色铺整块再内缩填底色） */
  @property
  public borderWidth: number = dialogFrame.panel.borderWidth;
  /** 渐变条数（Graphics 无渐变 API，等高色带插值） */
  @property
  public gradientSteps: number = dialogFrame.panel.gradientSteps;
  /** 内侧一圈极弱高光（撑「金属压边」厚度感） */
  @property
  public innerHighlightColor: Color = dialogFrame.panel.innerHighlight.clone();
  /** 圆角 */
  @property
  public radius: number = dialogFrame.panel.radius;
  /** 是否画四角铆钉（常驻 HUD 小窗可关掉，弹窗面板默认开） */
  @property
  public showRivet: boolean = true;
  /** 铆钉直径 */
  @property
  public rivetSize: number = dialogFrame.panel.rivet.size;
  /** 铆钉色 */
  @property
  public rivetColor: Color = dialogFrame.panel.rivet.color.clone();
  /** 铆钉距面板边缘的内缩 */
  @property
  public rivetInset: number = dialogFrame.panel.rivet.inset;
  /** 铆钉旁小拖尾点的直径 */
  @property
  public rivetTrailSize: number = dialogFrame.panel.rivet.trailSize;
  /** 铆钉旁小拖尾点的偏移 */
  @property
  public rivetTrailOffset: number = dialogFrame.panel.rivet.trailOffset;

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
    const g = this.graphics;
    const bw = Math.max(1, this.borderWidth);
    const radius = this.radius;
    const left = -width / 2;
    const bottom = -height / 2;
    g.clear();
    // 底板（与 createDialogPanel 同构）：
    // 边线色先与面板底色合成为不透明色（1px stroke 实机不渲染；半透明边线会与世界地图混成灰线），
    // 再铺整块、内缩填底色，最后叠竖向渐变（稿 165deg：surface-3 → surface-2 → 深底）
    const ringColor = UiHelper.blendOver(this.borderColor, this.fillColor);
    g.fillColor = ringColor;
    g.roundRect(left, bottom, width, height, radius);
    g.fill();
    g.fillColor = this.fillColor;
    g.roundRect(left + bw, bottom + bw, width - bw * 2, height - bw * 2, Math.max(0, radius - bw));
    g.fill();
    UiHelper.paintVerticalGradient(
      g,
      new Size(width, height),
      [
        { t: 0, color: this.fillTopColor },
        { t: this.fillTopRatio, color: this.fillColor },
        { t: 1, color: this.gradientBottomColor },
      ],
      bw,
      radius,
      Math.max(2, Math.round(this.gradientSteps)),
    );
    // 内侧一圈极弱高光：贴顶边往下 2px，撑出「金属压边」的厚度感（同样用 1px 填充条）
    g.fillColor = this.innerHighlightColor;
    g.rect(left + bw + 1, bottom + height - bw - 2, width - (bw + 1) * 2, 1);
    g.fill();
    // 四角铆钉（ui.css .panel--rivet）：**右上角不画**（用户拍板 2026-11-18：带关闭键的弹窗
    // 右上角是铆钉主圆 + 拖尾小点「两个圈圈」挤在 × 旁边，很难看）；其余三角各一颗、各带小拖尾点
    if (!this.showRivet) return;
    const r = this.rivetSize / 2;
    const inset = this.rivetInset;
    const rivetPoints: Array<[number, number, number]> = [
      [left + inset, bottom + height - inset, 1],
      [left + inset, bottom + inset, 1],
      [left + width - inset, bottom + inset, -1],
    ];
    for (const [x, y, dir] of rivetPoints) {
      g.fillColor = this.rivetColor;
      g.circle(x, y, r);
      g.fill();
      g.circle(x + dir * this.rivetTrailOffset, y, this.rivetTrailSize / 2);
      g.fill();
    }
  }
}
