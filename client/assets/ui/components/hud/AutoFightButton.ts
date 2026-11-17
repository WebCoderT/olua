import { Color, Label, Node } from "cc";
import { bottomBarLayout, T } from "../../../configs/hudLayout";
import AutoBattle from "../../core/AutoBattle";
import SoundManager from "../../core/SoundManager";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 自动挂机开关按钮（自身即按钮，战斗列顶行的细长横条，见 hudLayout.bottomBar.autoFight）
 * 点击切换 AutoBattle 的挂机状态；外观随状态切换：底板边框与图标/文字颜色开 = 金、关 = 灰
 * 挂机状态由 AutoBattle 回调同步（挂机在别处被关闭时外观也能刷新）
 */
export default class AutoFightButton extends Node {
  /** 外观零件（底板 / 文字 / 图标换色，由样式工厂返回） */
  private parts: { plate: Node; label: Label; setIconColor: (color: Color) => void };

  constructor() {
    super("auto_fight_button");
    // 样式（尺寸/位置/底板/「挂机」文字）由 GameUiHelper 零件施加
    this.parts = GameUiHelper.applyAutoFightButtonStyle(this);
    this.on(Node.EventType.TOUCH_END, this.onToggle, this);
    // 点击音（#685）：挂机开关也是按钮
    SoundManager.bindClick(this);
    // 场景销毁时注销状态回调，避免残留对已销毁按钮的引用
    this.once(Node.EventType.NODE_DESTROYED, () => AutoBattle.setHangStateListener(null));
    this.refresh(AutoBattle.isHangEnabled());
    AutoBattle.setHangStateListener((enabled) => this.refresh(enabled));
  }

  /** 点击：切换挂机开关（状态与外观由 AutoBattle 回调统一刷新） */
  private onToggle() {
    AutoBattle.setHangEnabled(!AutoBattle.isHangEnabled());
  }

  /** 按挂机状态切换外观：底板边框与图标/文字颜色开 = 金、关 = 灰 */
  private refresh(enabled: boolean) {
    const skin = bottomBarLayout.autoFight;
    GameUiHelper.restyleGlassPlate(this.parts.plate, skin.size, T.radius.r2, enabled ? skin.onBorder : T.line[2]);
    this.parts.label.color = enabled ? skin.onColor : T.text[2];
    this.parts.setIconColor(enabled ? skin.onColor : T.text[2]);
  }
}
