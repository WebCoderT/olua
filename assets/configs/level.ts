import { LevelConfig } from "../types/common";
import { getLevelKills, getRoleLevelAttributes, roleMaxLevel } from "./growth";

/**
 * 等级配置
 *
 * 数值**全部来自 configs/growth 的成长曲线**，这里只做「曲线 → levelMap」的搬运与经验换算：
 * 想调血量/攻防/升级节奏，改 configs/growth，不要在这里手写数字。
 */

/** 等级配置map（1 ~ roleMaxLevel） */
export const levelMap = new Map<number, LevelConfig>();

/** 击杀经验获取节奏 */
export const expGain = {
  /** 每级基准经验：同等级击杀经验 = (怪物等级 + 1) × 该值 */
  expPerLevel: 5,
  /** 角色与怪物等级差达到该值（含）后不再获得经验 */
  maxLevelGap: 6,
};

for (let level = 1; level <= roleMaxLevel; level++) {
  const attributes = getRoleLevelAttributes(level);
  levelMap.set(level, {
    /**
     * 升到下一级所需经验
     * = 该级要击杀的同级怪数量（configs/growth.roleGrowth.killsPerLevel）
     * × 每只同级怪给的经验（=(等级+1) × expGain.expPerLevel，见下面的 getKillExp）
     * 两条曲线共用同一个 expPerLevel，所以「每级要打几只」与实际得到的经验永远对得上。
     */
    exp: getLevelKills(level) * (level + 1) * expGain.expPerLevel,
    maxHp: attributes.maxHp,
    maxMp: attributes.maxMp,
    physicalAttack: attributes.physicalAttack,
    magicAttack: attributes.magicAttack,
    taoistAttack: attributes.taoistAttack,
    physicalDefense: attributes.physicalDefense,
    magicDefense: attributes.magicDefense,
    taoistDefense: attributes.taoistDefense,
  });
}

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}

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
