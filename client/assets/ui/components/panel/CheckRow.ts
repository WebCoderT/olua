import { Color, Label, Node, Size, Sprite, UITransform, Vec2 } from "cc";
import UiHelper from "../../helpers/UiHelper";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { uiImages } from "../../../configs/layout/images";

/**
 * 勾选行（#1278）：两态勾选框图 + 文字，整行可点
 *
 * 三个自动弹窗（自动回收 / 自动使用）与角色信息弹窗的「自动穿戴」开关共用同一行样式，
 * 勾选框复用登录页的两态 PNG（`ui/login/icon-checkbox[-checked].png`，uiImages 已登记）。
 * 点击整行切换（不是只点小框）：清单行 24px 高，逐像素瞄准 16px 的框太苛刻。
 */
export default class CheckRow extends Node {
  /** 勾选框 sprite（两态换图用） */
  private checkboxSprite: Sprite | null = null;
  /** 当前勾选态 */
  private checked: boolean;

  /**
   * @param name 节点名
   * @param text 行文字（物品名 / 开关说明）
   * @param checked 初始勾选态
   * @param layout 行几何与字号配色（宽 = 整行可点范围，高 = 行高）
   * @param onToggle 勾选态变化回调（切换后调用；初始态不触发）
   */
  constructor(
    name: string,
    text: string,
    checked: boolean,
    layout: { width: number; height: number; fontSize: number; color: Color },
    onToggle: (checked: boolean) => void,
  ) {
    super(name);
    this.checked = checked;
    this.addComponent(UITransform).setContentSize(layout.width, layout.height);
    // 勾选框（两态图，居左；src 传空串让 createSprite 只建组件，图由 swapCheckboxIcon 统一加载）
    const box = UiHelper.createSprite(`${name}_checkbox`, "", new Vec2(-layout.width / 2 + 12, 0), new Size(16, 16));
    this.checkboxSprite = box.getComponent(Sprite) ?? null;
    this.addChild(box);
    this.swapCheckboxIcon();
    // 行文字（框右侧留 24：框 16 + 间距 8）
    this.addChild(
      UiHelper.createLabel(`${name}_label`, text, layout.color, layout.fontSize, new Vec2(-layout.width / 2 + 24, 0), new Size(layout.width - 24, layout.height), Label.HorizontalAlign.LEFT),
    );
    // 整行可点：点击音 + 鼠标通道拦截（防穿透，与登录页勾选框同一套口径）+ 触摸切换
    SoundManager.bindClick(this);
    blockClickThrough(this);
    this.on(Node.EventType.TOUCH_END, () => {
      this.setChecked(!this.checked);
      onToggle(this.checked);
    }, this);
  }

  /** 当前勾选态 */
  isChecked(): boolean {
    return this.checked;
  }

  /** 设置勾选态（换两态图；不触发 onToggle —— 回填初始态用） */
  setChecked(checked: boolean): void {
    this.checked = checked;
    this.swapCheckboxIcon();
  }

  /** 按当前勾选态换勾选框图（登录页 swapIcon 同款：加载失败保持原图不闪白） */
  private swapCheckboxIcon(): void {
    if (!this.checkboxSprite) return;
    const src = this.checked ? uiImages.loginCheckboxCheckedIcon : uiImages.loginCheckboxIcon;
    UiHelper.loadSprite(src, (frame) => {
      if (this.checkboxSprite && this.checkboxSprite.isValid) this.checkboxSprite.spriteFrame = frame;
    });
  }
}
