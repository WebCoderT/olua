import { _decorator, Component, Node } from "cc";
import { AutoUpgrade } from "../activities/AutoUpgrade";
import GameUiHelper from "../helpers/GameUiHelper";
const { ccclass, property } = _decorator;

@ccclass("ActivityController")
export class ActivityController extends Component {
  // 自动升级开关
  autoUpgrade: boolean = true;
  start() {
    if (this.autoUpgrade) {
      GameUiHelper.createTip("泡点活动已开启，尽情享受吧～");
      this.node.addComponent(AutoUpgrade);
    } else {
      console.log("泡点活动未开启，可前往控制器进行开启。");
    }
  }

  update(deltaTime: number) {}
}
