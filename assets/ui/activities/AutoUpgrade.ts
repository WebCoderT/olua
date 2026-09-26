// 自动升级
// 又称泡点
// 开启活动后持续时间获得经验
import { _decorator, Component } from "cc";
import StorageHelper from "../utils/StorageHelper";
const { ccclass } = _decorator;

@ccclass("AutoUpgrade")
export class AutoUpgrade extends Component {
  // 每秒获得多少经验
  exp = 10;
  // 获得经验时间间隔-秒
  stamp = 1;
  // 记时
  time = 0;

  update(deltaTime: number) {
    this.time += deltaTime;
    if (this.time >= this.stamp) {
      // 更新经验数据
      StorageHelper.onlineRoleGetExp(this.exp);
      this.time = 0;
    }
  }
}
