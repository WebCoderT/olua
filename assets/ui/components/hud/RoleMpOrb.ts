import { Label, Node, ProgressBar } from "cc";
import { Role } from "../../../entities/Role";
import { bottomBarLayout, uiImages } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色魔法值显示组件（圆形魔法球 + 魔法值文字，仅在底部栏显示）
 * 显示逻辑与血量显示（RoleHpOrb）一致：填充图换为蓝色魔法球（uiImages.mpOrbFill），
 * 本组件为原点包装节点，内部魔法值文字与魔法球保持底部栏坐标系下的原有位置（见 hudLayout.bottomBar.mpText / mpOrb）
 */
export default class RoleMpOrb extends Node {
  /** 魔法值文字 */
  private mpText: Label;
  /** 圆形魔法球进度条 */
  private mpBar: ProgressBar;

  constructor(role: Role) {
    super("role_mp_orb");
    // 魔法值文字（复用血量文字零件，位置/尺寸传魔法值布局）
    this.mpText = GameUiHelper.createHpText(`${role.mp} / ${role.maxMp}`, bottomBarLayout.mpText.position, bottomBarLayout.mpText.size, "mp_text").getComponent(Label);
    this.addChild(this.mpText.node);
    // 圆形魔法值显示（底图 + 竖向进度条，填充图为蓝色魔法球）
    const { barSprite, hpBar } = GameUiHelper.createRoundHpBar(role.mp / role.maxMp, bottomBarLayout.mpOrb.position, bottomBarLayout.mpOrb.size, uiImages.mpOrbFill);
    this.mpBar = hpBar.getComponent(ProgressBar);
    this.addChild(barSprite);
  }

  /** 数据变更后刷新魔法值显示 */
  update(role: Role) {
    this.mpText.string = `${role.mp} / ${role.maxMp}`;
    this.mpBar.progress = role.mp / role.maxMp;
  }
}
