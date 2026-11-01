import { LevelConfig } from "../types/common";
import type { Level as LevelRow } from "../ui/utils/net/ApiModels";

/**
 * 等级运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端快照 `levels` 段（#590 新增）：每级的裸属性由服务端
 * `growth-seed` 按曲线当场展开，升级经验取 `level_exps` 表（管理端可改的最终权威）。
 * 客户端不再派生（曲线 / 标量 / 经验公式已全部随 #590 移出客户端）。
 *
 * 口径与称号 / 战魂 / 军衔（#590）一致：
 * - **整表重建**（先 clear 再按行填，`levelMap` 引用不变）——快照没有的等级客户端就没有，
 *   「管理端把上限调小」后多出来的等级会自动消失；
 * - **快照先于预载必到**（`Game.start` 里 `loadGameConfig()` 在 `PreloadManager` 之前），
 *   `levelMap` 的消费方（`entities/Role`、经验条）全部在进游戏后才读它。
 */

/** 等级配置map（1 ~ roleMaxLevel；快照到达前为空表） */
export const levelMap = new Map<number, LevelConfig>();

/**
 * 快照 `levels` 段 → 运行时表（**整表重建**；消费方拿到的 `levelMap` 引用不变）
 *
 * 快照行属性是 {min,max} 区间对象，这里转回客户端一直用的元组 `[min, max]`。
 */
export function applyLevelRows(rows: LevelRow[]): void {
  levelMap.clear();
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    levelMap.set(row.level, {
      exp: Number(row.exp) || 1,
      maxHp: Number(row.maxHp) || 0,
      maxMp: Number(row.maxMp) || 0,
      hpRecover: Number(row.hpRecover) || 0,
      physicalAttack: range(row.physicalAttack ?? { min: 0, max: 0 }),
      magicAttack: range(row.magicAttack ?? { min: 0, max: 0 }),
      taoistAttack: range(row.taoistAttack ?? { min: 0, max: 0 }),
      physicalDefense: range(row.physicalDefense ?? { min: 0, max: 0 }),
      magicDefense: range(row.magicDefense ?? { min: 0, max: 0 }),
      taoistDefense: range(row.taoistDefense ?? { min: 0, max: 0 }),
    });
  }
}

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}
