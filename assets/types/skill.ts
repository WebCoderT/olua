import type { BattleAttributes } from "./common";
import type { OECCUPATION } from "./role";

// 技能类型
export enum SkillType {
  /** 主动技能 */
  PROACTIVE = "0",
  /** 被动技能 */
  PASSIVE = "1",
  /** 状态技能 */
  STATUS = "2",
  /** 回复技能 */
  REPLY = "3",
}

// 技能目标类型
export enum SkillTargetType {
  /** 区域 */
  PLACE = "0",
  /** 单体 */
  SINGLE = "1",
  /** 群体 */
  MUTIPLE = "2",
}

/** 技能伤害计算系数 */
export interface DamageCoefficient {
  /** 基础伤害类型来源 */
  baseType: keyof BattleAttributes;
  /** 基础伤害倍数 */
  baseTypeRate: number;
}

// 技能接口
export interface SkillConfig {
  /** 技能名称 */
  label: string;
  /** 技能图标 */
  icon: string;
  /** 技能冷却时间:秒 */
  cooldown: number;
  /** 技能目标类型 */
  targetType: SkillTargetType;
  /** 技能职业 */
  oeccupation: OECCUPATION;
  /** 技能开启等级 */
  level: number;
  /** 技能描述 */
  description: string;
  /** 技能类型 */
  type: SkillType;
  /** 技能等级与伤害系数 */
  damageCoefficients: DamageCoefficient[];
  /** 使用距离 */
  distance: number;
  /** 释放技能方法 */
  onClick: Function;
}

/** 技能ID */
export type SkillId = "1000" | "1001" | "1002" | "1003" | "1004" | "1005" | "1006" | "1007" | "1008" | "1009" | "1010" | "1011";
