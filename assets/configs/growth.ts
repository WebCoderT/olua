import type { BattleAttributes } from "../types/common";
import type { MonsterTier } from "../types/monster";

/**
 * 成长曲线（全角色 / 全怪物的数值唯一来源）
 *
 * 这里只放「曲线」本身，不放任何具体怪物或装备的数据：
 * - 角色等级属性：configs/level 拿它生成 1~60 级的 levelMap（key 就是等级本身）
 * - 怪物属性：configs/monster 的每条怪物按**自己的 level 字段**调 monsterStats(level, tier) 拿
 *   （怪物的 key 只做相互关联，可以是任意字符串，不参与任何数值计算）
 * - 战魂属性：configs/soul 按「等效等级」取角色属性再打折
 * 想调数值一律改这个文件，不要再回各配置里散着改。
 *
 * ## 曲线形态：分段线性
 * 每 10 级一个档位，**档内**每升一级涨固定值（明文数字，好算好调），
 * **档间**每级增量突然变大（这就是「跳档」的推进感：10 级再往上升，每级血量的涨幅是之前的 3 倍多）。
 * 每档只写两个数：start（该档第 1 级的值）与 perLevel（该档每升 1 级的增量）。
 *
 * ## 设计目标（改曲线时先回来看这三条）
 * 1. **打怪节奏**：角色裸属性（不带装备/战魂）普攻同级普通怪，约 monsterBalance.hitCount（5.5）刀打死
 *    —— 普攻冷却 1 秒，所以是「同级约 5~6 秒一只」。
 * 2. **生存节奏**：角色裸血能扛同级普通怪 8~13 刀（怪普攻 2 秒一次 → 16~26 秒）。
 *    前期偏脆、后期偏肉（见下面的攻击/血量比，从 20% 一路降到 12.7%），装备与战魂用来补前期。
 * 3. **升级节奏**：每升 1 级大约要击杀 10~350 只同级怪（前期少、后期多），
 *    1→60 级全流程约 7000 只怪 ≈ 11 小时。
 *
 * ## 与装备的关系
 * 装备属性**不在这条曲线里**（独立加成层，各装备自己写数值）。
 * 曲线是按「角色裸属性」定标的，所以装备整体应该控制在角色同级裸属性的 30%~100% 区间内，
 * 才不会出现「不穿装备打不动 / 穿满装备一刀秒」的断层。
 */

/** 一条分段线性曲线的一档：档内按等级线性增长，档间靠 perLevel 跳档 */
export interface GrowthSegment {
  /** 起始等级（含） */
  from: number;
  /** 结束等级（含） */
  to: number;
  /** 该档起始等级（from）的值 */
  start: number;
  /** 该档内每升一级的增量 */
  perLevel: number;
}

/** 角色等级上限（曲线覆盖到这一级；改曲线时记得同步把 roleGrowth 的最后一段 to 改掉） */
export const roleMaxLevel = 60;

/**
 * 在分段线性曲线上取某等级的值
 * 超出最后一段时按最后一段的斜率继续外推（方便临时把 level 填高一点做测试）
 */
