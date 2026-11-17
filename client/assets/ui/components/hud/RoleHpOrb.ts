import { Label, Node, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout, T } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色血量显示组件（矢量圆形血球 + 血量文字 + 「生命」小标题）
 *
 * 本节点（role_hp_orb）自身位置即血球在底部栏里的位置（见 hudLayout.bottomBar.hpOrb.position，
 * 固定值直接手调，改它整球一起动）；球体在节点原点，血量文字居中在球心（hpOrb.text），
 * 小标题挂在球下方（hpOrb.caption）。球体为矢量绘制（新稿口径，HUD 不用贴图），
 * 液面颜色取朱红 ember2（与血条同色系）
 */
export default class RoleHpOrb extends Node {
  /** 血量文字 */
  private hpText: Label;
  /** 液面进度刷新（矢量球返回的 setProgress） */
  private setProgress: (p: number) => void;

  constructor(role: Role) {
    super("role_hp_orb");
    const layout = bottomBarLayout.hpOrb;
    // 节点自身摆到配置位置（球体与文字都以它为原点）
    this.setPosition(layout.position.x, layout.position.y, 0);
    // 矢量圆形血量显示（液面竖向渐变：亮端 hpHi → 深端 ember1；**先挂球体**：矢量球的液面是 Graphics，
    // 会把后挂的兄弟节点盖住，所以文字必须排在球之后才看得见；贴图时代球是 Sprite，同样按兄弟顺序绘制）
    const orb = GameUiHelper.createRoundOrb(role.hp / role.maxHp, new Vec2(), layout.size, T.hpHi, T.ember[1]);
    this.setProgress = orb.setProgress;
    this.addChild(orb.node);
    // 血量文字（居中在球心，压在液面之上）
    this.hpText = GameUiHelper.createHpText(`${role.hp} / ${role.maxHp}`, layout.text.position, layout.text.size, "hp_text", layout.text.fontSize).getComponent(Label);
    this.addChild(this.hpText.node);
    // 球下小标题（稿 .orb-cap：10px、字距拉开、text-3）
    const caption = GameUiHelper.createText("hp_caption", layout.caption.text, layout.caption.fontSize, layout.caption.position, layout.caption.size, layout.caption.color);
    const captionLabel = caption.getComponent(Label);
    if (captionLabel) captionLabel.spacingX = layout.caption.spacingX;
    this.addChild(caption);
  }

  /** 数据变更后刷新血量显示 */
  update(role: Role) {
    this.hpText.string = `${role.hp} / ${role.maxHp}`;
    this.setProgress(role.hp / role.maxHp);
  }
}
