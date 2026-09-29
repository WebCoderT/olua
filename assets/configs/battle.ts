import type { BattleAttributes } from "../types/common";

/** 战斗力计算权重（各战斗属性对战斗力的贡献倍率） */
export const combatCalc = new Map<keyof BattleAttributes, number>();
combatCalc.set("magicAttack", 5);
combatCalc.set("physicalAttack", 5);
combatCalc.set("taoistAttack", 5);
combatCalc.set("magicDefense", 10);
combatCalc.set("physicalDefense", 10);
combatCalc.set("taoistDefense", 10);
combatCalc.set("maxHp", 15);
