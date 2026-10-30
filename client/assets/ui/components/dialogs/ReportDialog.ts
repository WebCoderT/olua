import { EditBox, EventTouch, Graphics, Label, Node, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import LayerManager from "../../core/LayerManager";
import { reportDialogLayout as layout } from "../../../configs/hudLayout";
import { SocialApi } from "../../utils/net/Api";
import { blockClickThrough } from "../../utils/input/UiHit";
import { designResolution } from "../../utils/layout/ScreenLayout";

/** 类别顺序（与 layout.texts.categories 一一对应；值必须与服务端 REPORT_CATEGORIES 同集） */
const CATEGORIES = ["abuse", "cheat", "name", "other"];

/** 打开举报框的入参 */
export interface ReportDialogOptions {
  /** 被举报的角色 id（举报只认 id：入口都在「附近」列表里，那里本来就有） */
  targetRoleId: string;
  /** 被举报的角色名（只用于标题） */
  targetName: string;
  /** 提交成功后的回调（面板自己先关掉再回调） */
  onSubmitted?: () => void;
}

/**
 * 举报弹窗（#398）
 *
 * ## 为什么是弹窗而不是面板里选
 * 举报是一次性的低频操作：选类别 → 可留空说明 → 提交。做成常驻面板等于给它一个不该有的分量，
 * 而它本质上是一个「确认框 + 一个下拉」。
 *
 * ## 只提交、不判断
 * 这里不判「这个人该不该被举报」，也不看对方是否已被处理 —— 提交之后就是管理端人工的事。
 * 唯一的本地校验是「类别必选」（默认已经选好第一项，玩家不用先点再交）。
 *
 * ## 输入独占
 * 与确认框同一套：全屏遮罩 + 触摸通道停冒泡 + 鼠标通道命中即中断，
 * 否则在输入框里打字会穿透到下层（点地面走路 / 点到背包格子）。
 */
export default class ReportDialog extends Node {
  private readonly targetRoleId: string;
  private readonly onSubmitted?: () => void;
  /** 当前选中的类别下标（默认第一项） */
  private selected = 0;
  /** 类别按钮本体与文字（选中态要重画） */
  private categoryNodes: Node[] = [];
  private categoryLabels: Node[] = [];
  /** 补充说明输入框 */
  private reasonBox: EditBox | null = null;

  constructor(options: ReportDialogOptions) {
    super(layout.name);
    this.targetRoleId = options.targetRoleId;
    this.onSubmitted = options.onSubmitted;

    const screen = designResolution;
    this.addComponent(UITransform).setContentSize(screen.width, screen.height);
    const mask = new Node(`${layout.name}_mask`);
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screen.width / 2, -screen.height / 2, screen.width, screen.height);
    graphics.fill();
    this.addChild(mask);

    const panel = UiHelper.createSprite(layout.panel.name, layout.panel.background, new Vec2(), layout.panel.size);
    this.addChild(panel);
    const title = UiHelper.createLabel(
      layout.title.name,
      layout.texts.title.split("{name}").join(options.targetName),
      layout.title.color,
      layout.title.fontSize,
      layout.title.position,
      layout.title.size,
    );
    panel.addChild(title);
    panel.addChild(
      UiHelper.createLabel(layout.hint.name, layout.texts.hint, layout.hint.color, layout.hint.fontSize, layout.hint.position, layout.hint.size),
    );
    this.createCategories(panel);
    const reason = UiHelper.createInputBox(layout.reason.name, layout.texts.reasonPlaceholder, layout.reason.position, layout.reason.size);
    this.reasonBox = reason.getComponent(EditBox);
    panel.addChild(reason);
    const submit = GameUiHelper.createMiddleButton(layout.submitButton.name, layout.texts.submit, layout.submitButton.position);
    submit.on(Node.EventType.TOUCH_END, () => void this.submit(), this);
    panel.addChild(submit);
    const cancel = GameUiHelper.createMiddleButton(layout.cancelButton.name, layout.texts.cancel, layout.cancelButton.position);
    cancel.on(Node.EventType.TOUCH_END, () => this.destroy(), this);
    panel.addChild(cancel);

    // 与确认框同一套输入独占：触摸停冒泡 + 鼠标命中即中断 + 按下时浮到最上层
    blockClickThrough(this);
    GameUiHelper.bindDialogRaiseOnPress(this);
    this.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 打开举报框（挂到 UI 层顶层；与确认框同一个入口） */
  static open(options: ReportDialogOptions): void {
    LayerManager.addDialogToUILayer(new ReportDialog(options));
  }

  //#region 类别选择

  private createCategories(panel: Node) {
    layout.texts.categories.forEach((text, index) => {
      const node = UiHelper.createNode(
        `${layout.name}_category_${CATEGORIES[index]}`,
        new Vec2(layout.category.columns[index], layout.category.y),
        layout.category.size,
      );
      node.addComponent(Graphics);
      const label = UiHelper.createLabel(
        `${layout.name}_category_${CATEGORIES[index]}_label`,
        text,
        layout.category.idleText,
        layout.category.fontSize,
        new Vec2(),
        layout.category.size,
      );
      node.addChild(label);
      node.on(Node.EventType.TOUCH_END, () => this.selectCategory(index), this);
      blockClickThrough(node);
      panel.addChild(node);
      this.categoryNodes.push(node);
      this.categoryLabels.push(label);
    });
    this.paintCategories();
  }

  private selectCategory(index: number) {
    if (this.selected === index) return;
    this.selected = index;
    this.paintCategories();
  }

  /** 选中 = 金色实底深色字，未选中 = 暗底灰字（与社交弹窗的页签同一套观感） */
  private paintCategories() {
    this.categoryNodes.forEach((node, index) => {
      const active = index === this.selected;
      const graphics = node.getComponent(Graphics);
      if (graphics) {
        graphics.clear();
        const half = layout.category.size;
        graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, layout.category.radius);
        graphics.fillColor = active ? layout.category.activeFill : layout.category.idleFill;
        graphics.fill();
        if (!active) {
          graphics.lineWidth = 1;
          graphics.strokeColor = layout.category.idleBorder;
          graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, layout.category.radius);
          graphics.stroke();
        }
      }
      const label = this.categoryLabels[index]?.getComponent(Label);
      if (label) label.color = active ? layout.category.activeText : layout.category.idleText;
    });
  }

  //#endregion

  //#region 提交

  /**
   * 提交举报
   *
   * **先关自己再回调**（与 ConfirmDialog.finish 同一口径）：回调里要刷新面板，
   * 弹窗先消失才不会盖在刷新过程中；顺带挡住「同一帧内连点两次提交」。
   * 失败时**不关**：类别与说明还在，玩家可以直接重试（错误提示由请求层统一弹）。
   */
  private async submit(): Promise<void> {
    const reason = (this.reasonBox?.string ?? "").trim();
    try {
      await SocialApi.report({ roleId: this.targetRoleId, category: CATEGORIES[this.selected], reason });
      this.destroy();
      this.onSubmitted?.();
    } catch {
      /* 失败保持打开：类别与说明没丢，可以直接再点一次 */
    }
  }

  //#endregion

  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }
}
