import { isValid, Node } from "cc";
import { skillStatusMap, statuses } from "../../configs/status";
import { statusEffect } from "../../configs/effect";
import { StatusBadge, StatusConfig, StatusId } from "../../types/status";
import AnimationHelper from "../helpers/AnimationHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import RoleUIManager from "./RoleUIManager";

/**
 * 状态管理器（静态类）
 * 状态 = 角色身上的一段持续效果，来源不限（技能/装备/VIP 等增值属性），添加入口统一是 apply：
 * - 同一状态重复获得时只刷新持续时间（到期时间 = 获得时刻 + 配置的 duration），不叠加层数
 * - 到期由 tick 自动移除（移除时同步销毁身上特效、刷新图标栏）
 * - 身上特效：配置了 effect 的状态在特效层挂一个循环播放的图集帧动画节点，
 *   每帧跟随角色（挂点偏移统一见 configs/effect 的 statusEffect.offset）
 * - 图标：头像下方的状态图标条（见 ui/components/hud/StatusIconBar，经 RoleUIManager 刷新）
 * 技能获得的状态由 configs/status 的 skillStatusMap 映射，技能实现释放成功后调用 applyStatusOfSkill；
 * 装备/VIP 等来源直接 apply 对应状态编号即可
 */
export default class StatusManager {
  /** 进行中的状态（状态编号 -> 到期时间戳，毫秒） */
  private static expireAt = new Map<StatusId, number>();
  /** 状态身上特效节点（状态编号 -> 特效节点，随状态添加/移除） */
  private static effectNodes = new Map<StatusId, Node>();
  /** 状态归属的角色节点（由组合根注入，特效跟随它移动） */
  private static owner: Node | null = null;

  /** 注入状态归属的角色节点（组合根在创建主角后调用） */
  static setOwner(node: Node | null) {
    this.owner = node;
  }

  /**
   * 添加或刷新一个状态
   * 已存在时只刷新持续时间（从现在起重新计时），特效与图标保持不变
   */
  static apply(statusId: StatusId) {
    const config = statuses.get(statusId);
    if (!config) {
      console.error(`状态 ${statusId} 未在 configs/status 注册`);
      return;
    }
    this.expireAt.set(statusId, Date.now() + config.duration * 1000);
    this.ensureEffect(statusId, config);
    this.refreshIconBar();
  }

  /** 立即移除一个状态（销毁身上特效并刷新图标栏） */
  static remove(statusId: StatusId) {
    if (!this.expireAt.has(statusId)) return;
    this.expireAt.delete(statusId);
    this.destroyEffect(statusId);
    this.refreshIconBar();
  }

  /** 角色是否拥有某状态（后续的减伤/属性加成结算用它查询） */
  static has(statusId: StatusId): boolean {
    return this.expireAt.has(statusId);
  }

  /** 状态剩余秒数（没有该状态返回 0） */
  static getRemainingSeconds(statusId: StatusId): number {
    const expire = this.expireAt.get(statusId);
    if (expire === undefined) return 0;
    return Math.max(0, (expire - Date.now()) / 1000);
  }

  /** 释放技能后按 configs/status 的 skillStatusMap 添加对应状态（非状态型技能查不到映射，静默跳过） */
  static applyStatusOfSkill(skillId: string) {
    const statusId = skillStatusMap[skillId as keyof typeof skillStatusMap];
    if (statusId) this.apply(statusId);
  }

  /** 每帧驱动（组合根 update 调用）：到期移除 + 身上特效跟随角色 */
  static tick() {
    if (this.expireAt.size) {
      const now = Date.now();
      for (const [statusId, expire] of this.expireAt) {
        if (now >= expire) this.remove(statusId);
      }
    }
    // 特效跟随角色移动（特效节点在特效层，不能直接挂在角色节点下）
    if (this.owner && isValid(this.owner) && this.effectNodes.size) {
      const position = this.owner.getWorldPosition();
      for (const node of this.effectNodes.values()) {
        if (isValid(node)) node.setWorldPosition(position.x + statusEffect.offset.x, position.y + statusEffect.offset.y, position.z);
      }
    }
  }

  /** 当前进行中的状态徽标列表（图标栏刷新的数据来源，按获得顺序排列） */
  static getBadges(): StatusBadge[] {
    const badges: StatusBadge[] = [];
    for (const [statusId] of this.expireAt) {
      const config = statuses.get(statusId);
      if (config) badges.push({ id: statusId, label: config.label, icon: config.icon });
    }
    return badges;
  }

  /** 场景卸载（组合根 onDestroy 调用）：清空全部状态与特效节点（状态不跨场景保留） */
  static reset() {
    for (const statusId of this.expireAt.keys()) this.destroyEffect(statusId);
    this.expireAt.clear();
    this.owner = null;
  }

  /** 确保身上特效节点存在（重复获得刷新时特效已在播，直接复用） */
  private static ensureEffect(statusId: StatusId, config: StatusConfig) {
    if (!config.effect || this.effectNodes.has(statusId)) return;
    const node = GameUiHelper.createSkillEffect(`status_effect_${statusId}`);
    LayerManager.addToEffectLayer(node);
    this.effectNodes.set(statusId, node);
    // 先摆到角色当前位置，加载完成前不至于出现在原点
    this.followOwner(node);
    AnimationHelper.loadFramesFromAtlas(config.effect).then((frames) => {
      // 场景可能已切换/状态可能已被移除：节点失效就不再装载
      if (!isValid(node) || this.effectNodes.get(statusId) !== node) {
        if (isValid(node)) node.destroy();
        return;
      }
      if (!frames.length) {
        node.destroy();
        return;
      }
      AnimationHelper.playLoopWithFrames(node.name, node, frames, statusEffect.frameRate);
    });
  }

  /** 销毁状态身上特效 */
  private static destroyEffect(statusId: StatusId) {
    const node = this.effectNodes.get(statusId);
    this.effectNodes.delete(statusId);
    if (node && isValid(node)) node.destroy();
  }

  /** 让单个特效节点跟随到角色当前位置（挂点偏移见 configs/effect 的 statusEffect.offset） */
  private static followOwner(node: Node) {
    if (!this.owner || !isValid(this.owner) || !isValid(node)) return;
    const position = this.owner.getWorldPosition();
    node.setWorldPosition(position.x + statusEffect.offset.x, position.y + statusEffect.offset.y, position.z);
  }

  /** 状态增删后刷新头像下方的图标栏 */
  private static refreshIconBar() {
    RoleUIManager.updateStatuses(this.getBadges());
  }
}
