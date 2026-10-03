import { Node } from "cc";
import { uiImages } from "../../../configs/hudLayout";
import AutoBattle from "../../core/AutoBattle";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 自动挂机开关按钮（自身即按钮，挂在底部栏中段空档）
 * 点击切换 AutoBattle 的挂机状态，图标随状态切换（关闭=收剑 / 开启=举剑，见 uiImages）；
 * 挂机状态由 AutoBattle 回调同步（挂机在别处被关闭时图标也能刷新）
 * 尺寸与位置见 configs/hudLayout.bottomBar.autoFight
 */
export default class AutoFightButton extends Node {
  constructor() {
    super("auto_fight_button");
    // 样式（尺寸/位置/图标底图/「挂机」文字）由 GameUiHelper 零件施加
    GameUiHelper.applyAutoFightButtonStyle(this);
    this.on(Node.EventType.TOUCH_END, this.onToggle, this);
    // 场景销毁时注销状态回调，避免残留对已销毁按钮的引用
    this.once(Node.EventType.NODE_DESTROYED, () => AutoBattle.setHangStateListener(null));
    this.refresh(AutoBattle.isHangEnabled());
    AutoBattle.setHangStateListener((enabled) => this.refresh(enabled));
  }

  /** 点击：切换挂机开关（状态与图标由 AutoBattle 回调统一刷新） */
  private onToggle() {
    AutoBattle.setHangEnabled(!AutoBattle.isHangEnabled());
  }

  /** 按挂机状态切换图标 */
  private refresh(enabled: boolean) {
    GameUiHelper.updateNodeIcon(this, enabled ? uiImages.autoFightOn : uiImages.autoFightOff);
  }
}
