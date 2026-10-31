import { _decorator, Component } from "cc";
import { AutoUpgrade } from "./AutoUpgrade";
import GameUiHelper from "../helpers/GameUiHelper";
const { ccclass } = _decorator;

/**
 * 泡点活动开关（挂在场景里的组件：勾上 autoUpgrade 即挂载自动升级）
 *
 * 没开时不打印任何东西 —— 这是**常态**（活动未开放）。以前每次进图都往控制台写一条
 * 「泡点活动未开启」的 warning，玩家一进游戏就看到一行红字，会误当成报错。
 */
@ccclass("ActivityController")
export class ActivityController extends Component {
  // 自动升级开关
  autoUpgrade: boolean = false;

  start() {
    if (!this.autoUpgrade) return;
    GameUiHelper.createTip("activity_started_tip");
    this.node.addComponent(AutoUpgrade);
  }
}
