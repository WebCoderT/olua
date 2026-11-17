import { Label, Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { getCurrentLevelExpRate } from "../../../configs/game-config";
import { bottomBarLayout, T } from "../../../configs/hudLayout";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色经验条组件（新稿口径：战斗列最下一行 `N 级 [进度条] M%`，与挂机条 / 技能格同宽）
 * 本组件为原点包装节点（位置见 hudLayout.bottomBar.expBar.position），内部三段横排：
 * 等级文字 ｜ 矢量进度条（金填充） ｜ 百分比文字；等级与百分比随 role 数据刷新
 */
export default class RoleExpBar extends Node {
  /** 液面进度刷新（矢量条返回的 setProgress） */
  private setProgress: (p: number) => void;
  /** 等级文字（`42 级`） */
  private levelLabel: Label;
  /** 百分比文字（`63%`） */
  private percentLabel: Label;

  constructor(role: Role) {
    super("role_exp_bar");
    const layout = bottomBarLayout.expBar;
    this.setPosition(layout.position.x, layout.position.y, 0);
    // 三段横排：等级文字贴左、进度条居中、百分比贴右；条宽 = 总宽 − 两端文字 − 两侧间距
    const barWidth = layout.size.width - layout.levelLabel.width - layout.percentLabel.width - layout.gap * 2;
    const leftEdge = -layout.size.width / 2;
    this.levelLabel = GameUiHelper.createText(
      "exp_level", `${role.level} 级`, layout.levelLabel.fontSize,
      new Vec2(leftEdge + layout.levelLabel.width / 2, 0),
      new Size(layout.levelLabel.width, 12),
    ).getComponent(Label)!;
    this.addChild(this.levelLabel.node);
    const barLeft = leftEdge + layout.levelLabel.width + layout.gap;
    const bar = GameUiHelper.createVectorBar("exp", getCurrentLevelExpRate(role.level, role.exp), new Vec2(barLeft + barWidth / 2, 0), new Size(barWidth, layout.size.height), T.gold[3]);
    this.setProgress = bar.setProgress;
    this.addChild(bar.node);
    const percentNode = GameUiHelper.createText(
      "exp_percent", "", layout.percentLabel.fontSize,
      new Vec2(leftEdge + layout.size.width - layout.percentLabel.width / 2, 0),
      new Size(layout.percentLabel.width, 12),
    );
    this.percentLabel = percentNode.getComponent(Label)!;
    this.addChild(percentNode);
    this.update(role);
  }

  /** 数据变更后刷新等级、经验进度与百分比 */
  update(role: Role) {
    const rate = getCurrentLevelExpRate(role.level, role.exp);
    this.setProgress(rate);
    this.levelLabel.string = `${role.level} 级`;
    this.percentLabel.string = `${Math.round(rate * 100)}%`;
  }
}
