import { Label, Node, ProgressBar, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout, uiImages } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色魔法值显示组件（圆形魔法球 + 魔法值文字，仅在底部栏显示）
 *
 * 显示逻辑与血量显示（RoleHpOrb）一致：填充图换为蓝色魔法球（uiImages.mpOrbFill）。
 * 本节点（role_mp_orb）自身位置即魔法球在底部栏里的位置（见 hudLayout.bottomBar.mpOrb.position，
 * 固定值直接手调，改它整球一起动）；球图在节点原点，魔法值文字相对球心偏移（mpOrb.text）
 */
export default class RoleMpOrb extends Node {
  /** 魔法值文字 */
  private mpText: Label;
  /** 圆形魔法球进度条 */
  private mpBar: ProgressBar;

  constructor(role: Role) {
    super("role_mp_orb");
    const { position, text } = bottomBarLayout.mpOrb;
    // 节点自身摆到配置位置（球图与文字都以它为原点）
    this.setPosition(position.x, position.y, 0);
    // 魔法值文字（复用血量文字零件，位置/尺寸/字号传魔法球布局）
    this.mpText = GameUiHelper.createHpText(`${role.mp} / ${role.maxMp}`, text.position, text.size, "mp_text", text.fontSize).getComponent(Label);
    this.addChild(this.mpText.node);
    // 圆形魔法值显示（底图 + 竖向进度条，填充图为蓝色魔法球，球图在节点原点）
    const { barSprite, hpBar } = GameUiHelper.createRoundHpBar(role.mp / role.maxMp, new Vec2(), bottomBarLayout.mpOrb.size, uiImages.mpOrbFill);
    this.mpBar = hpBar.getComponent(ProgressBar);
    this.addChild(barSprite);
  }

  /** 数据变更后刷新魔法值显示 */
  update(role: Role) {
    this.mpText.string = `${role.mp} / ${role.maxMp}`;
    this.mpBar.progress = role.mp / role.maxMp;
  }
}
