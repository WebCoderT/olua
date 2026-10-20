import { SkillConfig, SkillContext, SkillId } from "../types/skill";
import { skill_1000, skill_1001, skill_1008, skill_1010 } from "../skills/warrior";
import { skillData } from "./skill-data";

// 数值数据与文案表原样再导出（消费方照旧 from "../configs/skill"，零改动；#31 只拆文件不动接口）
export { basicAttackSkillId, oeccupationSkills, skillTargetTypeLabels, skillTypeLabels } from "./skill-data";

/**
 * 技能释放实现（id → 实现函数）
 * Record<SkillId, ...> 让 tsc 强制 12 个 id 齐全：新增技能漏接实现 = 编译不过，不会静默跑到 undefined
 */
const skillHandlers: Record<SkillId, (context: SkillContext) => void> = {
  "1000": skill_1000,
  "1001": skill_1001,
  "1002": skill_1000,
  "1003": skill_1000,
  "1004": skill_1000,
  "1005": skill_1000,
  "1006": skill_1000,
  "1007": skill_1000,
  "1008": skill_1008,
  "1009": skill_1000,
  "1010": skill_1010,
  "1011": skill_1000,
};

/**
 * 技能配置（id → 配置）：数值表（skill-data）+ 实现映射（本文件）合成
 * 消费方照旧 skills.get(id)，行为与拆分前一致（数值与 id→实现映射见 test-skill-decouple.cjs 守卫）
 */
export const skills = new Map<SkillId, SkillConfig>();
for (const item of skillData) {
  skills.set(item.id, { ...item, onClick: skillHandlers[item.id] });
}
