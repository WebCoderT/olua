import { StatusConfig, StatusId, StatusSource } from "../types/status";

/**
 * 状态注册表
 * 所有状态的名称/图标/持续时间/来源/身上特效统一在这里登记，
 * 来源不限：技能释放（技能配置的 statusId，见 configs/skill-data）、装备穿戴、VIP 等增值属性都调 StatusManager.apply 添加，
 * 配置新增一项状态即可，管理器与视图零改动
 */
export const statuses = new Map<StatusId, StatusConfig>();

/** 插入状态数据 */
statuses.set("2001", {
  label: "护体神盾",
  icon: "skill/icon/2009",
  duration: 10,
  source: StatusSource.SKILL,
  description: "护体神盾：释放技能后获得，持续时间内 30% 概率格挡，格挡时本次受到的伤害减半；重复释放刷新持续时间",
  effect: "effect/status/s_2004@0",
  // 神盾特效播完就是完整形态：只播一遍停在尾帧，不循环
  effectHoldLast: true,
  // 格挡：30% 概率触发，触发时伤害 ×0.5（口径见 types/status.StatusCombatConfig 与 client/FAQ.md）
  combat: { blockChance: 0.3, blockFactor: 0.5 },
});

statuses.set("2002", {
  label: "金刚护体",
  icon: "skill/icon/1008",
  duration: 8,
  source: StatusSource.SKILL,
  description: "金刚护体：释放技能后获得，持续时间内防御 ×1.5；重复释放刷新持续时间",
  effect: "effect/skill/s_1008@0",
  // 防御乘法系数：生效于「攻 - 防」的防御项（乘法口径，多状态连乘）
  combat: { defenseMultiplier: 1.5 },
});

//#region 怪物状态（#372；9000 段，与怪物技能同时进表）
/*
 * 怪物状态与角色状态同表：客户端只负责在怪物身上播 effect、在血条旁不做图标栏，
 * 数值生效在服务端（MonsterAiService 按 combat 连乘攻防），与角色侧同一套语义。
 */
statuses.set("9001", {
  label: "狂怒",
  icon: "skill/icon/2009",
  duration: 10,
  source: StatusSource.SKILL,
  description: "狂怒：持续时间内物理攻击 ×1.5，怪物放完这套状态后打人更疼",
  effect: "effect/status/s_2004@0",
  combat: { attackMultiplier: 1.5 },
});

statuses.set("9002", {
  label: "硬化皮肤",
  icon: "skill/icon/1008",
  duration: 10,
  source: StatusSource.SKILL,
  description: "硬化皮肤：持续时间内防御 ×1.5，玩家打它更吃力",
  effect: "effect/skill/s_1008@0",
  combat: { defenseMultiplier: 1.5 },
});
//#endregion
