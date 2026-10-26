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
 * 状态的战斗数值语义（configs/status 的 StatusConfig.combat）
 * 口径（详见 client/FAQ.md「状态数值怎么参与伤害结算」）：
 * - 格挡 = 概率触发，触发时本次伤害乘 blockFactor（0.5 = 减半），未触发全额
 * - 防御类 = 乘法系数（1.5 = 防御 ×1.5），在「攻 - 防」的防御项上生效
 * - 多个状态叠加：格挡概率取最大值（不叠概率）、格挡系数取最小值（取更保护的一个）、防御系数连乘
 */
export interface StatusCombatConfig {
  /** 格挡触发概率（0-1；缺省 = 该状态不参与格挡判定） */
  blockChance?: number;
  /** 格挡触发时伤害乘的系数（0 < factor <= 1；0.5 = 减半；缺省 1 = 不减伤） */
  blockFactor?: number;
  /** 防御乘法系数（>= 1；缺省 1 = 防御不变） */
  defenseMultiplier?: number;
}

/**
 * 状态配置（configs/status 注册表的一项）
 * 状态 = 角色身上的一段持续效果：身上循环播放特效（config.effect）+ 信息栏头像下方的图标（config.icon）
 * 同一状态重复获得时只刷新持续时间（不叠加层数）；到期由 StatusManager 自动移除
 */
export interface StatusConfig {
  /** 状态名称 */
  label: string;
  /** 状态图标（resources 下的精灵路径，不含 /spriteFrame 后缀，如 "skill/icon/2009"） */
  icon: string;
  /** 持续时间（秒）；重复获得时从获得时刻重新计时 */
  duration: number;
  /** 状态来源 */
  source: StatusSource;
  /** 状态描述 */
  description?: string;
  /**
   * 战斗数值语义（缺省 = 纯表现状态，不参与伤害结算）。
   * 结算唯一入口是 ui/utils/battle/BattleMath（纯函数，可单测）；
   * 这里的字段只描述「这个状态在数值上意味着什么」，改口径去 BattleMath
   */
  combat?: StatusCombatConfig;
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

/**
 * 状态编号
 *
 * #367 起状态与技能一样由配置表下发（角色 / 怪物同表，`owner` 区分），id 不再是闭集：
 * 角色状态用 2000 段、怪物状态用 3000 段，运营按段位新增。
 */
export type StatusId = string;

/** 图标栏展示用的状态徽标（视图层只依赖这个轻量结构，不反查配置） */
export interface StatusBadge {
  /** 状态编号 */
  id: StatusId;
  /** 状态名称 */
  label: string;
  /** 状态图标（resources 下的精灵路径） */
  icon: string;
}
