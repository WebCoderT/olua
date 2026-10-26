import { RoleSkillId, SkillConfig, SkillContext, SkillData, SkillId } from "../types/skill";
import { skill_1000, skill_1001, skill_1008, skill_1010 } from "../skills/warrior";
import { skillData } from "./skill-data";

// 数值数据与文案表原样再导出（消费方照旧 from "../configs/skill"，零改动；#31 只拆文件不动接口）
export { basicAttackSkillId, oeccupationSkills, skillTargetTypeLabels, skillTypeLabels } from "./skill-data";

/**
 * 角色技能释放实现（id → 实现函数）
 * Record<RoleSkillId, ...> 让 tsc 强制角色技能 id 齐全：新增技能漏接实现 = 编译不过
 *
 * #372 起技能 id 不再是封闭枚举（怪物技能由管理端增删），但**释放实现只属于角色技能** ——
 * 怪物技能由服务端 AI 执行、客户端只演出，所以这张表仍是封闭的 Record。
 */
const roleSkillHandlers: Record<RoleSkillId, (context: SkillContext) => void> = {
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

/** 取技能 id 的客户端释放实现（怪物技能返回 undefined —— 它们不该走本地释放入口） */
export function skillHandlerOf(id: SkillId): ((context: SkillContext) => void) | undefined {
  return (roleSkillHandlers as Record<string, ((context: SkillContext) => void) | undefined>)[id];
}

/**
 * 按 id 查技能数值（含怪物技能）
 *
 * 演出侧用（`MonsterManager` 收到 casts 帧后按 action / effect / castLockMs 播给怪物看），
 * 与 `skills` Map 的区别是：不要求有本地释放实现。
 */
export function findSkillConfig(id: string): SkillData | undefined {
  return skillData.find((item) => item.id === id);
}

/**
 * 技能配置（id → 配置）：数值表（skill-data）+ 实现映射（本文件）合成
 * 消费方照旧 skills.get(id)，行为与拆分前一致（数值与 id→实现映射见 test-skill-decouple.cjs 守卫）
 *
 * 只装**有本地实现**的技能（角色技能）：怪物技能进来也没有可调 onClick，
 * 混在里面只会让「误调本地释放」这类 bug 更难发现。
 */
export const skills = new Map<SkillId, SkillConfig>();

/**
 * 按当前 skillData 重建 skills Map（数值/文案来自数据表，释放实现来自 skillHandlers）
 *
 * 为什么要单独一个函数：`skills` 的值是 `{...item, onClick}` 的**副本**，
 * 配置快照（#367）原地覆写的是 `skillData` 里的对象 —— 不重建的话，消费者从 Map 里
 * 读到的还是旧数值。ConfigLoader 在 applyConfigSnapshot 之后调它一次。
 */
export function rebuildSkills(): void {
  skills.clear();
  for (const item of skillData) {
    const onClick = skillHandlerOf(item.id);
    if (!onClick) continue;
    skills.set(item.id, { ...item, onClick });
  }
}

rebuildSkills();
