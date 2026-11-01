/**
 * 成长曲线种子（#590 起服务端唯一书写处）
 *
 * #361 之前曲线写在客户端 `configs/growth`，生成器抄进 game-data.generated —— 归属反了：
 * 「调一次曲线要改客户端 + 重新生成 + 服务端重启」三步，漏一步就是两端数值漂移。
 * #590 起曲线与标量**只在这里手写**，客户端经快照 `levels` 段拿最终值，
 * 生成物不再收录本文件任何内容（gen-shared-data 的 SOURCE_FILES 已移除 growth/level）。
 *
 * ## 曲线形态：分段线性
 * 每 10 级一个档位，**档内**每升一级涨固定值，**档间**每级增量突然变大（「跳档」的推进感）。
 * 每档只写两个数：start（该档第 1 级的值）与 perLevel（该档每升 1 级的增量）。
 *
 * ## 设计目标（改曲线时先回来看这三条）
 * 1. **打怪节奏**：角色裸属性普攻同级普通怪，约 monsterBalance.hitCount（5.5）刀打死
 *    —— 普攻冷却 1 秒，所以是「同级约 5~6 秒一只」。
 * 2. **生存节奏**：角色裸血能扛同级普通怪 8~13 刀；每秒回血（maxHp × hpRecoverRate）
 *    把生存时间再拉长约 1.4 倍。回血的唯一强度入口是 hpRecoverRate，装备与三条成长线
 *    各按自己的折扣乘上来（monster-seed / title-seed / rank-seed）。
 * 3. **升级节奏**：每升 1 级约击杀 10~350 只同级怪（killsPerLevel 曲线），1→60 级约 11 小时。
 *
 * ⚠ 消费方：本文件只依赖类型（可被 node/ts 独立编译），**禁止 import 服务端模块**；
 * 曲线改动会同时影响 levelExps seed（growth-config.service）、怪物出厂（monster-seed）、
 * 三条成长线出厂（title-seed / rank-seed，战魂已冻结不受影响）。
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

/** 角色等级成长表（6 档 × 10 级；三项攻击同值、三项防御同值 —— 职业差异留给装备与技能倍率） */
export const GROWTH_CURVES: Record<"maxHp" | "attack" | "defense" | "killsPerLevel", GrowthSegment[]> = {
  /** 最大生命：100 → 98,720（60 级） */
  maxHp: [
    { from: 1, to: 10, start: 100, perLevel: 18 },
    { from: 11, to: 20, start: 330, perLevel: 59 },
    { from: 21, to: 30, start: 1080, perLevel: 192 },
    { from: 31, to: 40, start: 3520, perLevel: 630 },
    { from: 41, to: 50, start: 11500, perLevel: 2070 },
    { from: 51, to: 60, start: 37700, perLevel: 6780 },
  ],
  /** 攻击上限（物/魔/道三攻同值）：20 → 12,540 */
  attack: [
    { from: 1, to: 10, start: 20, perLevel: 4 },
    { from: 11, to: 20, start: 62, perLevel: 11 },
    { from: 21, to: 30, start: 184, perLevel: 33 },
    { from: 31, to: 40, start: 550, perLevel: 100 },
    { from: 41, to: 50, start: 1650, perLevel: 290 },
    { from: 51, to: 60, start: 4800, perLevel: 860 },
  ],
  /** 防御上限（物/魔/道三防同值）：6 → 3,762（约攻击的 30%） */
  defense: [
    { from: 1, to: 10, start: 6, perLevel: 1 },
    { from: 11, to: 20, start: 18, perLevel: 3 },
    { from: 21, to: 30, start: 55, perLevel: 10 },
    { from: 31, to: 40, start: 165, perLevel: 30 },
    { from: 41, to: 50, start: 495, perLevel: 87 },
    { from: 51, to: 60, start: 1440, perLevel: 258 },
  ],
  /** 每升 1 级需要击杀的同级怪数量：10 → 350 只（1→60 级全程约 11 小时） */
  killsPerLevel: [
    { from: 1, to: 10, start: 10, perLevel: 2 },
    { from: 11, to: 20, start: 32, perLevel: 3 },
    { from: 21, to: 30, start: 65, perLevel: 4 },
    { from: 31, to: 40, start: 110, perLevel: 6 },
    { from: 41, to: 50, start: 175, perLevel: 8 },
    { from: 51, to: 60, start: 260, perLevel: 10 },
  ],
};

