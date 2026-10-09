import { Node, ProgressBar } from "cc";
import { Role } from "../../../entities/Role";
import { getCurrentLevelExpRate } from "../../../configs/level";
import { bottomBarLayout } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色经验条组件
 * 本组件为原点包装节点，内部经验条保持底部栏坐标系下的原有位置（见 hudLayout.bottomBar.expBar）
 */
export default class RoleExpBar extends Node {
  /** 经验条节点（含 ProgressBar） */
  private bar: Node;

  constructor(role: Role) {
    super("role_exp_bar");
    this.bar = GameUiHelper.createExpBar("exp", getCurrentLevelExpRate(role.level, role.exp), bottomBarLayout.expBar.position, bottomBarLayout.expBar.size);
    this.addChild(this.bar);
  }

  /** 数据变更后刷新经验进度 */
  update(role: Role) {
    this.bar.getComponent(ProgressBar).progress = getCurrentLevelExpRate(role.level, role.exp);
  }
}
