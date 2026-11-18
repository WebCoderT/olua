import { isValid } from "cc";
import { skills } from "../../configs/skill";
import { SkillContextInput, SkillId, SkillTargetType } from "../../types/skill";
import GameUiHelper from "../helpers/GameUiHelper";
import { canAttackTarget } from "../utils/battle/BattleMath";
import MpHelper from "../utils/battle/MpHelper";
import ServerClock from "../utils/net/ServerClock";
import AutoBattle from "./AutoBattle";
import EffectManager from "./EffectManager";
import StorageManager from "./StorageManager";

/**
 * 技能管理器
 * 技能触发的统一入口：学习校验 → 冷却校验 → 单体目标补全/距离校验 → 记录冷却 → 调用技能实现（动画与结算由技能实现自行处理）
 * 玩家手动释放（release）时，canAuto 技能没有可打目标/目标超出距离会委托 AutoBattle 自动接战（快速攻击）；
 * 自动战斗出手（releaseAuto）则不再委托，避免互相递归
 * 施法上下文由组合根（Game）通过 setContextProvider 注入（来源为 RoleDisplay，天然持有角色/目标/怪物容器）
 *
 * 客户端**不做**任何位移与伤害：怪物的位置归服务端 AI（#670），伤害归服务端结算（#34/#541）。
 * 技能击退（`push_distance`）也由服务端模拟：结算侧算出伤害后让怪物 AI 位移并广播，
 * 客户端只按广播的位置趋近 —— 本地推一下只在本机生效，同图其他人看到的怪还在原地。
 */
export default class SkillManager {
  /** 施法上下文提供者（由组合根注入） */
  private static contextProvider: (() => SkillContextInput) | null = null;
  /**
   * 技能冷却表（skillId -> 就绪时刻，本地毫秒轴）
   *
   * **只写服务端给来的值**（#1137 批次 2）：settle-ok 的 `cooldownUntilMs`（ServerClock
   * 换算本地轴）、roleUpdate 快照的 `cooldowns` 表、冷却拒绝帧的 `remainMs`。
   * 本地不再 `Date.now()` 起钟 —— 本地钟与服务端 lastCastAt 漂移正是 #1133 蓝量弹回的推手；
   * 放了技能、settle-ok 还没回来的空窗里表是空的，连点会多出几发注定被服务端冷却闸拒掉的
   * cast 帧，被拒帧会立刻把表对齐（表现上只是多一两条 warn 日志，不会重复出效果）。
   */
  private static cooldowns = new Map<SkillId, number>();

  /** 注入施法上下文提供者 */
  static setContextProvider(provider: () => SkillContextInput) {
    this.contextProvider = provider;
  }

  /**
   * 释放技能（玩家手动触发的统一入口：快捷键/技能图标）
   * canAuto 技能没有可打目标或目标超出施法距离时，委托 AutoBattle 自动选取最近怪物并走位到范围后再出手
   */
  static release(skillId: SkillId): boolean {
    return this.tryCast(skillId, false);
  }

  /** 释放技能（自动战斗出手专用：AutoBattle 已保证目标与距离，静默失败且不再触发自动接近） */
  static releaseAuto(skillId: SkillId): boolean {
    return this.tryCast(skillId, true);
  }

  /** 取第一个已学习且可自动释放（canAuto）的技能（自动挂机的默认出手技能，按配置顺序取最靠前的） */
  static findAutoSkill(): SkillId | null {
    const role = StorageManager.findOnlineRole();
    if (!role) return null;
    let found: SkillId | null = null;
    skills.forEach((config, skillId) => {
      if (found || !config.canAuto || !role.skills[skillId]) return;
      found = skillId;
    });
    return found;
  }

  /**
   * 尝试释放一次技能
   * @param skillId 技能编号
   * @param fromAutoBattle 是否来自自动战斗（AutoBattle 调用）：失败不弹提示，也不会再委托自动接战
   */
  private static tryCast(skillId: SkillId, fromAutoBattle: boolean): boolean {
    const context = this.contextProvider?.();
    const config = skills.get(skillId);
    if (!context || !config) return false;
    // 攻击/技能锁：正在攻击（动画未播放完成）时按下不产生任何反应
    if (context.caster.isAttacking()) return false;
    // 未学习不可释放
    const level = context.role.skills[skillId];
    if (!level) {
      if (!fromAutoBattle) GameUiHelper.createTip("skill_not_learned_tip", { skill: config.label });
      return false;
    }
    // 冷却校验
    if (this.inCooldown(skillId)) {
      if (!fromAutoBattle) GameUiHelper.createTip("skill_cooldown_tip", { skill: config.label });
      return false;
    }
    // 魔法值校验（每个技能的消耗见配置 mpCost）：不足则本次不释放，手动释放时给出提示
    if (!MpHelper.hasEnough(context.role, config.mpCost)) {
      if (!fromAutoBattle) GameUiHelper.createErrorTip("skill_mp_tip", { mp: context.role.mp, cost: config.mpCost });
      return false;
    }
    // 单体技能：无选中目标时自动选取施法距离内最近的存活怪物
    // requireTarget === false（#367，自身 / 状态型技能）时不找目标也不校验距离 ——
    // 没有敌人在场也该能给自己上盾，否则玩家得先拉到怪才能加 buff
    let target = context.target;
    if (config.targetType === SkillTargetType.SINGLE && config.requireTarget !== false) {
      if (!target || !isValid(target)) target = context.monsters.getNearestMonster(context.caster.getWorldPosition(), config.distance);
      if (!target) {
        // 可自动释放的技能：交给 AutoBattle 自动选最近的怪物并走位到范围内（快速攻击）
        if (!fromAutoBattle && config.canAuto && AutoBattle.requestSkill(skillId, null)) return true;
        if (!fromAutoBattle) GameUiHelper.createTip("skill_no_target_tip", { skill: config.label });
        return false;
      }
      // 距离校验（distance <= 0 表示不限制距离）：超出时同样交给 AutoBattle 走位接近
      if (config.distance > 0 && !canAttackTarget(target, context.caster, config.distance)) {
        if (!fromAutoBattle && config.canAuto && AutoBattle.requestSkill(skillId, target)) return true;
        if (!fromAutoBattle) GameUiHelper.createErrorTip("skill_distance_tip");
        return false;
      }
    }
    // 冷却表只写服务端给来的值（#1137 批次 2）：settle-ok 带回权威 cooldownUntilMs，
    // 被拒帧按 remainMs 对齐 —— 本地不预起钟。蓝量同样在服务端（#1133）：耗蓝由 cast 帧的
    // 服务端施法闸（#813 spendCastMp）扣，权威值经 roleUpdate 帧回传刷蓝条。
    // 上面的 hasEnough 只是快捷预判（省一次注定失败的出手），判准以服务端为准。
    GameUiHelper.showSkillTip(context.caster, config.label);
    // 技能特效（配置的 effect / effectIsOnSelf）：与动作动画同时开始播放，见 core/EffectManager
    // 区域（PLACE）技能例外：特效位置由技能实现决定（如十步一杀播在突进落点），不在施法起点代播
    if (config.targetType !== SkillTargetType.PLACE) EffectManager.play(config, context.caster, target, context.role);
    config.onClick({ ...context, target, config, level });
    return true;
  }

