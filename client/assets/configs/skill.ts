import { RoleSkillId, SkillBehavior, SkillConfig, SkillContext, SkillData, SkillId } from "../types/skill";
import { skillAttack, skillDash, skillStatus } from "../skills/warrior";
import { skillData } from "./game-config";

// 数值数据与文案表原样再导出（消费方照旧 from "../configs/skill"，零改动；#31 只拆文件不动接口）
export { basicAttackSkillId, oeccupationSkills, skillTargetTypeLabels, skillTypeLabels } from "./game-config";

/**
 * 释放行为 → 实现函数（#1166）
 *
 * 以前是 `roleSkillHandlers: Record<RoleSkillId, fn>` 按**技能 id** 接实现：
 * 新增一个角色技能要改客户端代码，运营在管理端更是一个行为都改不了。
 * 现在行为是技能配置的字段（`skills.behavior`），这张表按**行为**分发 ——
 * attack 单体攻击 / status 自身状态 / dash 自身突进，三种实现见 `skills/warrior.ts`。
 * 管理端把行为配好、快照下发即生效，新增角色技能不再需要动客户端。
 *
 * #372 起技能 id 不再是封闭枚举（怪物技能由管理端增删），怪物技能由服务端 AI 执行、
 * 客户端只演出，本来就不走本地释放入口 —— 行为表对它们同样只是查不到而已。
 */
const behaviorHandlers: Record<SkillBehavior, (context: SkillContext) => void> = {
  attack: skillAttack,
  status: skillStatus,
  dash: skillDash,
};

/**
 * 按行为取释放实现（快照没带 behavior 的行按 attack 兜底 —— 与出厂默认值一致，
 * 状态型的区分仍有 `type = "2"` 可查；未知行为值同样落回 attack，不空转）
 */
function behaviorOf(item: SkillData & { id: SkillId }): SkillBehavior {
  return behaviorHandlers[item.behavior] ? item.behavior : "attack";
}

/** 取技能 id 的客户端释放实现（怪物技能返回 undefined —— 它们不该走本地释放入口） */
export function skillHandlerOf(id: SkillId): ((context: SkillContext) => void) | undefined {
  const item = skillData.find((entry) => entry.id === id);
  if (!item || item.owner === "monster") return undefined;
  return behaviorHandlers[behaviorOf(item)];
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
 * 技能配置（id → 配置）：数值表（skill-data）+ 行为分发（本文件）合成
 * 消费方照旧 skills.get(id)，行为与分发口径见 test-skill-decouple.cjs 守卫
 *
 * 只装**有本地实现**的技能（角色技能）：怪物技能进来也没有可调 onClick，
 * 混在里面只会让「误调本地释放」这类 bug 更难发现。
 */
export const skills = new Map<SkillId, SkillConfig>();

/**
 * 按当前 skillData 重建 skills Map（数值/文案来自数据表，释放实现来自行为分发）
 *
 * 为什么要单独一个函数：`skills` 的值是 `{...item, onClick}` 的**副本**，
 * 配置快照（#367）原地覆写的是 `skillData` 里的对象 —— 不重建的话，消费者从 Map 里
 * 读到的还是旧数值。ConfigLoader 在 applyConfigSnapshot 之后调它一次。
 */
export function rebuildSkills(): void {
  skills.clear();
  for (const item of skillData) {
    if (item.owner === "monster") continue;
    const onClick = behaviorHandlers[behaviorOf(item)];
    skills.set(item.id, { ...item, onClick });
  }
}

rebuildSkills();

// RoleSkillId 仍被类型层引用（角色 id 段语义）；#1166 起释放实现不再按它分发，
// 保留显式引用避免「类型删了没人发现」—— 若这份联合类型彻底没用了，随引用方一起清
export type { RoleSkillId };
