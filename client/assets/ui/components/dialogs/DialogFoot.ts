import { _decorator, Component, Label, Node, Prefab, UITransform } from "cc";

const { ccclass, property } = _decorator;

/**
 * 弹窗页脚组件（#1386 弹窗 prefab 化第一期；ui.css `.panel-foot`）
 *
 * 骨架本体是 `ui/prefabs/dialogs/DialogFoot.prefab`：通栏 1px 分隔线（FillRect）+
 * 两端各一行小字（Label）。结构与字号/颜色/线色在 prefab；摆位几何随弹窗尺寸变，
 * 由 `setGeometry` 运行时写入（`configs/layout/dialogs` 的 `dialogFootLayout(size)` 计算），
 * 文案由调用方给 —— 代码只写 string 与几何，不碰任何样式。
 */
@ccclass("DialogFoot")
export default class DialogFoot extends Component {
  /** 通栏分隔线（FillRect） */
  @property({ type: Node })
  public rule: Node | null = null;
  /** 左端小字 */
  @property({ type: Label })
  public leftLabel: Label | null = null;
  /** 右端小字 */
  @property({ type: Label })
  public rightLabel: Label | null = null;

  /** 由 Game 场景在 start 时把 prefab 注入进来（NpcDialog 同款静态引用） */
  private static prefab: Prefab | null = null;
  public static setPrefab(prefab: Prefab | null): void {
    DialogFoot.prefab = prefab;
  }
  public static getPrefab(): Prefab | null {
    return DialogFoot.prefab;
  }

  /**
   * 写页脚几何（随弹窗尺寸算出的摆位；颜色/字号归 prefab 不在这里）
   *
   * @param geometry `dialogFootLayout(size)` 的返回值（线 y / 文字 y / 两端 x / 文本块宽高）
   */
  public setGeometry(geometry: { lineY: number; textY: number; leftX: number; rightX: number; width: number; height: number }) {
    const transform = this.getComponent(UITransform);
    if (transform) transform.setContentSize(geometry.width, geometry.height);
    if (this.rule) {
      this.rule.setPosition(0, geometry.lineY, 0);
      this.rule.getComponent(UITransform)?.setContentSize(geometry.width, 1);
    }
    if (this.leftLabel) this.leftLabel.node.setPosition(geometry.leftX, geometry.textY, 0);
    if (this.rightLabel) this.rightLabel.node.setPosition(geometry.rightX, geometry.textY, 0);
  }

  /** 写两端文案（只写 string，不碰样式 —— #1359 口径） */
  public setTexts(left: string, right: string) {
    if (this.leftLabel) this.leftLabel.string = left;
    if (this.rightLabel) this.rightLabel.string = right;
  }
}
