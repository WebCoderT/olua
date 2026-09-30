import type { Node, Vec2, Vec3 } from "cc";
import type { Role } from "../entities/Role";
import type { ACTION, DIRECTION } from "./animation";
import type { Monster } from "./monster";
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
  /** 自身 */
  SELF = "3",
}

/** 技能伤害计算系数 */
export interface DamageCoefficient {
  /** 基础伤害类型来源 */
  baseType: keyof BattleAttributes;
  /** 基础伤害倍数 */
  baseTypeRate: number;
}

/**
 * 技能击退配置（技能对目标的位移）
 * 怪物与角色之间谁都不会推动谁走，技能击退是场上唯一能推动位置的途径：
 * 单体技能在技能配置里写上 push 即可生效（由 SkillManager 统一处理），
 * 群体/区域技能在技能实现里自行调用 monsters.push
 */
export interface SkillPushConfig {
  /** 击退距离（像素） */
  distance: number;
  /** 击退时长（毫秒，缺省取 configs/monster 的 monsterAI.pushDuration） */
  duration?: number;
}

/** 施法者能力（由 RoleDisplay 实现） */
export interface SkillCaster extends Node {
  /** 是否正在攻击/施法（动作动画未播放完成期间为 true，期间释放技能无反应） */
  isAttacking(): boolean;
  /**
   * 面向指定方向播放技能配置的动作动画（技能表现），动画播放完成前锁定移动与再次攻击
   * @param action 技能配置的动作（config.action）
   */
  playSkillAttack(action: ACTION, direction: DIRECTION): boolean;
}

/** 怪物管理器为技能提供的能力（由 MonsterManager 实现） */
export interface SkillMonsterProvider {
  /** 获取以 position 为中心、distance 范围内最近的存活怪物节点（distance <= 0 不限距离） */
  getNearestMonster(position: Vec3, distance: number): Node | null;
  /** 获取目标节点的怪物数据 */
  getMonsterData(target: Node): Monster | null;
  /** 对目标结算一次伤害（刷新血条，死亡移除） */
  hurt(target: Node, damage: number): void;
  /**
   * 击退目标（direction 为世界坐标下的方向向量，无需归一化；distance 像素，duration 毫秒）
   * 这是场上唯一能推动怪物的途径
   */
  push(target: Node, direction: Vec2, distance: number, duration?: number): void;
}

/** 技能释放上下文（技能实现只依赖此对象，不反查全局） */
export interface SkillContext {
  /** 施法者角色数据 */
  role: Role;
  /** 施法者节点 */
  caster: SkillCaster;
  /** 目标怪物节点（单体技能由 SkillManager 补全/校验） */
  target: Node | null;
  /** 技能等级（从 1 开始） */
  level: number;
  /** 技能配置 */
  config: SkillConfig;
  /** 怪物容器能力 */
  monsters: SkillMonsterProvider;
}

/** 技能触发输入（由 RoleDisplay 组装，config/level 由 SkillManager 补全） */
export type SkillContextInput = Omit<SkillContext, "config" | "level">;

// 技能接口
export interface SkillConfig {
  /** 技能名称 */
  label: string;
  /** 技能图标 */
  icon: string;
  /** 技能冷却时间:秒 */
  cooldown: number;
  /** 释放一次消耗的魔法值（角色当前魔法值不足时无法释放，见 SkillManager） */
  mpCost: number;
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
  /** 对应动画 */
  action: ACTION;
  /**
   * 击退配置：配置后该技能命中会击退目标（单体技能由 SkillManager 统一处理，
   * 群体/区域技能在技能实现里自行调用 monsters.push）
   */
  push?: SkillPushConfig;
  /** 释放技能方法（入参为技能上下文） */
  onClick: (context: SkillContext) => void;
  /** 是否可自动释放 */
  canAuto: boolean;
  /** 技能特效 */
  effect?: string;
  /** 特效是否在自己身上 */
  effectIsOnSelf?: boolean;
}

/** 技能ID */
export type SkillId = "1000" | "1001" | "1002" | "1003" | "1004" | "1005" | "1006" | "1007" | "1008" | "1009" | "1010" | "1011";
