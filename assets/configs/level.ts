import { LevelConfig } from "../types/common";

// 等级配置map
export const levelMap = new Map<number, LevelConfig>();

function createLevelConfig(exp: number, maxHp: number): LevelConfig {
  const growth = Math.max(0, maxHp - 10);
  const attributeRange = (rate: number): [number, number] => [Math.floor(growth * rate * 0.25), 10 + Math.floor(growth * rate)];

  return {
    exp,
    maxHp,
    physicalAttack: attributeRange(0.1),
    magicAttack: attributeRange(0.08),
    taoistAttack: attributeRange(0.06),
    physicalDefense: attributeRange(0.05),
    magicDefense: attributeRange(0.04),
    taoistDefense: attributeRange(0.03),
  };
}

levelMap.set(1, createLevelConfig(10, 10));
levelMap.set(2, createLevelConfig(50, 50));
levelMap.set(3, createLevelConfig(100, 100));
levelMap.set(4, createLevelConfig(200, 150));
levelMap.set(5, createLevelConfig(500, 300));
levelMap.set(6, createLevelConfig(1000, 500));
levelMap.set(7, createLevelConfig(1500, 700));
levelMap.set(8, createLevelConfig(2000, 1000));
levelMap.set(9, createLevelConfig(2500, 1500));
levelMap.set(10, createLevelConfig(10000, 3000));
levelMap.set(11, createLevelConfig(15000, 4000));
levelMap.set(12, createLevelConfig(20000, 5000));
levelMap.set(13, createLevelConfig(25000, 6000));
levelMap.set(14, createLevelConfig(30000, 7000));
levelMap.set(15, createLevelConfig(45000, 8000));
levelMap.set(16, createLevelConfig(50000, 9000));
levelMap.set(17, createLevelConfig(55000, 10000));
levelMap.set(18, createLevelConfig(60000, 11000));
levelMap.set(19, createLevelConfig(65000, 12000));
levelMap.set(20, createLevelConfig(70000, 13000));
levelMap.set(21, createLevelConfig(75000, 14000));
levelMap.set(22, createLevelConfig(80000, 15000));
levelMap.set(23, createLevelConfig(85000, 16000));
levelMap.set(24, createLevelConfig(90000, 17000));
levelMap.set(25, createLevelConfig(95000, 18000));
levelMap.set(26, createLevelConfig(100000, 19000));
levelMap.set(27, createLevelConfig(200000, 20000));
levelMap.set(28, createLevelConfig(300000, 30000));
levelMap.set(29, createLevelConfig(400000, 40000));
levelMap.set(30, createLevelConfig(500000, 50000));

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}
