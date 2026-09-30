import { isValid, Node, Vec2 } from "cc";
import { skills } from "../../configs/skill";
import { SkillContextInput, SkillId, SkillPushConfig, SkillTargetType } from "../../types/skill";
import GameUiHelper from "../helpers/GameUiHelper";
import { canAttackTarget } from "../utils/battle/BattleMath";
import MpHelper from "../utils/battle/MpHelper";
import AutoBattle from "./AutoBattle";
import RoleUIManager from "./RoleUIManager";
import StorageManager from "./StorageManager";

/**
 * 技能管理器
 * 技能触发的统一入口：学习校验 → 冷却校验 → 单体目标补全/距离校验 → 记录冷却 → 调用技能实现（动画与结算由技能实现自行处理）
 * 技能配置了 push 时，单体技能在命中后由本类统一把目标击退（场上唯一能推动怪物的途径）
 * 玩家手动释放（release）时，canAuto 技能没有可打目标/目标超出距离会委托 AutoBattle 自动接战（快速攻击）；
 * 自动战斗出手（releaseAuto）则不再委托，避免互相递归
 * 施法上下文由组合根（Game）通过 setContextProvider 注入（来源为 RoleDisplay，天然持有角色/目标/怪物容器）
 */
export default class SkillManager {
  /** 施法上下文提供者（由组合根注入） */
  private static contextProvider: (() => SkillContextInput) | null = null;
  /** 技能冷却记录（skillId -> 上次释放时间戳，毫秒） */
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
      if (!fromAutoBattle) GameUiHelper.createTip("skill_not_learned_tip", `尚未学习 ${config.label}`);
      return false;
    }
    // 冷却校验
    if (this.inCooldown(skillId)) {
      if (!fromAutoBattle) GameUiHelper.createTip("skill_cooldown_tip", `${config.label} 冷却中`);
      return false;
    }
    // 魔法值校验（每个技能的消耗见配置 mpCost）：不足则本次不释放，手动释放时给出提示
    if (!MpHelper.hasEnough(context.role, config.mpCost)) {
      if (!fromAutoBattle) GameUiHelper.createErrorTip("skill_mp_tip", `魔法值不足（当前 ${context.role.mp}，需要 ${config.mpCost}）`);
      return false;
    }
    // 单体技能：无选中目标时自动选取施法距离内最近的存活怪物
    let target = context.target;
    if (config.targetType === SkillTargetType.SINGLE) {
      if (!target || !isValid(target)) target = context.monsters.getNearestMonster(context.caster.getWorldPosition(), config.distance);
      if (!target) {
        // 可自动释放的技能：交给 AutoBattle 自动选最近的怪物并走位到范围内（快速攻击）
        if (!fromAutoBattle && config.canAuto && AutoBattle.requestSkill(skillId, null)) return true;
        if (!fromAutoBattle) GameUiHelper.createTip("skill_no_target_tip", `${config.label} 无可攻击目标`);
        return false;
      }
      // 距离校验（distance <= 0 表示不限制距离）：超出时同样交给 AutoBattle 走位接近
      if (config.distance > 0 && !canAttackTarget(target, context.caster, config.distance)) {
        if (!fromAutoBattle && config.canAuto && AutoBattle.requestSkill(skillId, target)) return true;
        if (!fromAutoBattle) GameUiHelper.createErrorTip("skill_distance_tip", "距离太远，无法攻击！");
        return false;
      }
    }
    // 记录冷却，扣除魔法值（扣完落盘，角色数据在存储层是反序列化对象，不落盘下次读取会回滚），
    // 显示技能释放提示（位置在释放者，挂特效层），调用技能实现
    this.cooldowns.set(skillId, Date.now());
    if (config.mpCost > 0 && MpHelper.spend(context.role, config.mpCost)) {
      StorageManager.updateOnlineRole(context.role);
      RoleUIManager.updateRoleData(context.role);
    }
    GameUiHelper.showSkillTip(context.caster, config.label);
    config.onClick({ ...context, target, config, level });
    // 技能击退：配置了 push 的单体技能把目标推开（方向 = 施法者指向目标）
    if (config.push && target && isValid(target)) this.pushTarget(context, target, config.push);
    return true;
  }

  /** 按技能配置击退单体目标（方向 = 施法者 → 目标；两者完全重叠时取不到方向，不作位移） */
  private static pushTarget(context: SkillContextInput, target: Node, push: SkillPushConfig) {
    const casterPosition = context.caster.getWorldPosition();
    const targetPosition = target.getWorldPosition();
    const direction = new Vec2(targetPosition.x - casterPosition.x, targetPosition.y - casterPosition.y);
    context.monsters.push(target, direction, push.distance, push.duration);
  }

  /** 技能实际冷却时间（秒）：技能配置冷却 / 角色对应动作的速度倍率（倍率 <= 0 视为 1，即不加速） */
  private static getEffectiveCooldown(skillId: SkillId): number {
    const config = skills.get(skillId);
    if (!config) return 0;
    const rate = StorageManager.findOnlineRole()?.speedRate[config.action] ?? 1;
    return config.cooldown / (rate > 0 ? rate : 1);
  }

  /** 技能是否处于冷却 */
  static inCooldown(skillId: SkillId): boolean {
    const last = this.cooldowns.get(skillId);
    return last !== undefined && Date.now() - last < this.getEffectiveCooldown(skillId) * 1000;
  }

  /** 获取技能冷却剩余秒数（未冷却返回 0），按实际冷却（含速度倍率折算）计算，供 UI 显示倒计时 */
  static getCooldownRemaining(skillId: SkillId): number {
    const last = this.cooldowns.get(skillId);
    if (last === undefined) return 0;
    return Math.max(0, this.getEffectiveCooldown(skillId) - (Date.now() - last) / 1000);
  }
}
