import type { SkillId } from "./skill";

/**
 * 状态来源（状态如何获得：技能 / 装备 / VIP 等增值属性 / 其他）
 * 状态的添加入口统一是 core/StatusManager.apply，来源只作标记（供后续按来源查询/过滤）
 */
export enum StatusSource {
  /** 主动/被动技能释放时获得 */
  SKILL = "skill",
  /** 穿戴装备期间持续拥有 */
  EQUIPMENT = "equipment",
  /** VIP 等角色增值属性获得 */
  PRIVILEGE = "privilege",
  /** 其他来源（活动/药品/GM 等） */
  OTHER = "other",
}

/**
 * 状态配置（configs/status 注册表的一项）
 * 状态 = 角色身上的一段持续效果：身上循环播放特效（config.effect）+ 信息栏头像下方的图标（config.icon）
 * 同一状态重复获得时只刷新持续时间（不叠加层数）；到期由 StatusManager 自动移除
 */
export interface StatusConfig {
  /** 状态名称 */
  label: string;
  /** 状态图标（resources 下的精灵路径，不含 /spriteFrame 后缀，如 "skill/2009"） */
  icon: string;
  /** 持续时间（秒）；重复获得时从获得时刻重新计时 */
  duration: number;
  /** 状态来源 */
  source: StatusSource;
  /** 状态描述 */
  description?: string;
  /**
   * 身上循环播放的特效图集（resources 下 TexturePacker 图集路径，不含扩展名，
   * 如 "effect/skill/s_2009@0"）；不配置则只在图标栏显示、身上不播特效。
   * 播放帧率与挂点偏移统一在 configs/effect 的 statusEffect（所有状态同一口径）
   */
  effect?: string;
  /**
   * 身上特效是否「只播一遍并停在尾帧」（缺省 false = 循环播放）。
   * 适合护体神盾这类播完就是完整形态的驻场特效；循环类特效不要配
   */
  effectHoldLast?: boolean;
}

/** 状态编号 */
export type StatusId = "2001" | "2002";

/** 技能获得状态的映射（skillId -> 状态编号，释放技能后由技能实现据此添加状态；非状态型技能不配） */
export type SkillStatusMap = Partial<Record<SkillId, StatusId>>;

/** 图标栏展示用的状态徽标（视图层只依赖这个轻量结构，不反查配置） */
export interface StatusBadge {
  /** 状态编号 */
  id: StatusId;
  /** 状态名称 */
  label: string;
  /** 状态图标（resources 下的精灵路径） */
  icon: string;
}