export function sampleGrowth(segments: GrowthSegment[], level: number): number {
  if (level <= 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/**
 * 角色等级成长表（6 档 × 10 级）
 * 攻击/防御只写「上限」，实际取值区间见 attributeRange.minRate；
 * 三项攻击同值、三项防御同值（角色只会用自己职业那一项攻击，怪也大多只有物攻，
 * 所以这里刻意不做职业强弱差 —— 职业差异留给装备与技能倍率）。
 */
export const roleGrowth = {
  /** 最大生命：100 → 98,720（60 级） */
  maxHp: [
    { from: 1, to: 10, start: 100, perLevel: 18 },
    { from: 11, to: 20, start: 330, perLevel: 59 },
    { from: 21, to: 30, start: 1080, perLevel: 192 },
    { from: 31, to: 40, start: 3520, perLevel: 630 },
    { from: 41, to: 50, start: 11500, perLevel: 2070 },
    { from: 51, to: 60, start: 37700, perLevel: 6780 },
  ] as GrowthSegment[],
  /** 攻击上限（物/魔/道三攻同值）：20 → 12,540 */
  attack: [
    { from: 1, to: 10, start: 20, perLevel: 4 },
    { from: 11, to: 20, start: 62, perLevel: 11 },
    { from: 21, to: 30, start: 184, perLevel: 33 },
    { from: 31, to: 40, start: 550, perLevel: 100 },
    { from: 41, to: 50, start: 1650, perLevel: 290 },
    { from: 51, to: 60, start: 4800, perLevel: 860 },
  ] as GrowthSegment[],
  /** 防御上限（物/魔/道三防同值）：6 → 3,762（约攻击的 30%，保证「同级怪打角色」与「角色打同级怪」同档） */
  defense: [
    { from: 1, to: 10, start: 6, perLevel: 1 },
    { from: 11, to: 20, start: 18, perLevel: 3 },
    { from: 21, to: 30, start: 55, perLevel: 10 },
    { from: 31, to: 40, start: 165, perLevel: 30 },
    { from: 41, to: 50, start: 495, perLevel: 87 },
    { from: 51, to: 60, start: 1440, perLevel: 258 },
  ] as GrowthSegment[],
  /**
   * 每升 1 级需要击杀的**同级怪数量**（不是经验值，经验的单位换算见 configs/level）
   * 10 → 350 只；配合「同级怪约 5.5 秒一只」，1→60 级全程约 11 小时
   */
  killsPerLevel: [
    { from: 1, to: 10, start: 10, perLevel: 2 },
    { from: 11, to: 20, start: 32, perLevel: 3 },
    { from: 21, to: 30, start: 65, perLevel: 4 },
    { from: 31, to: 40, start: 110, perLevel: 6 },
    { from: 41, to: 50, start: 175, perLevel: 8 },
    { from: 51, to: 60, start: 260, perLevel: 10 },
  ] as GrowthSegment[],
};

/** 属性区间与派生值比例（角色与怪物共用，改这里两边一起变） */
export const attributeRange = {
  /**
   * 属性取值下限倍率：实际值在 [上限 × minRate, 上限] 之间随机
   * 0.7 表示「最低打七折」，伤害波动约 ±15%，既有随机感又不会出现「一刀打空」的观感
   */
  minRate: 0.7,
  /** 最大魔法值 = 最大生命 × 该值（技能消耗见 configs/skill 的 mpCost） */
  mpRate: 0.5,
};

/** 按上限算属性取值区间 */
export function toAttributeRange(maximum: number): [number, number] {
  return [Math.round(maximum * attributeRange.minRate), Math.round(maximum)];
}

/** 角色某等级的战斗属性（裸属性：不含装备与战魂） */
export type RoleLevelAttributes = BattleAttributes & { maxMp: number };

/** 取角色某等级的裸属性；等级超出曲线范围时按最后一段外推 */
export function getRoleLevelAttributes(level: number): RoleLevelAttributes {
  const maxHp = Math.round(sampleGrowth(roleGrowth.maxHp, level));
  const attackMax = Math.round(sampleGrowth(roleGrowth.attack, level));
  const defenseMax = Math.round(sampleGrowth(roleGrowth.defense, level));
  const attack = toAttributeRange(attackMax);
  const defense = toAttributeRange(defenseMax);
  return {
    maxHp,
    maxMp: Math.round(maxHp * attributeRange.mpRate),
    physicalAttack: [attack[0], attack[1]],
    magicAttack: [attack[0], attack[1]],
    taoistAttack: [attack[0], attack[1]],
    physicalDefense: [defense[0], defense[1]],
    magicDefense: [defense[0], defense[1]],
    taoistDefense: [defense[0], defense[1]],
  };
}

/** 取某等级升到下一级需要击杀的同级怪数量 */
export function getLevelKills(level: number): number {
  return Math.round(sampleGrowth(roleGrowth.killsPerLevel, level));
}

//#region 怪物

/**
 * 怪物定位倍率（类型 MonsterTier 定义在 types/monster）
 * 每条怪在 configs/monster 的条目里用自己的 `tier` 字段指定定位，**不由 key 推断**
 * - normal 普通怪：曲线基准
 * - elite  精英怪：血 3 倍、攻防 1.3 倍（同级要打 16 刀左右）
 * - boss   首领：血 8 倍、攻 1.5/1.4 倍（同级要打 44 刀左右，且打人很疼）
 */
export const monsterTierScale: Record<MonsterTier, { hp: number; attack: number; defense: number }> = {
  normal: { hp: 1, attack: 1, defense: 1 },
  elite: { hp: 3, attack: 1.3, defense: 1.3 },
  boss: { hp: 8, attack: 1.5, defense: 1.4 },
};

/**
 * 怪物的「血量 = 角色打几刀」与攻防取法
 * 想让怪更耐打就调 hitCount（整体节奏），想单独放大某类怪就调 monsterTierScale
 */
export const monsterBalance = {
  /** 同级普通怪的生命 = 角色单次普攻平均伤害 × 该值（即「要打几刀」，普攻冷却 1 秒 ≈ 几秒） */
  hitCount: 5.5,
  /** 怪物攻击上限 = 同等级角色攻击上限 × 该值（1 = 打人跟角色打怪一样疼；怪普攻 2 秒一次，所以其实慢一倍） */
  attackRate: 1,
  /** 怪物防御上限 = 同等级角色防御上限 × 该值 */
  defenseRate: 1,
};

/** 怪物基础战斗属性（等级相同的怪属性完全一致，只有定位倍率不同；等级由 configs/monster 的 level 字段持有） */
export type MonsterBaseStats = Pick<BattleAttributes, "maxHp" | "physicalAttack" | "magicAttack" | "taoistAttack" | "physicalDefense" | "magicDefense" | "taoistDefense">;

/**
 * 按**等级**生成怪物的战斗属性（configs/monster 的每条怪物都用它）
 * 等级取自怪物自己的 `level` 字段 —— 不来自 key（key 只做相互关联，且允许是任意字符串）。
 * 生命不是直接拍的，而是由「角色普攻要多打几刀」反推出来的，
 * 这样以后改角色曲线，怪物的耐打程度会自动跟着保持同一手感。
 * @param level 怪物等级（就是 configs/monster 里那条怪的 level）
 * @param tier 定位：normal / elite / boss，不传按普通怪
 */
export function monsterStats(level: number, tier: MonsterTier = "normal"): MonsterBaseStats {
  const scale = monsterTierScale[tier];
  const role = getRoleLevelAttributes(level);

  const attackMax = Math.round(role.physicalAttack[1] * monsterBalance.attackRate * scale.attack);
  const defenseMax = Math.round(role.physicalDefense[1] * monsterBalance.defenseRate * scale.defense);

  // 角色一次普攻的平均伤害 = 攻击均值 − 怪物防御均值
  // 两边都是 [上限 × minRate, 上限] 的均匀随机，所以均值 = 上限 × (1 + minRate) / 2
  const averageFactor = (1 + attributeRange.minRate) / 2;
  const damagePerAttack = Math.max(1, averageFactor * (role.physicalAttack[1] - defenseMax));
  const maxHp = Math.max(1, Math.round(damagePerAttack * monsterBalance.hitCount * scale.hp));

  const defense = toAttributeRange(defenseMax);
  return {
    maxHp,
    // 怪物默认只有物理攻击（法系怪要另配魔法攻击，直接在条目里覆盖 magicAttack）
    physicalAttack: toAttributeRange(attackMax),
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    // 三种防御同值：角色三职业可能用任意一种攻击打它，防御拉开会导致某些职业凭空变强
    physicalDefense: [defense[0], defense[1]],
    magicDefense: [defense[0], defense[1]],
    taoistDefense: [defense[0], defense[1]],
  };
}

//#endregion
