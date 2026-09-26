import { LevelConfig } from "../types/common";

// 等级配置map
export const levelMap = new Map<number, LevelConfig>();

levelMap.set(1, { exp: 10, maxHp: 10 });
levelMap.set(2, { exp: 100, maxHp: 100 });
levelMap.set(3, { exp: 1000, maxHp: 1000 });
levelMap.set(4, { exp: 10000, maxHp: 10000 });
levelMap.set(5, { exp: 100000, maxHp: 100000 });
levelMap.set(6, { exp: 1000000, maxHp: 1000000 });
levelMap.set(7, { exp: 10000000, maxHp: 10000000 });
levelMap.set(8, { exp: 100000000, maxHp: 100000000 });
levelMap.set(9, { exp: 1000000000, maxHp: 1000000000 });
levelMap.set(10, { exp: 10000000000, maxHp: 10000000000 });

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}
