import { BattleAttributes } from "../types/common";
import { EQUIPMENT_TYPE } from "../types/good";

// 物品显示属性（仅装备，按装备槽位区分）
// 注：hpRecover（每秒回血）只在**会显示最大血量**的部位上列出 —— 回血是由血量派生的属性
// （见 configs/growth 的 equipmentSlotShare.recover），只列攻击三属性的首饰不列它，口径一致
export const goodShowAttributes = new Map<EQUIPMENT_TYPE, Array<keyof BattleAttributes>>();
// 防御
goodShowAttributes.set(EQUIPMENT_TYPE.BELT, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.HELMET, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SCAPULAR, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SHINGUARD, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.SHOES, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.WRISTBAND, ["maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
// 攻击
goodShowAttributes.set(EQUIPMENT_TYPE.WEAPON, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.NECKLACE, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.RING, ["physicalAttack", "magicAttack", "taoistAttack"]);
goodShowAttributes.set(EQUIPMENT_TYPE.ACCESSORIES, ["physicalAttack", "magicAttack", "taoistAttack"]);

// 其他全属性
goodShowAttributes.set(EQUIPMENT_TYPE.CLOTH, ["physicalAttack", "magicAttack", "taoistAttack", "maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.OTHER1, ["physicalAttack", "magicAttack", "taoistAttack", "maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);
goodShowAttributes.set(EQUIPMENT_TYPE.OTHER2, ["physicalAttack", "magicAttack", "taoistAttack", "maxHp", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"]);

// 物品显示属性对应文字
// 这份表的 **key 顺序即「角色信息弹窗 → 基础属性」列表的显示顺序**（见 GameUiHelper.applyRoleAttributeListStyle），
// 新增一条属性只要在这里补一行，角色属性列表与装备详情会同时出现它
export const goodShowAttributesLabel = new Map<keyof BattleAttributes, string>();

goodShowAttributesLabel.set("maxHp", "最大血量");
goodShowAttributesLabel.set("physicalDefense", "物理防御");
goodShowAttributesLabel.set("magicDefense", "魔法防御");
goodShowAttributesLabel.set("taoistDefense", "道术防御");
goodShowAttributesLabel.set("physicalAttack", "物理攻击");
goodShowAttributesLabel.set("magicAttack", "魔法攻击");
goodShowAttributesLabel.set("taoistAttack", "道术攻击");
goodShowAttributesLabel.set("hpRecover", "每秒回血");
