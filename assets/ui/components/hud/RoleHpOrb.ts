import { Label, Node, ProgressBar, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 血量文字布局（底部栏内固定几何） */
const HP_TEXT_POSITION = new Vec2(-421, -39);
const HP_TEXT_SIZE = new Size(120, 10);
/** 血球布局（底部栏内固定几何） */
const HP_ORB_POSITION = new Vec2(-420, 12.5);

/**
 * 角色血量显示组件（圆形血球 + 血量文字）
 * 本组件为原点包装节点，内部血量文字与血球保持底部栏坐标系下的原有位置，不改动既有布局
 */
export default class RoleHpOrb extends Node {
  /** 血量文字 */
  private hpText: Label;
  /** 圆形血球进度条 */
  private hpBar: ProgressBar;

  constructor(role: Role) {
    super("role_hp_orb");
    // 血量文字（由 GameUiHelper 生成）
    this.hpText = GameUiHelper.createHpText(`${role.hp} / ${role.maxHp}`, HP_TEXT_POSITION, HP_TEXT_SIZE).getComponent(Label);
    this.addChild(this.hpText.node);
    // 圆形血量显示（底图 + 竖向进度条）
    const { barSprite, hpBar } = GameUiHelper.createRoundHpBar(role.hp / role.maxHp, HP_ORB_POSITION);
    this.hpBar = hpBar.getComponent(ProgressBar);
    this.addChild(barSprite);
  }

  /** 数据变更后刷新血量显示 */
  update(role: Role) {
    this.hpText.string = `${role.hp} / ${role.maxHp}`;
    this.hpBar.progress = role.hp / role.maxHp;
  }
}
