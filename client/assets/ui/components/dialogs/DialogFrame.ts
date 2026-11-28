import { _decorator, Component, Label, Node, Prefab, Size, UITransform } from "cc";
import { dialogFrame } from "../../../configs/layout/dialogs";
import { Draggable } from "../input/Draggable";
import { bindDialogRaiseOnPress } from "../../utils/input/DialogBehavior";
import { blockClickThrough } from "../../utils/input/UiHit";

const { ccclass, property, executeInEditMode } = _decorator;

/**
 * 通用弹窗骨架组件（#1386 弹窗 prefab 化第一期）
 *
 * 骨架本体是 `ui/prefabs/dialogs/DialogFrame.prefab`（改版式在 Cocos 编辑器里改）：
 * 底板（VectorPlate，四角铆钉 + 金线 + 渐变）→ 标题栏拖拽柄 → 左上眉题 → 居中标题 +
 * 44×1 短金线 → 右上关闭键。由 Game 场景的 `Game.dialogFramePrefab` 静态注入
 * （NpcDialog 同款，不走 resources.load），`GameUiHelper.createDialog` 实例化后只写
 * 文案与尺寸 —— **代码对骨架零样式覆写**，摆位全部由本组件的几何 @property 承载
 * （prefab 为准，编辑器里改 @property 即全弹窗生效）。
 *
 * 与原 `GameUiHelper.createDialog` 的行为差：无 —— blockClickThrough / 置顶提层 /
 * 标题栏拖拽 / 关闭键销毁全部保留，只是从工厂代码搬进组件 onLoad（prefab 实例化即完整弹窗）。
 * 眉题文案为空时整块隐藏（原口径：不传则不画）。
 */
@ccclass("DialogFrame")
@executeInEditMode
export default class DialogFrame extends Component {
  /** 由 Game 场景在 start 时把 prefab 注入进来（NpcDialog 同款静态引用） */
  private static prefab: Prefab | null = null;
  public static setPrefab(prefab: Prefab | null): void {
    DialogFrame.prefab = prefab;
  }
  public static getPrefab(): Prefab | null {
    return DialogFrame.prefab;
  }

  /** 标题栏拖拽柄（通栏透明条带，挂 Draggable；只有标题栏可拖动弹窗 —— #1090） */
  @property({ type: Node })
  public headDrag: Node | null = null;
  /** 左上角眉题（`BAG · B` 这类，含快捷键；文案为空整块隐藏） */
  @property({ type: Label })
  public eyebrowLabel: Label | null = null;
  /** 右上角关闭键（点击销毁弹窗） */
  @property({ type: Node })
  public closeButtonNode: Node | null = null;
  /** 居中标题 */
  @property({ type: Label })
  public titleLabel: Label | null = null;
  /** 标题下的短金线（FillRect） */
  @property({ type: Node })
  public titleRule: Node | null = null;

  //#region 头部三段几何（prefab 为准；缺省值 = configs/dialogFrame，改造期旧读数零行为变化）

  /** 眉题左缘距弹窗左边 */
  @property
  public eyebrowLeft: number = dialogFrame.eyebrow.left;
  /** 眉题中心距弹窗顶边 */
  @property
  public eyebrowTop: number = dialogFrame.eyebrow.top;
  /** 眉题文本框宽（对齐框，LEFT） */
  @property
  public eyebrowWidth: number = dialogFrame.eyebrow.width;
  /** 眉题文本框高 */
  @property
  public eyebrowHeight: number = dialogFrame.eyebrow.height;
  /** 标题中心距弹窗顶边 */
  @property
  public titleInsetTop: number = dialogFrame.title.insetTop;
  /** 标题文本框高 */
  @property
  public titleHeight: number = dialogFrame.title.height;
  /** 标题文本框左右各内缩（宽 = 弹窗宽 − 2×该值） */
  @property
  public titleWidthPadding: number = dialogFrame.title.widthPadding;
  /** 短金线宽 */
  @property
  public ruleWidth: number = dialogFrame.title.rule.width;
  /** 短金线高 */
  @property
  public ruleHeight: number = dialogFrame.title.rule.height;
  /** 标题下沿到金线中心的距离 */
  @property
  public ruleGap: number = dialogFrame.title.rule.gap;
  /** 拖拽柄高度（从弹窗顶边覆盖到金线之下） */
  @property
  public headDragHeight: number = dialogFrame.headDrag.height;
  /** 关闭键中心距弹窗右缘 */
  @property
  public closeButtonInsetX: number = dialogFrame.closeButton.insetX;
  /** 关闭键中心距弹窗顶缘 */
  @property
  public closeButtonInsetY: number = dialogFrame.closeButton.insetY;

