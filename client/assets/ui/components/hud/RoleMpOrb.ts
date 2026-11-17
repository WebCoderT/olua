import { Label, Node, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout, T } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色魔法值显示组件（矢量圆形魔法球 + 魔法值文字 + 「法力」小标题）
 *
 * 显示逻辑与血量显示（RoleHpOrb）一致：液面颜色换为法力的 frost 色。
 * 本节点（role_mp_orb）自身位置即魔法球在底部栏里的位置（见 hudLayout.bottomBar.mpOrb.position，
 * 固定值直接手调，改它整球一起动）；球体在节点原点，魔法值文字居中在球心（mpOrb.text），
 * 小标题挂在球下方（mpOrb.caption）
 */
export default class RoleMpOrb extends Node {
  /** 魔法值文字 */
  private mpText: Label;
  /** 液面进度刷新（矢量球返回的 setProgress） */
  private setProgress: (p: number) => void;

  constructor(role: Role) {
    super("role_mp_orb");
    const layout = bottomBarLayout.mpOrb;
    this.setPosition(layout.position.x, layout.position.y, 0);
    // 矢量圆形魔法值显示（液面竖向渐变：亮端 mpHi → 深端 frostDeep；先挂球体，文字随后压在液面之上）
    const orb = GameUiHelper.createRoundOrb(role.mp / role.maxMp, new Vec2(), layout.size, T.mpHi, T.frostDeep);
    this.setProgress = orb.setProgress;
    this.addChild(orb.node);
    // 魔法值文字（复用血量文字零件，居中在球心）
    this.mpText = GameUiHelper.createHpText(`${role.mp} / ${role.maxMp}`, layout.text.position, layout.text.size, "mp_text", layout.text.fontSize).getComponent(Label);
    this.addChild(this.mpText.node);
    // 球下小标题（稿 .orb-cap：10px、字距拉开、text-3）
    const caption = GameUiHelper.createText("mp_caption", layout.caption.text, layout.caption.fontSize, layout.caption.position, layout.caption.size, layout.caption.color);
    const captionLabel = caption.getComponent(Label);
    if (captionLabel) captionLabel.spacingX = layout.caption.spacingX;
    this.addChild(caption);
  }

  /** 数据变更后刷新魔法值显示 */
  update(role: Role) {
    this.mpText.string = `${role.mp} / ${role.maxMp}`;
    this.setProgress(role.mp / role.maxMp);
  }
}
