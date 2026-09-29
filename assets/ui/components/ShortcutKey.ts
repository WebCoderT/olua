import { Color, Label, Node, resources, Sprite, SpriteFrame, UITransform } from "cc";

/** 快捷键组件 */
export default class ShortcutKey extends Node {
  /** 快捷键名称 */
  private label: string;
  /** 监听的键盘输入 */
  private listenKey: number;
  /** 图标 */
  private spriteSrc?: string;

  constructor(label: string, listenKey: number, spriteSrc?: string, onClick?: Function) {
    super(`shortcut_key_${label}`);
    this.label = label;
    this.listenKey = listenKey;
    this.initUI();
    this.updateIcon(spriteSrc, onClick);
  }

  /** 构建UI */
  private initUI() {
    const sprite = this.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    const uitransform = this.getComponent(UITransform);
    uitransform.setContentSize(40, 40);
    const labelNode = new Node();
    labelNode.setPosition(20, -15);
    const label = labelNode.addComponent(Label);
    label.string = this.label;
    label.fontSize = 10;
    label.color = Color.WHITE;
    label.lineHeight = 10;
    this.addChild(labelNode);
  }

  /** 修改图标（同时更新点击回调） */
  public updateIcon(spriteSrc?: string, onClick?: Function) {
    this.spriteSrc = spriteSrc;
    // 先移除旧的点击监听，避免重复注册
    this.off(Node.EventType.TOUCH_END);
    const sprite = this.getComponent(Sprite);
    if (this.spriteSrc) {
      resources.load(`${this.spriteSrc}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
        if (err) {
          console.error(`${this.label}图标加载失败`);
          return;
        }
        if (sprite.isValid) sprite.spriteFrame = spriteFrame;
      });
      this.on(Node.EventType.TOUCH_END, onClick, this);
    }
  }
}
