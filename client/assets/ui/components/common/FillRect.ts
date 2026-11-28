import { _decorator, Color, Component, Graphics, UITransform } from "cc";
import { T } from "../../../configs/layout/tokens";

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 满色矩形填充组件（#1386 弹窗骨架 prefab 化：Graphics 绘制指令不序列化的组件化载体）
 *
 * 承载「固定尺寸、纯色填充」的小零件：弹窗标题下的短金线（`.panel-title::after` 44×1）、
 * 弹窗页脚的通栏分隔线。按自身 UITransform 的 contentSize 画满色矩形，
 * 尺寸变化自动重画 —— 布局由 prefab 决定，这里只负责把色块画出来。
 *
 * #1386：外观参数改为 **@property**，prefab 可以序列化本组件，
 * `executeInEditMode` 让编辑器里也执行绘制（prefab 所见即运行时所得）。
 */
@ccclass("FillRect")
@executeInEditMode
export default class FillRect extends Component {
  /** 填充色 */
  @property
  public fillColor: Color = T.gold[3].clone();

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

  /** 按当前内容尺寸重画矩形（尺寸变化后下一帧自动触发，也可手动调用立即刷新） */
  public repaint() {
    const transform = this.getComponent(UITransform);
    if (!transform || !this.graphics) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    const g = this.graphics;
    g.clear();
    g.fillColor = this.fillColor;
    g.rect(-width / 2, -height / 2, width, height);
    g.fill();
  }
}
