import { BattleAttributes } from "../types/common";
import { EQUIPMENT_TYPE, Goods } from "../types/good";

// 物品显示属性
export const goodShowAttributes = new Map<Goods["type"], Array<keyof BattleAttributes>>();
// 防御
goodShowAttributes.set(EQUIPMENT_TYPE.CLOTH, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.BELT, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.HELMET, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SCAPULAR, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SHINGUARD, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SHOES, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.WRISTBAND, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
// 攻击
goodShowAttributes.set(EQUIPMENT_TYPE.WEAPON, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.NECKLACE, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.RING, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.ACCESSORIES, ["physicalAttack", "magicAttack", "taoistAttack"]);

// 其他全属性
goodShowAttributes.set(EQUIPMENT_TYPE.OTHER1, ["physicalAttack", "magicAttack", "taoistAttack", "maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);
goodShowAttributes.set(EQUIPMENT_TYPE.OTHER2, ["physicalAttack", "magicAttack", "taoistAttack", "maxHp", "physicalDefense", "magicDefense", "taoistDefense"]);

// 物品显示属性对应文字
export const goodShowAttributesLabel = new Map<keyof BattleAttributes, string>();

goodShowAttributesLabel.set("maxHp", "最大血量");
goodShowAttributesLabel.set("physicalDefense", "物理防御");
goodShowAttributesLabel.set("magicDefense", "魔法防御");
goodShowAttributesLabel.set("taoistDefense", "道术防御");
goodShowAttributesLabel.set("physicalAttack", "物理攻击");
goodShowAttributesLabel.set("magicAttack", "魔法攻击");
goodShowAttributesLabel.set("taoistAttack", "道术攻击");
