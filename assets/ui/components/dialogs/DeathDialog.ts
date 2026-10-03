import { Color, Graphics, Node, Size, UITransform, Vec2 } from "cc";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";

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
    super("death_dialog");
    const screenSize = UiHelper.getScreenSize();
    this.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    // 黑色半透明遮罩（Graphics 纯色填充，不需要图片资源）
    const mask = new Node("death_mask");
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = new Color(0, 0, 0, 160);
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    this.addChild(mask);
    // 死亡提示与两个复活按钮（居中偏下排布）
    this.addChild(UiHelper.createLabel("death_title", "您已死亡", Color.WHITE, 36, new Vec2(0, 90), new Size(400, 60)));
    const reviveInPlaceButton = GameUiHelper.createMiddleButton("revive_in_place_button", "原地复活", new Vec2(-140, -30));
    const reviveSafeButton = GameUiHelper.createMiddleButton("revive_safe_button", "安全复活", new Vec2(140, -30));
    reviveInPlaceButton.on(Node.EventType.TOUCH_END, () => callbacks.onReviveInPlace(), this);
    reviveSafeButton.on(Node.EventType.TOUCH_END, () => callbacks.onReviveSafe(), this);
    this.addChild(reviveInPlaceButton);
    this.addChild(reviveSafeButton);
  }
}
