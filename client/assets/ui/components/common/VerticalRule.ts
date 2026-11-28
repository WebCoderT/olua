import { _decorator, Color, Component, Graphics, UITransform } from "cc";
import { T } from "../../../configs/layout/tokens";

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 竖分隔线组件（稿 `.vsep`：1px 宽、上下透明、中间 line-3，#1363 起进 prefab）
 *
 * 稿是 `linear-gradient(180deg, transparent, line-3 18% 82%, transparent)`：
 * 按高度切竖条，两端 alpha 收到 0，中段满色。
 *
 * #1363：外观参数改为 **@property**，prefab 可以序列化本组件，
 * `executeInEditMode` 让编辑器里也执行绘制（prefab 所见即运行时所得）。
 * 绘制尺寸取自身 UITransform 的 contentSize。
 */
@ccclass("VerticalRule")
@executeInEditMode
export default class VerticalRule extends Component {
  /** 中段满色（稿 line-3） */
  @property
  public color: Color = T.line[3].clone();
  /** 两端淡出带宽度（占高度比例；0.32 = 距上下端各 32% 内从 0 线性升到满色） */
  @property
  public fadeRange: number = 0.32;

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

  /** 按当前内容尺寸重画分隔线（尺寸变化后下一帧自动触发） */
  public repaint() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    const g = this.graphics;
    const steps = 9;
    const stepHeight = height / steps;
    const fade = Math.max(0.01, this.fadeRange);
    g.clear();
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      // 距上下端 fadeRange 内线性淡出，中段满色
      const alpha = Math.min(1, Math.min(t, 1 - t) / fade);
      const tint = this.color.clone();
      tint.a = Math.round(this.color.a * alpha);
      if (tint.a <= 0) continue;
      g.fillColor = tint;
      g.rect(-width / 2, -height / 2 + i * stepHeight, width, stepHeight + 0.5);
      g.fill();
    }
  }
}
