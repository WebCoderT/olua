import { LevelConfig } from "../types/common";

// 等级配置map
export const levelMap = new Map<number, LevelConfig>();

function createLevelConfig(exp: number, maxHp: number): LevelConfig {
  const growth = Math.max(0, maxHp - 10);
  const attributeRange = (rate: number): [number, number] => [Math.floor(growth * rate * 0.25), 10 + Math.floor(growth * rate)];

  return {
    exp,
    maxHp,
    // 最大魔法值：血量的一半（相对关系见 configs/role.mpRecoverPerSecond，技能的消耗见 configs/skill 的 mpCost）
    maxMp: Math.floor(maxHp / 2),
    physicalAttack: attributeRange(0.1),
    magicAttack: attributeRange(0.08),
    taoistAttack: attributeRange(0.06),
    physicalDefense: attributeRange(0.05),
    magicDefense: attributeRange(0.04),
    taoistDefense: attributeRange(0.03),
  };
}

levelMap.set(1, createLevelConfig(10, 100));
levelMap.set(2, createLevelConfig(50, 200));
levelMap.set(3, createLevelConfig(100, 300));
levelMap.set(4, createLevelConfig(200, 400));
levelMap.set(5, createLevelConfig(500, 500));
levelMap.set(6, createLevelConfig(1000, 600));
levelMap.set(7, createLevelConfig(1500, 700));
levelMap.set(8, createLevelConfig(2000, 800));
levelMap.set(9, createLevelConfig(2500, 900));
levelMap.set(10, createLevelConfig(10000, 1000));
levelMap.set(11, createLevelConfig(15000, 1100));
levelMap.set(12, createLevelConfig(20000, 1200));
levelMap.set(13, createLevelConfig(25000, 1300));
levelMap.set(14, createLevelConfig(30000, 1400));
levelMap.set(15, createLevelConfig(45000, 1500));
levelMap.set(16, createLevelConfig(50000, 1600));
levelMap.set(17, createLevelConfig(55000, 1700));
levelMap.set(18, createLevelConfig(60000, 1800));
levelMap.set(19, createLevelConfig(65000, 1900));
levelMap.set(20, createLevelConfig(70000, 2000));
levelMap.set(21, createLevelConfig(75000, 2100));
levelMap.set(22, createLevelConfig(80000, 2200));
levelMap.set(23, createLevelConfig(85000, 2300));
levelMap.set(24, createLevelConfig(90000, 2400));
levelMap.set(25, createLevelConfig(95000, 2500));
levelMap.set(26, createLevelConfig(100000, 2600));
levelMap.set(27, createLevelConfig(200000, 2700));
levelMap.set(28, createLevelConfig(300000, 2800));
levelMap.set(29, createLevelConfig(400000, 2900));
levelMap.set(30, createLevelConfig(500000, 3000));
levelMap.set(31, createLevelConfig(600000, 3100));
levelMap.set(32, createLevelConfig(720000, 3200));
levelMap.set(33, createLevelConfig(860000, 3300));
levelMap.set(34, createLevelConfig(1020000, 3400));
levelMap.set(35, createLevelConfig(1200000, 3500));
levelMap.set(36, createLevelConfig(1400000, 3600));
levelMap.set(37, createLevelConfig(1650000, 3700));
levelMap.set(38, createLevelConfig(1920000, 3800));
levelMap.set(39, createLevelConfig(2240000, 3900));
levelMap.set(40, createLevelConfig(2600000, 4000));
levelMap.set(41, createLevelConfig(3000000, 4100));
levelMap.set(42, createLevelConfig(3450000, 4200));
levelMap.set(43, createLevelConfig(3960000, 4300));
levelMap.set(44, createLevelConfig(4540000, 4400));
levelMap.set(45, createLevelConfig(5200000, 4500));
levelMap.set(46, createLevelConfig(5950000, 4600));
levelMap.set(47, createLevelConfig(6800000, 4700));
levelMap.set(48, createLevelConfig(7760000, 4800));
levelMap.set(49, createLevelConfig(8850000, 4900));
levelMap.set(50, createLevelConfig(10100000, 5000));
levelMap.set(51, createLevelConfig(11500000, 5100));
levelMap.set(52, createLevelConfig(13100000, 5200));
levelMap.set(53, createLevelConfig(14900000, 5300));
levelMap.set(54, createLevelConfig(16900000, 5400));
levelMap.set(55, createLevelConfig(19200000, 5500));
levelMap.set(56, createLevelConfig(21800000, 5600));
levelMap.set(57, createLevelConfig(24700000, 5700));
levelMap.set(58, createLevelConfig(28000000, 5800));
levelMap.set(59, createLevelConfig(31800000, 5900));
levelMap.set(60, createLevelConfig(36200000, 6000));

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}

/** 击杀经验获取节奏 */
export const expGain = {
  /** 每级基准经验：同等级击杀经验 = (怪物等级 + 1) × 该值 */
  expPerLevel: 5,
  /** 角色与怪物等级差达到该值（含）后不再获得经验 */
  maxLevelGap: 6,
};

/**
 * 按角色与怪物的等级差计算一次击杀的经验
 * 同等级 100%，差值越大经验越少（线性衰减），差值 ≥ maxLevelGap 后无经验
 * @param roleLevel 角色等级
 * @param monsterLevel 怪物等级
 * @returns 获得的经验（无经验返回 0，有经验时至少 1）
 */
export function getKillExp(roleLevel: number, monsterLevel: number): number {
  const gap = Math.abs(roleLevel - monsterLevel);
  if (gap >= expGain.maxLevelGap) return 0;
  const base = (monsterLevel + 1) * expGain.expPerLevel;
  return Math.max(1, Math.round(base * (1 - gap / expGain.maxLevelGap)));
}
