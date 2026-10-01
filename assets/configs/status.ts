import { SkillStatusMap, StatusConfig, StatusId, StatusSource } from "../types/status";

/**
 * 状态注册表
 * 所有状态的名称/图标/持续时间/来源/身上特效统一在这里登记，
 * 来源不限：技能释放（见 SkillStatusMap）、装备穿戴、VIP 等增值属性都调 StatusManager.apply 添加，
 * 配置新增一项状态即可，管理器与视图零改动
 */
export const statuses = new Map<StatusId, StatusConfig>();

/** 插入状态数据 */
statuses.set("2001", {
  label: "护体神盾",
  icon: "skill/2009",
  duration: 10,
  source: StatusSource.SKILL,
  description: "护体神盾：释放技能后获得，持续时间内概率格挡伤害；重复释放刷新持续时间",
  effect: "effect/skill/s_2009@0",
});

statuses.set("2002", {
  label: "金刚护体",
  icon: "skill/1008",
  duration: 8,
  source: StatusSource.SKILL,
  description: "金刚护体：释放技能后获得，持续时间内提升防御；重复释放刷新持续时间",
  effect: "effect/skill/s_1008@0",
});

/** 技能 -> 状态映射（状态型技能释放成功后按此添加状态；装备/VIP 等来源直接调 StatusManager.apply） */
export const skillStatusMap: SkillStatusMap = {
  /** 护体神盾 */
  "1010": "2001",
  /** 金刚护体 */
  "1011": "2002",
};
