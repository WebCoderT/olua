import { Drug, DrugEffect, GOOD_TYPE } from "../types/good";

/**
 * 药品配置（物品大类 GOOD_TYPE.DRUG）—— **客户端没有出厂数据**（#603 第十域）
 *
 * 名称 / 描述 / 图标 / 使用等级 / 售价 / 叠加 / 冷却 / 四段回复量的唯一书写处是
 * 服务端 `server/src/shared/item-seed.ts` → `drugs` 表（管理端「药品配置」可改）→
 * `GET /game-config` 快照的 `drugs` 段 → 这里整表重建（`applyDrugData`）。
 *
 * 以前这里是 8 条写死的行 + 「回复量按成长曲线定标」的注释；那些数字现在只在种子里，
 * 改一次药不用重打客户端包。**客户端加载期这张表是空的** —— 进游戏前查不到药品不是 bug。
 *
 * 回复量的**算法**仍在本文件之外：`configs/items.resolveDrugRecovery` 按 effects 逐项累加
 * （固定值与百分比各自相加），与种子里「同类求和」的拍平口径等价。
 */

/** 服务端药品行（快照 `drugs` 段；与 `item-seed.ts` 的 `DrugSeedRow` 同形） */
export interface DrugSeedLike {
  id: string;
  label: string;
  description: string;
  icon: string;
  level: number;
  sellPrice: number;
  maxStack: number;
  cooldown: number;
  effectHp: number;
  effectMp: number;
  effectHpPercent: number;
  effectMpPercent: number;
}

/** 药品运行时表（内容全部来自服务端；加载期为空） */
export const drugs: Drug[] = [];

/**
 * 服务端把效果拍平成四个单值（同类效果求和），客户端用的是 effects 数组 ——
 * 两者语义等价（resolveDrugRecovery 也是逐项累加），这里还原成**一条**合并效果即可。
 * 全为 0 时给空数组（0 = 没有该效果，不是「回 0 点」）。
 */
function toDrugEffects(row: DrugSeedLike): DrugEffect[] {
  const effect: DrugEffect = {};
  if (row.effectHp > 0) effect.hp = row.effectHp;
  if (row.effectMp > 0) effect.mp = row.effectMp;
  if (row.effectHpPercent > 0) effect.hpPercent = row.effectHpPercent;
  if (row.effectMpPercent > 0) effect.mpPercent = row.effectMpPercent;
  return Object.keys(effect).length ? [effect] : [];
}

/**
 * 整表重建药品（#603 第十域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有
 * （「管理端下架一种药」会如实反映）。数组是同一个引用（`drugs` 只 clear + push），
 * 消费方拿着的引用不变 —— 但 `items` 总表要重新登记（见 `configs/items.rebuildItemIndex`）。
 */
export function applyDrugData(rows: DrugSeedLike[]): void {
  drugs.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    drugs.push({
      id: row.id,
      type: GOOD_TYPE.DRUG,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      level: Number(row.level) || 1,
      sellPirce: Number(row.sellPrice) || 0,
      // 药品全部可叠加（结构约定，不是运营数据）：单格上限由服务端下发的 maxStack 决定
      stackable: true,
      maxStack: Number(row.maxStack) || 99,
      effects: toDrugEffects(row),
      cooldown: Number(row.cooldown) || 0,
    });
  }
}
