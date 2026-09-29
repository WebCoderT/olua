import { SkillContext } from "../types/skill";
import BattleHelper from "../ui/utils/BattleHelper";

/** ‌基础剑术：对单体目标造成一次物理伤害（伤害与物理攻击相关） */
export function skill_1000(context: SkillContext) {
  const { config, level, role, caster, target, monsters } = context;
  if (!target) return;
  // 面向目标播放技能配置的动作动画（config.action）
  caster.playSkillAttack(config.action, BattleHelper.checkSelfDirection(target, caster));
  // 物理伤害结算
  const monster = monsters.getMonsterData(target);
  if (!monster) return;
  const rate = config.damageCoefficients[level - 1].baseTypeRate;
  const damage = BattleHelper.calcSkillDamage(role, monster, "physicalAttack", rate);
  monsters.hurt(target, damage);
}

/** 烈火剑法：对单体目标造成一次强化物理伤害 */
export function skill_1001(context: SkillContext) {
  skill_1000(context);
}
