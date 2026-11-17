import { isValid, Node } from "cc";
import { T } from "../../configs/hudLayout";
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
 * 跟随主角的两个矢量胶囊提示，挂在特效层；**互斥，不允许同显**（2026-11-18 用户拍板），
 * 自动寻路优先级更高：
 * - 「自动战斗中」（金）：自动挂机开启且**不在**自动寻路期间显示
 * - 「自动寻路中」（灰）：自动寻路（A* 移动）期间显示，此时战斗提示让位
 * 屏幕中心即相机中心，相机跟随主角，因此把提示节点世界坐标每帧对齐主角世界坐标即可；
 * 由组合根在 Game.update 每帧调用 update；
 * 场景卸载时 reset 清引用（节点随特效层销毁）
 */
export default class AutoBattleTips {
  /** 自动战斗中提示 */
  private static attackTip: TipView | null = null;
  /** 自动寻路中提示 */
  private static pathTip: TipView | null = null;

  /** 每帧驱动（组合根调用）：按挂机开关与自动走位状态显隐并定位提示（互斥，寻路优先） */
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
    // 互斥：寻路期间只显示「自动寻路中」（优先级高），其余时间挂机开着才显示「自动战斗中」
    this.setTipVisible(this.attackTip, hangEnabled && !pathing);
    this.setTipVisible(this.pathTip, pathing);
    const tip = pathing ? this.pathTip : this.attackTip;
    tip?.node.setWorldPosition(position.x, position.y, 0);
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
