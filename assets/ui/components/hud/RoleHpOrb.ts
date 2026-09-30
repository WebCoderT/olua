import { Label, Node, ProgressBar } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色血量显示组件（圆形血球 + 血量文字）
 * 本组件为原点包装节点，内部血量文字与血球保持底部栏坐标系下的原有位置（见 hudLayout.bottomBar）
 */
export default class RoleHpOrb extends Node {
  /** 血量文字 */
  private hpText: Label;
  /** 圆形血球进度条 */
  private hpBar: ProgressBar;

  constructor(role: Role) {
    super("role_hp_orb");
    // 血量文字（由 GameUiHelper 生成）
    this.hpText = GameUiHelper.createHpText(`${role.hp} / ${role.maxHp}`, bottomBarLayout.hpText.position, bottomBarLayout.hpText.size).getComponent(Label);
    this.addChild(this.hpText.node);
    // 圆形血量显示（底图 + 竖向进度条）
    const { barSprite, hpBar } = GameUiHelper.createRoundHpBar(role.hp / role.maxHp, bottomBarLayout.hpOrb.position, bottomBarLayout.hpOrb.size);
    this.hpBar = hpBar.getComponent(ProgressBar);
    this.addChild(barSprite);
  }

  /** 数据变更后刷新血量显示 */
  update(role: Role) {
    this.hpText.string = `${role.hp} / ${role.maxHp}`;
    this.hpBar.progress = role.hp / role.maxHp;
  }
}
