/**
 * 全局共享的基础类型
 * 各领域的类型定义见同目录下的 role / animation / good / skill / map / monster
 */

/** 游戏中的所有基础属性 */
export interface CommonAttributes {
  // 名称
  label: string;
  // 等级
  level: number;
  // 介绍
  description: string;
  // 图标
  icon: string;
  // 出售价格
  sellPirce: number;
}

// 战斗属性接口
export interface BattleAttributes {
  /** 物理攻击 */
  physicalAttack: [number, number];
  /** 魔法攻击 */
  magicAttack: [number, number];
  /** 道术攻击 */
  taoistAttack: [number, number];
  /** 物理防御 */
  physicalDefense: [number, number];
  /** 魔法防御 */
  magicDefense: [number, number];
  /** 道术防御 */
  taoistDefense: [number, number];
  /** 最大血量 */
  maxHp: number;
}

/** 等级配置 */
export interface LevelConfig extends BattleAttributes {
  // 等级存储经验
  exp: number;
  /** 该等级的最大魔法值 */
  maxMp: number;
}

/**
 * 文案引用（核心代码与文案配置之间的契约）
 *
 * 核心代码只产出「用哪条文案 + 填什么参数」，具体字符串一律取自 configs/texts，
 * 因此任何面向玩家的中文都不该出现在 ui/ 里（见 tools/audit-config-leak.cjs）。
 * key 取自 configs/texts 的 uiTexts，params 用于替换模板里的 {占位符}。
 */
export interface TextRef {
  /** 文案 key（configs/texts 的 uiTexts） */
  key: string;
  /** 模板参数（模板里写 {name}，这里给 name 值） */
  params?: Record<string, string | number>;
}
