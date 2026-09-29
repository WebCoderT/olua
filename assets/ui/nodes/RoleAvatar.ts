import { Button, Color, Font, Label, LabelAtlas, Node, resources, Size, Sprite, SpriteFrame, UITransform, Vec2 } from "cc";
import { RELATION_SHIP } from "../../types/common";
import { Role } from "../../configs/role";

export default class RoleAvatar extends Node {
  private nameLabel: Label;
  private levelLabel: Label;
  private goldCountLabel: Label;
  private bindGoldCountLabel: Label;
  private silverCountLabel: Label;
  private combatLabel: Label;

  constructor(private role: Role) {
    super("role_avatar");
    this.createUI();
  }

  private createUI() {
    const transform = this.addComponent(UITransform);
    transform.setContentSize(300, 70);
    this.setPosition(this.role.relationShip === RELATION_SHIP.SELF ? -648 : 0, this.role.relationShip === RELATION_SHIP.SELF ? 324 : 0);

    this.createSprite("role_info_background", "common/user-info-frame", new Vec2(), new Size(300, 70));
    this.nameLabel = this.createLabel("role_name", this.role.name, 16, new Vec2(17, 24), new Size(190, 24), Label.HorizontalAlign.LEFT);
    this.levelLabel = this.createLabel("role_level", this.role.level.toString(), 16, new Vec2(-138, -17.5), new Size(24, 24));
    this.createSprite(`role_avatar_${this.role.occupation}_${this.role.sex}`, `avatars/${this.role.occupation}-${this.role.sex}`, new Vec2(-109.5, 7.5), new Size(51, 60));

    this.createSprite("gold_icon", "money/gold", new Vec2(-68, -20), new Size(15, 10));
    this.goldCountLabel = this.createLabel("gold_count", this.role.gold.toString(), 12, new Vec2(-45, -20), new Size(30, 10), Label.HorizontalAlign.LEFT, Label.VerticalAlign.TOP);
    this.createSprite("bind_gold_icon", "money/bind-gold", new Vec2(-22, -20), new Size(15, 10));
    this.bindGoldCountLabel = this.createLabel("bind_gold_count", this.role.bindGold.toString(), 12, new Vec2(1, -20), new Size(30, 10), Label.HorizontalAlign.LEFT, Label.VerticalAlign.TOP);
    this.createSprite("silver_icon", "money/silver", new Vec2(24, -20), new Size(15, 10));
    this.silverCountLabel = this.createLabel("silver_count", this.role.silver.toString(), 12, new Vec2(47, -20), new Size(30, 10), Label.HorizontalAlign.LEFT, Label.VerticalAlign.TOP);

    this.createSprite("combat_icon", "common/combat", new Vec2(-44, 2), new Size(75, 41));
    this.combatLabel = this.createLabel("combat_number", this.role.combat.toString(), 20, new Vec2(-3.5, 4), new Size(200, 30), Label.HorizontalAlign.LEFT);
    this.combatLabel.node.getComponent(UITransform).setAnchorPoint(0, 0.5);
    resources.load("fonts/combat", LabelAtlas, (error, atlas) => {
      if (!error && atlas && this.combatLabel.isValid) this.combatLabel.font = atlas;
    });

    const vipNode = this.createSprite("vip_button", "money/vip", new Vec2(110, 30), new Size(75, 25));
    vipNode.addComponent(Button);
  }

  private createSprite(name: string, resourcePath: string, position: Vec2, size: Size): Node {
    const node = new Node(name);
    node.setPosition(position.x, position.y);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    this.addChild(node);

    resources.load(`${resourcePath}/spriteFrame`, SpriteFrame, (error, spriteFrame) => {
      if (error) {
        console.error(`${name}图片加载失败: ${error.message}`);
        return;
      }
      if (node.isValid) sprite.spriteFrame = spriteFrame;
    });

    return node;
  }

  private createLabel(
    name: string,
    text: string,
    fontSize: number,
    position: Vec2,
    size: Size,
    horizontalAlign: Label["horizontalAlign"] = Label.HorizontalAlign.CENTER,
    verticalAlign: Label["verticalAlign"] = Label.VerticalAlign.CENTER,
  ): Label {
    const node = new Node(name);
    node.setPosition(position.x, position.y);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(size);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = size.height;
    label.color = Color.WHITE;
    label.horizontalAlign = horizontalAlign;
    label.verticalAlign = verticalAlign;
    this.addChild(node);

    resources.load("fonts/msyh", Font, (error, font) => {
      if (!error && font && label.isValid) label.font = font;
    });

    return label;
  }

  updateRole(role: Role) {
    this.nameLabel.string = role.name;
    this.levelLabel.string = role.level.toString();
    this.goldCountLabel.string = role.gold.toString();
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.silverCountLabel.string = role.silver.toString();
    this.combatLabel.string = role.combat.toString();
  }
}