  /** 技能是否处于冷却（表里只有服务端给来的就绪时刻，本地不写） */
  static inCooldown(skillId: SkillId): boolean {
    const readyAt = this.cooldowns.get(skillId);
    return readyAt !== undefined && Date.now() < readyAt;
  }

  /** 获取技能冷却剩余秒数（未冷却返回 0），供 UI 显示倒计时 */
  static getCooldownRemaining(skillId: SkillId): number {
    const readyAt = this.cooldowns.get(skillId);
    if (readyAt === undefined) return 0;
    return Math.max(0, (readyAt - Date.now()) / 1000);
  }

  /**
   * 服务端放行帧带回的权威冷却结束时刻写进冷却表（#1137 批次 2）
   *
   * `cooldownUntilMs` 是**服务端毫秒轴**的绝对时刻，换算本地轴要减去时钟偏差
   * （`ServerClock.skew` = 服务端此刻 − 本地此刻；未校准时偏差为 0，两端都是 epoch 毫秒，
   * 只差系统钟的几秒，冷却显示影响有限）。这是冷却显示的**主入口**：每次成功出手都走这里。
   * @param skillId 技能编号（settle-ok 帧的 castId 经 CombatChannel 对账回成 skillId）
   * @param cooldownUntilMs 服务端记的冷却结束时刻（<=0 / 无冷却时缺省，不写表）
   */
  static noteServerCooldown(skillId: SkillId, cooldownUntilMs?: number): void {
    if (!skills.has(skillId) || !(cooldownUntilMs && cooldownUntilMs > 0)) return;
    this.cooldowns.set(skillId, cooldownUntilMs - ServerClock.skew);
  }

  /**
   * roleUpdate 快照的冷却表整表对齐（#1137 批次 2）
   *
   * 表是**全量语义**：服务端只在仍有冷却时带（空表不带），不在表里的技能 =
   * 服务端判定已就绪 —— 本地残留的倒计时（重连前放的技能）要清掉，否则会
   * 「服务端早就转好了、本地还锁着」。进图 / 重连后靠这一帧拿到完整冷却状态。
   * @param cooldowns skillId → 剩余毫秒（帧不带 / 形状不对时整个跳过，不动本地表）
   */
  static applyServerCooldowns(cooldowns: Record<string, number> | undefined): void {
    if (!cooldowns || typeof cooldowns !== "object") return;
    const now = Date.now();
    for (const key of Array.from(this.cooldowns.keys())) {
      if (!(key in cooldowns)) this.cooldowns.delete(key);
    }
    for (const rawId of Object.keys(cooldowns)) {
      const skillId = rawId as SkillId;
      const remainMs = cooldowns[rawId];
      if (!skills.has(skillId) || !(remainMs > 0)) continue;
      this.cooldowns.set(skillId, now + remainMs);
    }
  }

  /**
   * 按服务端的权威剩余冷却对齐本地冷却表（#1133 引入；#1137 起语义 = 直接写服务端值）
   *
   * 冷却拒绝帧带权威的 `remainMs`：写回本地表，下一发就不会再撞。它与
   * `noteServerCooldown`（settle-ok）是冷却表仅有的两条写路径之外的一条——
   * 都来自服务端帧，本地依旧不自行起钟。
   * @param skillId 技能编号（settle 拒绝帧的 castId 经 CombatChannel 对账回成 skillId）
   * @param remainMs 服务端判的剩余冷却毫秒（<=0 不动）
   */
  static alignCooldown(skillId: SkillId, remainMs: number): void {
    if (!skills.has(skillId) || !(remainMs > 0)) return;
    this.cooldowns.set(skillId, Date.now() + Math.ceil(remainMs));
  }
}

// #1115 批次 6 破环：StorageManager 换快捷键时要触发技能释放，但不 import 本模块（否则
// SkillManager → StorageManager → SkillManager 成环）。模块加载时注入回调 —— SkillManager
// 被 Game.ts 引入，注册必然发生；回调包一层箭头函数保住 this。
StorageManager.setShortcutReleaseHandler((skillId) => SkillManager.release(skillId));