/** 属性区间与派生值比例（角色与怪物共用，改这里两边一起变） */
export const ATTRIBUTE_RANGE = {
  /** 属性取值下限倍率：实际值在 [上限 × minRate, 上限] 之间随机（0.7 = 伤害波动约 ±15%） */
  minRate: 0.7,
  /** 最大魔法值 = 最大生命 × 该值 */
  mpRate: 0.5,
  /** 每秒血量回复 = 最大生命 × 该值（回血的唯一强度入口，只作用在裸回血上） */
  hpRecoverRate: 0.01,
} as const;

/** 经验换算：同级怪经验 = (怪等级 + 1) × expPerLevel；角色与怪等级差 ≥ maxLevelGap 后不再获得经验 */
export const EXP_GAIN = {
  expPerLevel: 5,
  maxLevelGap: 6,
} as const;

/** 成长标量参数键 → 数值（seed 进 growth_scalars 表，管理端可改；键名是管理端接口契约） */
export const GROWTH_SCALARS: Record<string, number> = {
  roleMaxLevel: 60,
  "attributeRange.minRate": ATTRIBUTE_RANGE.minRate,
  "attributeRange.mpRate": ATTRIBUTE_RANGE.mpRate,
  "attributeRange.hpRecoverRate": ATTRIBUTE_RANGE.hpRecoverRate,
  "expGain.expPerLevel": EXP_GAIN.expPerLevel,
  "expGain.maxLevelGap": EXP_GAIN.maxLevelGap,
};

/** 角色等级上限（= 每条曲线末段的 to；改曲线先改末段，再来抬这个数） */
export const ROLE_MAX_LEVEL = GROWTH_SCALARS.roleMaxLevel;

