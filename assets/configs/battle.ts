import type { BattleAttributes } from "../types/common";

/**
 * 计入战斗力的属性
 *
 * hpRecover（每秒回血）**不算战斗力**：战斗力是地图准入的门槛（configs/map 的 combat），
 * 它是「能不能扛住 / 打不打得动」的综合刻度，而回血是持续回复、不改变输出与承伤上限；
 * 把它算进来会凭空抬高所有地图的门槛（回血量的量级只有血量的 1%，十级以上的地图就得重调）。
 */
export type CombatCalcAttribute = Exclude<keyof BattleAttributes, "hpRecover">;

/** 战斗力计算权重（各战斗属性对战斗力的贡献倍率；区间型属性取区间上下限之和） */
export const combatCalc = new Map<CombatCalcAttribute, number>();
combatCalc.set("magicAttack", 5);
combatCalc.set("physicalAttack", 5);
combatCalc.set("taoistAttack", 5);
combatCalc.set("magicDefense", 10);
combatCalc.set("physicalDefense", 10);
combatCalc.set("taoistDefense", 10);
combatCalc.set("maxHp", 15);
