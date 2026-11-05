import { _decorator, Component } from "cc";
import { soakExpPerTick } from "../../configs/game-config";
import GameUiHelper from "../helpers/GameUiHelper";
const { ccclass } = _decorator;

/**
 * 泡点活动（#722：服务端 tick 发经验，本组件只负责「进图报个喜」）
 *
 * 经验由服务端定时入账（`server/src/modules/realtime/soak-point.service.ts`，
 * 速率与开关都在管理端「成长参数」页），客户端从 roleUpdate 帧看到经验与等级变化
 * —— **没有任何本地加经验的路径**（#550 的纪律不破）。
 *
 * 这里的全部职责：进图时活动是开启的（快照 `growthScalars.soakExpPerTick > 0`）
 * 就飘一条「泡点活动已开启」；关闭（出厂默认）时什么都不做。
 *
 * `autoUpgrade` 字段保留：场景里已经序列化了它，删字段会在编辑器里显示 missing；
 * 它现在没有任何行为（原「本地自动升级」已随 #550 删除，不会回来）。
 */
@ccclass("ActivityController")
export class ActivityController extends Component {
  // 原「自动升级」开关（#550 起无行为；字段保留是给场景序列化留位置）
  autoUpgrade: boolean = false;

  start() {
    if (soakExpPerTick <= 0) return;
    GameUiHelper.createTip("activity_started_tip");
  }
}