/** 在分段线性曲线上取某等级的值；超出最后一段时按最后一段的斜率继续外推 */
export function sampleGrowth(segments: GrowthSegment[], level: number): number {
  if (level <= 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/** 按上限算属性取值区间 */
export function toAttributeRange(maximum: number): [number, number] {
  return [Math.round(maximum * ATTRIBUTE_RANGE.minRate), Math.round(maximum)];
}

/** 角色某等级的战斗属性（裸属性：不含装备与战魂；多一个 maxMp） */
export type RoleLevelAttributes = {
  maxHp: number;
  hpRecover: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
  maxMp: number;
};

/** 取角色某等级的裸属性；等级超出曲线范围时按最后一段外推 */
export function getRoleLevelAttributes(level: number): RoleLevelAttributes {
  const maxHp = Math.round(sampleGrowth(GROWTH_CURVES.maxHp, level));
  const attackMax = Math.round(sampleGrowth(GROWTH_CURVES.attack, level));
  const defenseMax = Math.round(sampleGrowth(GROWTH_CURVES.defense, level));
  const attack = toAttributeRange(attackMax);
  const defense = toAttributeRange(defenseMax);
  return {
    maxHp,
    maxMp: Math.round(maxHp * ATTRIBUTE_RANGE.mpRate),
    hpRecover: Math.round(maxHp * ATTRIBUTE_RANGE.hpRecoverRate),
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
  return Math.round(sampleGrowth(GROWTH_CURVES.killsPerLevel, level));
}

/** 升到 `level` 升级的所需经验（出厂值；库 `level_exps` 表是管理端可改的最终权威） */
export function deriveLevelExp(level: number): number {
  return getLevelKills(level) * (level + 1) * EXP_GAIN.expPerLevel;
}

/**
 * 角色全等级属性表（键 "1".."roleMaxLevel"，值含 exp）
 *
 * 三类消费方：
 * - `growth-config.service` 的 levelExps seed（exp 出厂值）；
 * - `monster-seed` 的怪物出厂展开（按等级取裸属性反推血量）；
 * - `client-config.service` 的快照 `levels` 段（客户端 levelMap 的唯一来源，#590）。
 *
 * 模块加载期一次性展开，之后曲线改动 = 改上面的 GROWTH_CURVES（唯一书写处）。
 */
export const ROLE_LEVEL_ATTRIBUTES: Record<string, RoleLevelAttributes & { exp: number }> = Object.fromEntries(
  Array.from({ length: ROLE_MAX_LEVEL }, (_, index) => {
    const level = index + 1;
    return [String(level), { ...getRoleLevelAttributes(level), exp: deriveLevelExp(level) }];
  }),
);

// ————————————————————————————————————————————————————————————
// 装备出厂属性（#590：随曲线一起搬来服务端 —— 客户端 configs 只剩零值结构 + 快照重算）
// ————————————————————————————————————————————————————————————

/**
 * 装备成长参数：全套装备合计 = 同级角色裸属性的 setPowerRate 倍（2 = +200%，
 * 穿满一套后血量 / 攻击 / 防御都变成裸属性的 3 倍）。
 * 想整体调强 / 调弱装备只改这一个数（部位之间的分配比例见 EQUIPMENT_SLOT_SHARE）。
 */
export const EQUIPMENT_SET_POWER_RATE = 2;

/** 某部位对各类属性的贡献权重（每列合计 100） */
export type EquipmentAttributeShare = {
  /** 血量权重 */
  maxHp: number;
  /** 攻击权重（三攻同值，取角色同级攻击上限） */
  attack: number;
  /** 防御权重（三防同值，取角色同级防御上限） */
  defense: number;
  /** 每秒回血权重（取角色同级的裸回血，见 ATTRIBUTE_RANGE.hpRecoverRate） */
  recover: number;
};

/**
 * 部位分配权重（每列合计 100）
 * 实际数值 = 同级角色裸属性上限 × (该部位权重 / 100) × EQUIPMENT_SET_POWER_RATE
 *
 * 设计口径：武器只给攻击、衣服是血防主源、首饰偏攻击但血防也有、防具（头盔 / 腰带 / 鞋子）血量略高于防御。
 * **回血列只在防御部位**（衣服 / 头盔 / 腰带 / 鞋子）：武器与首饰不提供每秒回血。
 * 补新部位时从现有部位匀权重（保持每列 100），否则全套会超过 setPowerRate。
 */
export const EQUIPMENT_SLOT_SHARE: Record<string, EquipmentAttributeShare> = {
  weapon: { maxHp: 0, attack: 52, defense: 8, recover: 0 },
  cloth: { maxHp: 30, attack: 10, defense: 30, recover: 40 },
  helmet: { maxHp: 16, attack: 5, defense: 15, recover: 20 },
  belt: { maxHp: 17, attack: 4, defense: 15, recover: 20 },
  shoes: { maxHp: 13, attack: 5, defense: 14, recover: 20 },
  necklace: { maxHp: 12, attack: 12, defense: 9, recover: 0 },
  ring: { maxHp: 12, attack: 12, defense: 9, recover: 0 },
  // 以下部位暂无装备：权重留 0，补装备时从上面匀（写 0 而不是缺键，是为了让拼错的部位名可见）
  accessories: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
  scapular: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
  shinguard: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
  wristband: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
  other1: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
  other2: { maxHp: 0, attack: 0, defense: 0, recover: 0 },
};

/** 装备提供的战斗属性（固定值：区间两端同数，与角色的浮动区间区分开） */
export type EquipmentStats = {
  maxHp: number;
  hpRecover: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
};

/**
 * 按**装备等级 + 部位**生成出厂战斗属性（equipments 表 seed 与生成物的唯一来源）
 * 数值是固定值（区间两端相同），同名装备数值确定，便于横向比较与手调。
 * @param level 装备等级（穿戴需求等级）
 * @param slot 装备部位（决定属性分配比例）
 */
export function equipmentStats(level: number, slot: string): EquipmentStats {
  const share = EQUIPMENT_SLOT_SHARE[slot] ?? { maxHp: 0, attack: 0, defense: 0, recover: 0 };
  const role = getRoleLevelAttributes(level);
  const rate = EQUIPMENT_SET_POWER_RATE / 100;

  // 有份额但算出来 <1 时保底 1（低等级时裸属性很小，四舍五入会把小份额抹成 0）
  const scale = (maximum: number, weight: number) => (weight > 0 ? Math.max(1, Math.round(maximum * weight * rate)) : 0);

  const maxHp = scale(role.maxHp, share.maxHp);
  const attack = scale(role.physicalAttack[1], share.attack);
  const defense = scale(role.physicalDefense[1], share.defense);
  // 回血**不保底 1**：低等级防具只加几十点血，凑不出 1 点/秒是正常的；
  // 强行保底会让 1 级穿满四件防具的角色白拿 4 点/秒（同级怪打人约 7 点/秒），前期直接无敌
  const hpRecover = share.recover > 0 ? Math.round(role.hpRecover * share.recover * rate) : 0;
  return {
    maxHp,
    hpRecover,
    // 三攻同值：角色只用自己职业那一项，拉开只会凭空造出职业强弱差（与角色曲线同一口径）
    physicalAttack: [attack, attack],
    magicAttack: [attack, attack],
    taoistAttack: [attack, attack],
    physicalDefense: [defense, defense],
    magicDefense: [defense, defense],
    taoistDefense: [defense, defense],
  };
}
