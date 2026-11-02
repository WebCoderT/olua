import type { BattleAttributes } from "../types/common";

/**
 * 战斗力权重（#603 起**客户端不再存数值**）
 *
 * 唯一书写处是服务端 `server/src/shared/combat-seed.ts`：服务端用它算角色战斗力
 * （`modules/combat/role-attributes.ts`），客户端只用它算「这件装备是不是更好」
 * （`configs/equipments.equipmentCombatValue`）。进游戏拉配置快照时，
 * `configs/apply-snapshot` 用快照的 `combatWeights` 段把这张表填满。
 *
 * 表为空时 `equipmentCombatValue` 返回 0 → 「更好装备」提示会把所有候选判成不更好
 * （不崩，但等于该功能失效），所以表缺行属配置问题，不该再在本地兜底一份倍率。
 *
 * 计入战斗力的属性：hpRecover（每秒回血）**不算** —— 战斗力是地图准入的门槛
 * （`configs/map` 的 combat），而回血是持续回复、不改变输出与承伤上限；
 * 算进来会凭空抬高所有地图的门槛。
 */
export type CombatCalcAttribute = Exclude<keyof BattleAttributes, "hpRecover">;

/** 战斗力计算权重（属性名 → 倍率；区间型属性取上下限之和）—— 数值由快照 `combatWeights` 填 */
export const combatCalc = new Map<CombatCalcAttribute, number>();

/**
 * 用快照下发的权重整表重建（`configs/apply-snapshot` 调用）
 *
 * **先 clear 再填**：权重表由服务端决定，客户端没有「本地兜底行」可言 ——
 * 留着旧行会让「运营删掉某个权重」在客户端变成幽灵倍率。
 */
export function applyCombatWeights(weights: Record<string, number> | undefined): void {
  combatCalc.clear();
  if (!weights) return;
  // 用 for..in 而不是 Object.entries：客户端 tsconfig 的 lib 不含 ES2017，
  // 且打包器（babel loose）对 entries 这类新 API 不做垫片（`[...map.values()]` 同理，见 mall.ts 的教训）
  for (const key in weights) {
    if (!Object.prototype.hasOwnProperty.call(weights, key)) continue;
    const weight = Number(weights[key]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    combatCalc.set(key as CombatCalcAttribute, weight);
  }
}
