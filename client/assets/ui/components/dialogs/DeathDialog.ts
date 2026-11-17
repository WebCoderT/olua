import { Graphics, Node, UITransform } from "cc";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";
import { buttonTone, deathDialogLayout, T } from "../../../configs/hudLayout";

/** 复活方式回调（由组合根注入，见 ui/Game.reviveRole） */
interface DeathDialogCallbacks {
  /** 原地复活：在死亡的位置复活 */
  onReviveInPlace: () => void;
  /** 安全复活：回到当前地图的复活点 */
  onReviveSafe: () => void;
}

/**
 * 死亡遮罩弹窗（自身即全屏节点，挂 UI 层）
 * 角色死亡后盖住整个屏幕：黑色半透明遮罩 + 居中的「您已死亡」与两个复活按钮（原地复活 / 安全复活）
 * 遮罩节点参与 UI 命中判定（见 utils/input/UiHit），挡住世界点击——死亡期间点不到怪物与掉落物，
 * 按钮自己走 TOUCH_END 节点事件，不受影响
 * 弹窗由组合根在进入死亡流程时创建、复活完成后销毁，不做通用弹窗复用
 */
export default class DeathDialog extends Node {
  constructor(callbacks: DeathDialogCallbacks) {
    // 布局与配色见 configs/hudLayout.deathDialogLayout
    const layout = deathDialogLayout;
    super(layout.name);
    const screenSize = UiHelper.getScreenSize();
    this.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    // 黑色半透明遮罩（Graphics 纯色填充，不需要图片资源）
    const mask = new Node("death_mask");
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    this.addChild(mask);
    // 死亡面板（稿 20-overlay 的 `.death`：560 宽主面板，深底 + 上半暗朱亮带）
    const panel = layout.panel;
    const panelNode = UiHelper.createNode(panel.name, panel.position, panel.size);
    // 眉题（全弹窗统一副标题口径，见 createEyebrow）
    panelNode.addChild(GameUiHelper.createEyebrow(`${panel.name}_eyebrow`, panel.size, layout.eyebrow));
    const panelGraphics = panelNode.addComponent(Graphics);
    panelGraphics.fillColor = panel.fill;
    panelGraphics.roundRect(-panel.size.width / 2, -panel.size.height / 2, panel.size.width, panel.size.height, panel.radius);
    panelGraphics.fill();
    panelGraphics.fillColor = panel.fillTop;
    const bandHeight = panel.size.height * panel.fillTopRatio;
    panelGraphics.roundRect(-panel.size.width / 2, panel.size.height / 2 - bandHeight, panel.size.width, bandHeight, panel.radius);
    panelGraphics.fill();
    panelGraphics.lineWidth = T.border.widthStrong;
    panelGraphics.strokeColor = panel.border;
    panelGraphics.roundRect(-panel.size.width / 2, -panel.size.height / 2, panel.size.width, panel.size.height, panel.radius);
    panelGraphics.stroke();
    this.addChild(panelNode);
    // 死亡提示与两个复活按钮（居中偏下排布）
    const title = layout.title;
    this.addChild(UiHelper.createLabel("death_title", title.text, title.color, title.fontSize, title.position, title.size));
    const subtitle = layout.subtitle;
    this.addChild(UiHelper.createLabel("death_subtitle", subtitle.text, subtitle.color, subtitle.fontSize, subtitle.position, subtitle.size));
    const reviveInPlaceButton = GameUiHelper.createToneButton(
      layout.reviveInPlaceButton.name,
      layout.reviveInPlaceButton.text,
      layout.reviveInPlaceButton.position,
      layout.buttonSize,
      layout.buttonFontSize,
      buttonTone.primary,
    );
    const reviveSafeButton = GameUiHelper.createToneButton(
      layout.reviveSafeButton.name,
      layout.reviveSafeButton.text,
      layout.reviveSafeButton.position,
      layout.buttonSize,
      layout.buttonFontSize,
      buttonTone.ghost,
    );
    reviveInPlaceButton.on(Node.EventType.TOUCH_END, () => callbacks.onReviveInPlace(), this);
    reviveSafeButton.on(Node.EventType.TOUCH_END, () => callbacks.onReviveSafe(), this);
    this.addChild(reviveInPlaceButton);
    this.addChild(reviveSafeButton);
  }
}
