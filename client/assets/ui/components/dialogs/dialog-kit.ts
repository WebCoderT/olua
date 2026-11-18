/**
 * 弹窗共用件（与 tab-kit 同层）：标准弹窗的开关骨架 + 列表空态 + 1px 横向分隔线
 *
 * BaseDialog 收编各弹窗 open/close 的逐字重复（#1115 批次 4）：
 * toggle（重复点即关）→ 清残留引用 → createDialog 骨架 → 页脚 → 防穿透 → 进 UI 图层
 * → body 容器 → build 回调 → onOpen 钩子；关闭统一 onClose 钩子 → 销毁 → 清引用。
 * 子类只写差异：自己的 layout、body 里建什么、订阅与定时器放 onOpen/onClose。
 */
import { Color, Graphics, Node, Size, Vec2, isValid } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import UiHelper from "../../helpers/UiHelper";
import type { dialogFootLayout } from "../../../configs/layout/dialogs";
import { blockClickThrough } from "../../utils/input/UiHit";

/** 页脚几何类型 = configs 的 dialogFootLayout 返回值形状 */
export type DialogFootGeometry = ReturnType<typeof dialogFootLayout>;

/** 弹窗骨架入参：name/title/eyebrow/size 必给；有页脚的弹窗给 foot + footTexts */
export interface DialogFrameConfig {
  name: string;
  title: string;
  eyebrow?: string;
  size: Size;
  foot?: DialogFootGeometry;
  footTexts?: { left: string; right: string };
}

export default abstract class BaseDialog {
  /** 弹窗根（openFrame/closeFrame 维护；子类不再自己声明） */
  protected dialog: Node | null = null;
  /** 内容容器（挂在骨架下，子类往里建内容） */
  protected body: Node | null = null;

  /** 打开（重复点即关闭）。返回 true = 本次打开了（少数调用方要据此刷新） */
  protected openFrame(config: DialogFrameConfig, build: (dialog: Node, body: Node) => void): boolean {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return false;
    }
    // 弹窗已在场景切换中被销毁时清残留状态（与各弹窗原 reset 语义一致）
    if (this.dialog && !isValid(this.dialog)) {
      this.reset();
      this.dialog = null;
      this.body = null;
    }
    this.dialog = GameUiHelper.createDialog(config.name, config.title, new Vec2(), config.size, config.eyebrow);
    // 页脚（稿 .panel-foot）：左操作提示 / 右说明文字，几何按面板尺寸算
    if (config.foot && config.footTexts) {
      this.dialog.addChild(
        GameUiHelper.createDialogFoot(`${config.name}_foot`, config.size.width, config.foot, config.footTexts.left, config.footTexts.right),
      );
    }
    // 弹窗整体吃掉点击：否则点在卡片之间的空隙会穿透到下层 UI（见 audit-ui-click-through）
    blockClickThrough(this.dialog);
    LayerManager.addDialogToUILayer(this.dialog);
    this.body = UiHelper.createGroupNode(`${config.name}_body`, new Vec2());
    this.dialog.addChild(this.body);
    build(this.dialog, this.body);
    this.onOpen();
    return true;
  }

  /** 关闭：钩子先行（退订 / 清定时器），再销毁并清引用 */
  close() {
    this.onClose();
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.body = null;
    this.reset();
  }

  /** 打开后的钩子（订阅 Store、初始刷新等）；关闭时由 onClose 成对退订 */
  protected onOpen(): void {}

  /** 关闭前的钩子（退订 / 清定时器 / 清 armed 状态） */
  protected onClose(): void {}

  /** 子类残留状态清理（reset 语义）；默认无操作 */
  protected reset(): void {}
}

/** 列表空态样式：灰字配色与字号 + 行宽（给足高度，否则纵向 Layout 量出来是 0） */
export interface ListEmptyStyle {
  color: Color;
  fontSize: number;
  width: number;
  height: number;
}

/** 列表空态：一行灰字（六个弹窗的同款实现收编，#1115 批次 4） */
export function createListEmpty(name: string, text: string, style: ListEmptyStyle): Node {
  return UiHelper.createLabel(name, text, style.color, style.fontSize, new Vec2(), new Size(style.width, style.height));
}

/**
 * 1px 横向分隔线（横贯给定宽度，居中锚点）
 *
 * ⚠️ 用 fill 画矩形而不是 stroke：Graphics 的 1px 描边在 web 构建里整条不渲染（引擎坑，
 * 见 dialog-builder.drawGlassPlate 与 tab-kit 同款注释）。
 */
export function createHDivider(name: string, width: number, color: Color): Node {
  const node = UiHelper.createNode(name, new Vec2(), new Size(width, 1));
  const graphics = node.addComponent(Graphics);
  graphics.fillColor = color;
  graphics.rect(-width / 2, -0.5, width, 1);
  graphics.fill();
  return node;
}
