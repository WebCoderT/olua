import { _decorator, Component, ProgressBar } from "cc";

const { ccclass, requireComponent } = _decorator;

/**
 * 矢量进度条的进度桥（Graphics 画不了 ProgressBar，旧代码又按 ProgressBar 组件刷进度）
 *
 * 挂在矢量条节点（GameUiHelper.createVectorBar 的 node）上：同节点放一个 ProgressBar
 * 作为**进度状态的持有者**（mode 任意、barSprite 留空），本组件每帧把 ProgressBar.progress
 * 同步给矢量填充的重画函数。这样：
 * - 旧调用方（头顶血条 RoleDisplay / OtherPlayerManager / MonsterManager、悬停血条等）
 *   继续按 `node.getComponent(ProgressBar).progress = x` 刷进度，一行不用改；
 * - 新调用方（RoleExpBar 等）也可以直接拿 createVectorBar 返回的 setProgress 立即重画。
 */
@ccclass("VectorBarBridge")
@requireComponent(ProgressBar)
export default class VectorBarBridge extends Component {
  /** 矢量填充重画（由 createVectorBar 注入） */
  public setProgress: (p: number) => void = () => undefined;
  /** 上次同步的进度（未变化不重画） */
  private last = -1;

  protected update() {
    const progress = this.getComponent(ProgressBar).progress;
    if (progress === this.last) return;
    this.last = progress;
    this.setProgress(progress);
  }
}
