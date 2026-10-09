import { _decorator, Component } from "cc";
import { AutoUpgrade } from "./AutoUpgrade";
import GameUiHelper from "../helpers/GameUiHelper";
const { ccclass } = _decorator;

@ccclass("ActivityController")
export class ActivityController extends Component {
  // 自动升级开关
  autoUpgrade: boolean = false;
  start() {
    if (this.autoUpgrade) {
      GameUiHelper.createTip("activity_started_tip");
      this.node.addComponent(AutoUpgrade);
    } else {
      console.warn("泡点活动未开启，可前往控制器进行开启。");
    }
  }

  update(deltaTime: number) {}
}
