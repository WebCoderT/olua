import { isValid, Node } from "cc";
import { statuses } from "../../configs/game-config";
import { statusEffect } from "../../configs/game-config";
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
 *
 * **数据来源（#822 起）：技能状态以服务端为准**。放技能只发 `cast` 帧，状态由服务端落库后
 * 随 `settle` 回执的 `statuses` 整份下发，这里用 `applyFromServer` 整表重建 ——
 * 客户端不再自己决定「我有没有 buff」（以前本地 `apply` 就亮图标，服务端完全不知道，
 * 护体神盾既没生效也变成了 300% 核弹）。本地 `apply` 只留给没有服务端来源的状态
 * （装备 / VIP 这类，目前还没接）。
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

  /**
   * 按服务端快照整表重建（#822：settle 回执里的 `statuses`）
   *
   * **整表替换而不是增量**：快照里没有的状态就是没了（到期 / 被清）。增量协议漏一条的后果是
   * 图标永远不消失，而整表重建最多错一次、下一帧就纠正。
   *
   * `remainingMs` 是服务端算好的剩余时间，这里按本地当前时刻往后推 —— 客户端与服务端时钟
   * 不共享，只有「还剩多久」是可用的量。代价是每次回执都会把到期时刻往后推一个单程延迟
   * （几十毫秒），换来的是不掉图标、不提前消失。
   *
   * 配置里查不到的状态直接忽略（运营删了状态 / 老客户端拿到新 id）：画不出来，
   * 也不该让图标栏出现一个空图标。
   */
  static applyFromServer(entries: readonly { id: string; remainingMs: number }[]) {
    const now = Date.now();
    const next = new Map<StatusId, number>();
    for (const entry of entries) {
      const statusId = entry.id as StatusId;
      if (!statuses.get(statusId)) continue;
      next.set(statusId, now + Math.max(0, Math.floor(entry.remainingMs)));
    }
    // 先摘掉快照里没有的（remove 会改 expireAt，先取键快照再遍历）
    for (const statusId of Array.from(this.expireAt.keys())) {
      if (!next.has(statusId)) this.remove(statusId);
    }
    // 再摆上快照里的（已存在只改到期时刻，特效与图标不重建）
    for (const [statusId, expire] of next) {
      this.expireAt.set(statusId, expire);
      this.ensureEffect(statusId, statuses.get(statusId)!);
    }
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

  /** 当前进行中的状态编号列表（伤害结算经 collectStatusCombatModifiers 汇总防御修正用） */
  static getActiveIds(): StatusId[] {
    return Array.from(this.expireAt.keys());
  }

  /**
   * 此刻被控制成什么样（#826 第三批）
   *
   * 口径与服务端 `RoleStatusService.controlOf` 逐字一致：`stun` 既禁移动也禁出手，
   * `root` 只禁移动，`silence` 只禁出手 —— 两者各写一份必然有一边漏判。
   *
   * 客户端拿它做**表现层**的双保险（停输入）；权威判据在服务端：眩晕期间上报的 `pos` 帧
   * 会被整帧丢弃（`PlayerPresenceService.movementLocked`），出手会被 `rejected: "stunned"` 拒。
   */
  static controlOf(): { stunned: boolean; rooted: boolean; silenced: boolean } {
    let stunned = false;
    let rooted = false;
    let silenced = false;
    for (const statusId of this.expireAt.keys()) {
      const control = statuses.get(statusId)?.control;
      if (!control) continue;
      if (control.stun) stunned = true;
      if (control.root) rooted = true;
      if (control.silence) silenced = true;
    }
    // stun 包含 root 与 silence 的全部含义
    return { stunned, rooted: rooted || stunned, silenced: silenced || stunned };
  }

  /**
   * 能不能移动（眩晕 / 麻痹 / 定身都不行）
   *
   * 不做 `silence` 的判断：沉默的人照样能走，把它算进来会让「沉默」变成「定身」。
   */
  static isMoveLocked(): boolean {
    return this.controlOf().rooted;
  }

  /** 状态剩余秒数（没有该状态返回 0） */
  static getRemainingSeconds(statusId: StatusId): number {
    const expire = this.expireAt.get(statusId);
    if (expire === undefined) return 0;
    return Math.max(0, (expire - Date.now()) / 1000);
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
      // 护体神盾这类「播完即完整形态」的特效只播一遍停在尾帧；其余循环播放
      if (config.effectHoldLast) AnimationHelper.playOnceHoldWithFrames(node.name, node, frames, statusEffect.frameRate);
      else AnimationHelper.playLoopWithFrames(node.name, node, frames, statusEffect.frameRate);
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
