import { Node, ProgressBar, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { getCurrentLevelExpRate } from "../../../configs/level";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 经验条布局（底部栏内固定几何） */
const EXP_POSITION = new Vec2(0, -44.5);
const EXP_SIZE = new Size(724, 8);

/**
 * 角色经验条组件
 * 本组件为原点包装节点，内部经验条保持底部栏坐标系下的原有位置，不改动既有布局
 */
export default class RoleExpBar extends Node {
  /** 经验条节点（含 ProgressBar） */
  private bar: Node;

  constructor(role: Role) {
    super("role_exp_bar");
    this.bar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(role.level, role.exp), EXP_POSITION, EXP_SIZE);
    this.addChild(this.bar);
  }

  /** 数据变更后刷新经验进度 */
  update(role: Role) {
    this.bar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(role.level, role.exp);
  }
}
