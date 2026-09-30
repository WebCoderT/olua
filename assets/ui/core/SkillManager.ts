import { isValid, Node, Vec2 } from "cc";
import { skills } from "../../configs/skill";
import { SkillContextInput, SkillId, SkillPushConfig, SkillTargetType } from "../../types/skill";
import GameUiHelper from "../helpers/GameUiHelper";
import { canAttackTarget } from "../utils/battle/BattleMath";
import StorageManager from "./StorageManager";

/**
 * 技能管理器
 * 技能触发的统一入口：学习校验 → 冷却校验 → 单体目标补全/距离校验 → 记录冷却 → 调用技能实现（动画与结算由技能实现自行处理）
 * 技能配置了 push 时，单体技能在命中后由本类统一把目标击退（场上唯一能推动怪物的途径）
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

  /** 释放技能（快捷键/点击图标统一入口），返回是否进入释放流程 */
  static release(skillId: SkillId): boolean {
    const context = this.contextProvider?.();
    const config = skills.get(skillId);
    if (!context || !config) return false;
    // 攻击/技能锁：正在攻击（动画未播放完成）时按下不产生任何反应
    if (context.caster.isAttacking()) return false;
    // 未学习不可释放
    const level = context.role.skills[skillId];
    if (!level) {
      GameUiHelper.createTip("skill_not_learned_tip", `尚未学习 ${config.label}`);
      return false;
    }
    // 冷却校验
    if (this.inCooldown(skillId)) {
      GameUiHelper.createTip("skill_cooldown_tip", `${config.label} 冷却中`);
      return false;
    }
    // 单体技能：无选中目标时自动选取施法距离内最近的存活怪物
    let target = context.target;
    if (config.targetType === SkillTargetType.SINGLE) {
      if (!target || !isValid(target)) target = context.monsters.getNearestMonster(context.caster.getWorldPosition(), config.distance);
      if (!target) {
        GameUiHelper.createTip("skill_no_target_tip", `${config.label} 无可攻击目标`);
        return false;
      }
      // 距离校验（distance <= 0 表示不限制距离）
      if (config.distance > 0 && !canAttackTarget(target, context.caster, config.distance)) {
        GameUiHelper.createErrorTip("skill_distance_tip", "距离太远，无法攻击！");
        return false;
      }
    }
    // 记录冷却，显示技能释放提示（位置在释放者，挂特效层），调用技能实现
    this.cooldowns.set(skillId, Date.now());
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
