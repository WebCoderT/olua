import { BattleAttributes, EQUIPMENT_TYPE, Goods } from "../types/common";

// 物品显示属性
export const goodShowAttributes = new Map<Goods["type"], Array<keyof BattleAttributes>>();

goodShowAttributes.set(EQUIPMENT_TYPE.CLOTH, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.WEAPON, ["physicalAttack", "magicAttack", "taoistAttack"]);

// 物品显示属性对应文字
export const goodShowAttributesLabel = new Map<keyof BattleAttributes, string>();

goodShowAttributesLabel.set("maxHp", "最大血量");
goodShowAttributesLabel.set("physicalDefense", "物理防御");
goodShowAttributesLabel.set("magicDefense", "魔法防御");
goodShowAttributesLabel.set("taoistDefense", "道术防御");
goodShowAttributesLabel.set("physicalAttack", "物理攻击");
goodShowAttributesLabel.set("magicAttack", "魔法攻击");
goodShowAttributesLabel.set("taoistAttack", "道术攻击");
