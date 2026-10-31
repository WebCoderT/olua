import { Label, Node, ProgressBar, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色血量显示组件（圆形血球 + 血量文字）
 *
 * 本节点（role_hp_orb）自身位置即血球在底部栏里的位置（见 hudLayout.bottomBar.hpOrb.position，
 * 固定值直接手调，改它整球一起动）；球图在节点原点，血量文字相对球心偏移（hpOrb.text）
 */
export default class RoleHpOrb extends Node {
  /** 血量文字 */
  private hpText: Label;
  /** 圆形血球进度条 */
  private hpBar: ProgressBar;

  constructor(role: Role) {
    super("role_hp_orb");
    const { position, text } = bottomBarLayout.hpOrb;
    // 节点自身摆到配置位置（球图与文字都以它为原点）
    this.setPosition(position.x, position.y, 0);
    // 血量文字（由 GameUiHelper 生成，相对球心偏移）
    this.hpText = GameUiHelper.createHpText(`${role.hp} / ${role.maxHp}`, text.position, text.size, "hp_text", text.fontSize).getComponent(Label);
    this.addChild(this.hpText.node);
    // 圆形血量显示（底图 + 竖向进度条，球图在节点原点）
    const { barSprite, hpBar } = GameUiHelper.createRoundHpBar(role.hp / role.maxHp, new Vec2(), bottomBarLayout.hpOrb.size);
    this.hpBar = hpBar.getComponent(ProgressBar);
    this.addChild(barSprite);
  }

  /** 数据变更后刷新血量显示 */
  update(role: Role) {
    this.hpText.string = `${role.hp} / ${role.maxHp}`;
    this.hpBar.progress = role.hp / role.maxHp;
  }
}
