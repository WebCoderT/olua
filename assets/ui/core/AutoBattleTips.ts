import { Animation, isValid, Node } from "cc";
import { hudImages, tipsLayout } from "../../configs/hudLayout";
import type RoleDisplay from "../components/role/RoleDisplay";
import AnimationHelper from "../helpers/AnimationHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import AutoBattle from "./AutoBattle";
import LayerManager from "./LayerManager";

/** 提示动画节点与其动画组件 */
interface TipView {
  node: Node;
  animate: Animation;
}

/**
 * 自动战斗提示（静态控制器）
 * 屏幕中间循环播放的两个图集帧动画提示，互相独立、允许同时出现，均挂在特效层：
 * - 「自动战斗中」（hudImages.autoAttackTip）：自动挂机开启期间一直显示
 * - 「自动寻路中」（hudImages.autoPathTip）：自动战斗走位（A* 寻路移动）期间显示
 * 屏幕中心即相机中心，相机跟随主角，因此把提示节点世界坐标每帧对齐主角世界坐标即可；
 * 两个提示同时显示时寻路提示向下让位（tipsLayout.autoTipPathOffsetY），避免文字重叠
 * 帧率与让位偏移见 configs/hudLayout.tipsLayout，由组合根在 Game.update 每帧调用 update；
 * 场景卸载时 reset 清引用（节点随特效层销毁）
 */
export default class AutoBattleTips {
  /** 自动战斗中提示 */
  private static attackTip: TipView | null = null;
  /** 自动寻路中提示 */
  private static pathTip: TipView | null = null;
  /** 提示动画是否正在异步装载（装载完成前每帧直接跳过，避免重复创建节点） */
  private static preparing = false;

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
    this.preparing = false;
  }

  //#region 内部实现

  /** 确保两个提示节点已创建且动画已装载（首次调用异步装载，期间返回 false） */
  private static ensureTips(): boolean {
    if (this.attackTip && isValid(this.attackTip.node) && this.pathTip && isValid(this.pathTip.node)) return true;
    if (this.preparing) return false;
    this.preparing = true;
    this.attackTip = this.createTip("auto_battle_attack_tip", hudImages.autoAttackTip);
    this.pathTip = this.createTip("auto_battle_path_tip", hudImages.autoPathTip);
    return false;
  }

  /** 创建一个提示节点挂到特效层，并异步装载图集帧后循环播放（装载完成时置 preparing 为 false） */
  private static createTip(name: string, atlasSrc: string): TipView {
    const tip = GameUiHelper.createAutoBattleTip(name);
    LayerManager.addToEffectLayer(tip.node);
    AnimationHelper.loadFramesFromAtlas(atlasSrc).then((frames) => {
      // 场景可能已切换：节点失效就不再装载，reset 已把引用清空
      if (!isValid(tip.node)) return;
      if (frames.length) AnimationHelper.playLoopWithFrames(name, tip.node, frames, tipsLayout.autoTipFrameRate);
      this.preparing = false;
    });
    return tip;
  }

  /** 显隐一个提示（引用无效时静默跳过，下一帧 ensureTips 会重建） */
  private static setTipVisible(tip: TipView | null, visible: boolean) {
    if (tip && isValid(tip.node) && tip.node.active !== visible) tip.node.active = visible;
  }

  //#endregion
}
