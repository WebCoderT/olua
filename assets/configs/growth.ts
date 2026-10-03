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
 * 装备属性由下面的 equipmentStats(level, slot) 按**装备自己的 level** 生成，
 * 各装备的条目里不再手写攻防（要特例就写同名字段覆盖）。
 * 全套装备合计 = 同级角色裸属性的 equipmentGrowth.setPowerRate 倍（当前 2 = 200%，
 * 即穿满一套后总属性约是裸属性的 3 倍）。
 *
 * ⚠ 注意：上面的「打怪节奏 5.5 刀」是按**裸属性**定标的，
 * 所以穿满一套后同级怪只要约 1.4 刀。如果希望「穿满一套正好 5.5 刀」，
 * 要么把 setPowerRate 降下来（0.6 左右），要么把怪物血量按穿满装备重新定标
 * （改 monsterBalance，会让裸装变成约 21 刀）。
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

//#region 装备

/**
 * 装备部位键（与 types/good 的 EQUIPMENT_TYPE 枚举值一一对应）
 * 故意写成字面量联合而不是 import 枚举：growth.ts 要保持「只依赖 type 导入、能被 node 直接跑」，
 * 且拼错部位名时能直接编译报错（字符串枚举成员可赋给这里的字面量类型）
 */
export type EquipmentSlotKey =
  | "cloth"
  | "weapon"
  | "helmet"
  | "belt"
  | "shoes"
  | "necklace"
  | "ring"
  | "accessories"
  | "scapular"
  | "shinguard"
  | "wristband"
  | "other1"
  | "other2";

/** 某部位对三类属性的贡献权重（各列合计 100，含义见 equipmentSlotShare 注释） */
export interface EquipmentAttributeShare {
  /** 血量权重 */
  maxHp: number;
  /** 攻击权重（三攻同值，取角色同级攻击上限） */
  attack: number;
  /** 防御权重（三防同值，取角色同级防御上限） */
  defense: number;
}

/** 装备成长参数 */
export const equipmentGrowth = {
  /**
   * 全套装备合计 = 同级角色裸属性的该倍数
   * 2 表示「每类属性都 +200%」：穿满一套后，血量/攻击/防御都变成裸属性的 3 倍。
   *
   * ⚠ 这个值直接决定装备在养成里的分量，也直接改变打怪节奏：
   *   0.6 → 同级怪约 3.5 刀（装备是锦上添花）
   *   2.0 → 同级怪约 1.4 刀（装备是主要成长来源，怪很脆）
   * 想整体调强/调弱装备只改这一个数（各部位之间的分配比例见 equipmentSlotShare）。
   */
  setPowerRate: 2,
} as const;

/**
 * 装备前缀属性倍率（下标 = EQUIPMENT_PREFIX 序号）
 * 普通的 / 强化的 / 精良的 / 极品的 / 超神的
 */
export const equipmentPrefixRates = [1, 1.1, 1.2, 1.3, 1.4] as const;

/**
 * 装备后缀属性倍率（下标 = EQUIPMENT_SUFFIX 序号）
 * 人级 / 天级 / 神级
 */
export const equipmentSuffixRates = [1, 2, 3] as const;

/**
 * 部位分配权重（每列合计 100）
 * 实际数值 = 同级角色裸属性上限 × (该部位权重 / 100) × equipmentGrowth.setPowerRate
 *
 * 设计口径：武器只给攻击、衣服是血防主源、首饰偏攻击但血防也有、防具（头盔/腰带/鞋子）血量略高于防御。
 * 补上「肩胛/护腕/护腿/饰品」等新部位时，从现有部位里匀出权重（保持每列 100），
 * 否则全套会超过 setPowerRate。
 */
export const equipmentSlotShare: Record<EquipmentSlotKey, EquipmentAttributeShare> = {
  weapon: { maxHp: 0, attack: 52, defense: 8 },
  cloth: { maxHp: 30, attack: 10, defense: 30 },
  helmet: { maxHp: 16, attack: 5, defense: 15 },
  belt: { maxHp: 17, attack: 4, defense: 15 },
  shoes: { maxHp: 13, attack: 5, defense: 14 },
  necklace: { maxHp: 12, attack: 12, defense: 9 },
  ring: { maxHp: 12, attack: 12, defense: 9 },
  // 以下部位暂无装备：权重留 0，补装备时从上面匀（写 0 而不是缺键，是为了让拼错的部位名编译报错）
  accessories: { maxHp: 0, attack: 0, defense: 0 },
  scapular: { maxHp: 0, attack: 0, defense: 0 },
  shinguard: { maxHp: 0, attack: 0, defense: 0 },
  wristband: { maxHp: 0, attack: 0, defense: 0 },
  other1: { maxHp: 0, attack: 0, defense: 0 },
  other2: { maxHp: 0, attack: 0, defense: 0 },
};

/** 装备提供的战斗属性（固定值：区间两端同数，与角色的浮动区间区分开） */
export type EquipmentStats = Pick<BattleAttributes, "maxHp" | "physicalAttack" | "magicAttack" | "taoistAttack" | "physicalDefense" | "magicDefense" | "taoistDefense">;

/**
 * 按**装备等级 + 部位**生成战斗属性（configs/equipments 的每条装备都用它）
 * 等级取自装备条目自己的 `level` 字段（= 穿戴需求等级），部位取自 `slot` 字段。
 * 数值是**固定值**（区间两端相同），同名装备数值确定，便于横向比较与手调。
 * @param level 装备等级（穿戴需求等级）
 * @param slot 装备部位（决定属性分配比例）
 */
export function equipmentStats(level: number, slot: EquipmentSlotKey): EquipmentStats {
  const share = equipmentSlotShare[slot];
  const role = getRoleLevelAttributes(level);
  const rate = equipmentGrowth.setPowerRate / 100;

  // 有份额但算出来 <1 时保底 1（低等级时裸属性很小，四舍五入会把小份额抹成 0）
  const scale = (maximum: number, weight: number) => (weight > 0 ? Math.max(1, Math.round(maximum * weight * rate)) : 0);

  const maxHp = scale(role.maxHp, share.maxHp);
  const attack = scale(role.physicalAttack[1], share.attack);
  const defense = scale(role.physicalDefense[1], share.defense);
  return {
    maxHp,
    // 三攻同值：角色只用自己职业那一项，拉开只会凭空造出职业强弱差（与角色曲线同一口径）
    physicalAttack: [attack, attack],
    magicAttack: [attack, attack],
    taoistAttack: [attack, attack],
    physicalDefense: [defense, defense],
    magicDefense: [defense, defense],
    taoistDefense: [defense, defense],
  };
}

//#endregion
