import { Color, Label, Node, resources, sp, Sprite, SpriteFrame, UITransform } from "cc";

/** 快捷键 */
export default class ShortcutKey extends Node {
  /** 快捷键名称 */
  private label: string;
  /** 监听的键盘输入 */
  private listenKey: number;
  /** 图标 */
  private spriteSrc?: string;

  /** 构建 */
  private init() {
    this.initUI();
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
    this.updateIcon();
  }

  /** 修改图标 */
  public updateIcon(spriteSrc?: string, onClick?: Function) {
    this.spriteSrc = spriteSrc;
    const sprite = this.getComponent(Sprite);
    if (this.spriteSrc) {
      resources.load(`${this.spriteSrc}/spriteFrame`, SpriteFrame, (err, spriteFrame) => {
        if (err) throw new Error(`${this.label}图标加载失败`);
        sprite.spriteFrame = spriteFrame;
      });
      this.on(Node.EventType.TOUCH_END, onClick, this);
    } else {
      this.off(Node.EventType.TOUCH_END);
    }
  }

  constructor(label: string, listenKey: number, spriteSrc?: string, onClick?: Function) {
    super(`shortcut_key_${label}`);
    this.label = label;
    this.listenKey = listenKey;
    this.init();
    this.updateIcon(spriteSrc, onClick);
  }
}
