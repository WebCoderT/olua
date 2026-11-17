import { isValid, Node } from "cc";
import { T, tipsLayout } from "../../configs/hudLayout";
import { getText } from "../../configs/texts";
import type RoleDisplay from "../components/role/RoleDisplay";
import GameUiHelper from "../helpers/GameUiHelper";
import AutoBattle from "./AutoBattle";
import LayerManager from "./LayerManager";

/** 提示节点视图 */
interface TipView {
  node: Node;
}

/**
 * 自动战斗提示（静态控制器）
 * 跟随主角的两个矢量胶囊提示，互相独立、允许同时出现，均挂在特效层：
 * - 「自动战斗中」（金）：自动挂机开启期间一直显示
 * - 「自动寻路中」（灰）：自动战斗走位（A* 寻路移动）期间显示
 * 屏幕中心即相机中心，相机跟随主角，因此把提示节点世界坐标每帧对齐主角世界坐标即可；
 * 两个提示同时显示时寻路提示向下让位（tipsLayout.autoTipPathOffsetY），避免重叠。
 * 让位偏移见 configs/hudLayout.tipsLayout，由组合根在 Game.update 每帧调用 update；
 * 场景卸载时 reset 清引用（节点随特效层销毁）
 */
export default class AutoBattleTips {
  /** 自动战斗中提示 */
  private static attackTip: TipView | null = null;
  /** 自动寻路中提示 */
  private static pathTip: TipView | null = null;

  /** 每帧驱动（组合根调用）：按挂机开关与自动走位状态显隐并定位提示 */
  static update(roleDisplay: RoleDisplay | null) {
    const hangEnabled = AutoBattle.isHangEnabled();
    const pathing = !!roleDisplay && isValid(roleDisplay) && roleDisplay.isAutoMoving();
    if (!hangEnabled && !pathing) {
      this.setTipVisible(this.attackTip, false);
      this.setTipVisible(this.pathTip, false);
      return;
    }
    if (!roleDisplay || !isValid(roleDisplay) || !this.ensureTips()) return;
    const position = roleDisplay.getWorldPosition();
    // 自动战斗中：屏幕正中
    this.setTipVisible(this.attackTip, hangEnabled);
    if (hangEnabled) this.attackTip!.node.setWorldPosition(position.x, position.y, 0);
    // 自动寻路中：与战斗提示同显时向下让位，单独显示时也在屏幕正中
    this.setTipVisible(this.pathTip, pathing);
    if (pathing) {
      const offsetY = hangEnabled ? tipsLayout.autoTipPathOffsetY : 0;
      this.pathTip!.node.setWorldPosition(position.x, position.y + offsetY, 0);
    }
  }

  /** 场景卸载（组合根 onDestroy 调用）：提示节点随特效层销毁，这里只清引用 */
  static reset() {
    this.attackTip = null;
    this.pathTip = null;
  }

  /** 确保两个提示节点已创建（矢量节点同步建，无需异步装载） */
  private static ensureTips(): boolean {
    if (this.attackTip && isValid(this.attackTip.node) && this.pathTip && isValid(this.pathTip.node)) return true;
    if ((this.attackTip && !isValid(this.attackTip.node)) || (this.pathTip && !isValid(this.pathTip.node))) {
      this.attackTip = null;
      this.pathTip = null;
    }
    // 战斗 = 金（挂机的主动状态）；寻路 = 灰（战斗的伴随状态，弱一档）
    this.attackTip = { node: GameUiHelper.createAutoBattleTip("auto_battle_attack_tip", getText("auto_battle_status_attack"), T.gold[3]) };
    this.pathTip = { node: GameUiHelper.createAutoBattleTip("auto_battle_path_tip", getText("auto_battle_status_path"), T.text[2]) };
    LayerManager.addToEffectLayer(this.attackTip.node);
    LayerManager.addToEffectLayer(this.pathTip.node);
    return true;
  }

  /** 显隐一个提示（引用无效时静默跳过，下一帧 ensureTips 会重建） */
  private static setTipVisible(tip: TipView | null, visible: boolean) {
    if (tip && isValid(tip.node) && tip.node.active !== visible) tip.node.active = visible;
  }
}