  //#endregion

  /** 上次重排时的尺寸（未变化不重排） */
  private lastWidth = 0;
  private lastHeight = 0;

  protected onLoad() {
    // 摆位编辑器里也跑（executeInEditMode：prefab 所见即运行时所得）
    this.relayout();
  }

  protected start() {
    // 行为接线只在运行时（start 不进编辑器执行路径）
    // 弹窗面板整体在鼠标通道上拦截：点弹窗任意位置（含空白）不穿透到下层 HUD
    blockClickThrough(this.node);
    // 同屏多弹窗时，点哪个哪个浮到其它弹窗之上（LayerManager.raiseDialog）
    bindDialogRaiseOnPress(this.node);
    // 拖拽柄拖的是弹窗根（#1090）
    if (this.headDrag) {
      const draggable = this.headDrag.getComponent(Draggable);
      if (draggable) draggable.dragTarget = this.node;
    }
    // 关闭键点击销毁整窗
    if (this.closeButtonNode) {
      this.closeButtonNode.on(Node.EventType.TOUCH_END, () => this.node.destroy());
    }
  }

  protected update() {
    const transform = this.getComponent(UITransform);
    if (!transform) return;
    const { width, height } = transform.contentSize;
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.relayout();
  }

  /** 设置弹窗尺寸（子件摆位与底板重画随后自动跟上：本组件 update 重排 + VectorPlate 重画） */
  public setSize(size: Size) {
    this.getComponent(UITransform)!.setContentSize(size.width, size.height);
    this.relayout();
  }

  /** 写标题文案（只写 string，不碰样式 —— #1359 口径） */
  public setTitle(text: string) {
    if (this.titleLabel) this.titleLabel.string = text;
  }

  /** 写眉题文案（空串 = 整块隐藏，与原 createDialog「不传则不画」同口径） */
  public setEyebrow(text: string) {
    if (!this.eyebrowLabel) return;
    this.eyebrowLabel.string = text;
    this.eyebrowLabel.node.active = text !== "";
  }

  /**
   * 按当前尺寸重排头部五件（拖拽柄 / 眉题 / 关闭键 / 标题 / 金线）
   *
   * 几何规则与原 createDialog 一致：各段内缩从顶边/左右边缘起算，
   * 子件坐标以弹窗中心为原点（prefab 里的默认摆位就是这套公式的默认尺寸值）。
   */
  public relayout() {
    const transform = this.getComponent(UITransform);
    if (!transform) return;
    const { width, height } = transform.contentSize;
    if (width <= 0 || height <= 0) return;
    this.lastWidth = width;
    this.lastHeight = height;
    const halfW = width / 2;
    const halfH = height / 2;
    // 拖拽柄：通栏，顶边对齐（中心 y = 半高 − 半柄高）
    if (this.headDrag) {
      this.headDrag.setPosition(0, halfH - this.headDragHeight / 2, 0);
      this.headDrag.getComponent(UITransform)?.setContentSize(width, this.headDragHeight);
    }
    // 眉题：左上角，左对齐
    if (this.eyebrowLabel) {
      this.eyebrowLabel.node.setPosition(-halfW + this.eyebrowLeft + this.eyebrowWidth / 2, halfH - this.eyebrowTop - this.eyebrowHeight / 2, 0);
    }
    // 关闭键：右上角
    if (this.closeButtonNode) {
      this.closeButtonNode.setPosition(halfW - this.closeButtonInsetX, halfH - this.closeButtonInsetY, 0);
    }
    // 标题：居中（文本框宽随弹窗宽收窄）
    const titleY = halfH - this.titleInsetTop;
    if (this.titleLabel) {
      this.titleLabel.node.setPosition(0, titleY, 0);
      this.titleLabel.getComponent(UITransform)?.setContentSize(width - this.titleWidthPadding, this.titleHeight);
    }
    // 短金线：标题正下方
    if (this.titleRule) {
      this.titleRule.setPosition(0, titleY - this.titleHeight / 2 - this.ruleGap, 0);
      this.titleRule.getComponent(UITransform)?.setContentSize(this.ruleWidth, this.ruleHeight);
    }
  }
}
