import { _decorator, Color, Component, Graphics, UITransform } from "cc";
import { T } from "../../../configs/layout/tokens";

const { ccclass, property, executeInEditMode } = _decorator;

/** 底衬中心色：rgb 与 token veil（.72）同源，浓度按稿给足 rgba(10,7,4,.82) */
const backdropColor = (): Color => {
  const color = T.surface.veil.clone();
  color.a = 209;
  return color;
};

/**
 * HUD 底部暗角底衬组件（稿 `.bottom::before` 的底部暗角，#1363 起进 prefab）
 *
 * 稿是 `radial-gradient(58% 100% at 50% 100%, rgba(10,7,4,.82), transparent 74%)`：
 * **椭圆**径向渐变，圆心在本节点底边正中、底边最暗，向上与左右同时淡出。
 *
 * Graphics 没有渐变填充 → 用「同心半透明椭圆逐层叠」近似：每层 alpha 很小，
 * 越靠中心叠得越多，中心自然累积到目标浓度（比竖条渐变多一个左右方向的收边，
 * 底栏两侧不再是一条硬边）。
 *
 * #1363：全部外观参数改为 **@property**，prefab 可以序列化本组件，
 * `executeInEditMode` 让编辑器里也执行绘制（prefab 所见即运行时所得）。
 * 绘制尺寸取自身 UITransform 的 contentSize，编辑器里改节点尺寸即改渐变范围。
 */
@ccclass("HudBackdrop")
@executeInEditMode
export default class HudBackdrop extends Component {
  /** 同心椭圆层数（同色叠加出渐变；越多越平滑，DrawCall 不变） */
  @property
  public steps: number = 24;
  /** 稿中心浓度 rgba(10,7,4,.82)（token 的 veil 是 .72，底衬按稿给足） */
  @property
  public color: Color = backdropColor();

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

  /** 按当前内容尺寸重画底衬（尺寸变化后下一帧自动触发） */
  public repaint() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    const g = this.graphics;
    const steps = Math.max(1, Math.round(this.steps));
    // 每层 alpha：n 层叠加后中心 ≈ 目标浓度（target = color.a / 255）
    const target = Math.min(0.98, this.color.a / 255);
    const layerAlpha = Math.round(255 * (1 - Math.pow(1 - target, 1 / steps)));
    g.clear();
    for (let i = steps; i >= 1; i--) {
      const k = i / steps;
      const layer = this.color.clone();
      layer.a = layerAlpha;
      g.fillColor = layer;
      // 椭圆中心压在本节点底边（= 屏幕底）：横向半径取稿的 58% 宽、纵向半径 = 全高
      // （稿 `radial-gradient(58% 100% at 50% 100%)` 的两个百分比就是横/纵半径，不是直径）
      g.ellipse(0, -height / 2, width * 0.58 * k, height * k);
      g.fill();
    }
  }
}
