import { isValid } from "cc";
import { skills } from "../../configs/skill";
import { SkillContextInput, SkillId, SkillTargetType } from "../../types/skill";
import GameUiHelper from "../helpers/GameUiHelper";
import BattleHelper from "../utils/BattleHelper";

/**
 * 技能管理器
 * 技能触发的统一入口：学习校验 → 冷却校验 → 单体目标补全/距离校验 → 记录冷却 → 调用技能实现（动画与结算由技能实现自行处理）
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
    if (this.inCooldown(skillId, config.cooldown)) {
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
      if (config.distance > 0 && !BattleHelper.checkTargetCanAttack(target, context.caster, config.distance)) {
        GameUiHelper.createErrorTip("skill_distance_tip", "距离太远，无法攻击！");
        return false;
      }
    }
    // 记录冷却并调用技能实现
    this.cooldowns.set(skillId, Date.now());
    config.onClick({ ...context, target, config, level });
    return true;
  }

  /** 技能是否处于冷却 */
  static inCooldown(skillId: SkillId, cooldown: number): boolean {
    const last = this.cooldowns.get(skillId);
    return last !== undefined && Date.now() - last < cooldown * 1000;
  }

  /** 获取技能冷却剩余秒数（未冷却/未配置返回 0），供 UI 显示倒计时 */
  static getCooldownRemaining(skillId: SkillId): number {
    const config = skills.get(skillId);
    const last = this.cooldowns.get(skillId);
    if (!config || last === undefined) return 0;
    return Math.max(0, config.cooldown - (Date.now() - last) / 1000);
  }
}
