import { _decorator, Component } from "cc";
const { ccclass } = _decorator;

/**
 * 泡点活动开关（挂在场景里的组件：勾上 autoUpgrade 即开启自动升级）
 *
 * ⚠️ **#550 起这个活动是下线的**，`autoUpgrade` 勾上也不会有经验。
 *
 * 为什么下线：经验改成**服务端独占**（`role-authority.ts` 的 `level` / `exp`），
 * 客户端每秒自己加一份，推上去会被回填成库里的值 —— 也就是「开了但经验不涨」，
 * 这种「静默不生效」比明说没开放难查得多。原来那个 `AutoUpgrade` 组件已删除。
 *
 * 要恢复这个玩法，方向是**服务端 tick**：客户端只发一个「我在泡点」的开关，
 * 服务端按配置的速率加经验、判升级、推 `roleUpdate`。不要在客户端自己加经验 ——
 * 那条路已经被权威回填堵死（`tools/audit-role-authority.cjs` 会当场报红）。
 *
 * 字段与组件都保留：场景里已经序列化了 `autoUpgrade`，删字段会在编辑器里显示 missing。
 */
@ccclass("ActivityController")
export class ActivityController extends Component {
  // 自动升级开关（当前无效，见文件头）
  autoUpgrade: boolean = false;

  start() {
    if (!this.autoUpgrade) return;
    // 让改配置的人看见，而不是让玩家以为「活动开了却没反应」
    console.warn("[activity] 泡点活动已下线：经验只由服务端结算（#550）。要恢复请改成服务端 tick。");
  }
}
