import { Size } from "cc";
import { Equipment, EQUIPMENT_TYPE, EquipmentSlot, OECCUPATION, SEX } from "../types/common";

// 角色弹窗中装备槽map
export const equipmentSlots = new Map<EQUIPMENT_TYPE, EquipmentSlot>();
equipmentSlots.set(EQUIPMENT_TYPE.OTHER1, { label: "其他1", imageSrc: "slots/other", position: "bottom" });
equipmentSlots.set(EQUIPMENT_TYPE.CLOTH, { label: "衣服", imageSrc: "slots/cloth", position: "bottom" });
equipmentSlots.set(EQUIPMENT_TYPE.OTHER2, { label: "其他2", imageSrc: "slots/other", position: "bottom" });

equipmentSlots.set(EQUIPMENT_TYPE.WEAPON, { label: "武器", imageSrc: "slots/weapon", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.NECKLACE, { label: "项链", imageSrc: "slots/necklace", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.RING, { label: "戒指", imageSrc: "slots/ring", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.ACCESSORIES, { label: "饰品", imageSrc: "slots/accessories", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.SHINGUARD, { label: "护腿", imageSrc: "slots/shinguard", position: "left" });

equipmentSlots.set(EQUIPMENT_TYPE.HELMET, { label: "头盔", imageSrc: "slots/helmet", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.SCAPULAR, { label: "肩胛", imageSrc: "slots/scapular", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.BELT, { label: "腰带", imageSrc: "slots/belt", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.WRISTBAND, { label: "护腕", imageSrc: "slots/wristband", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.SHOES, { label: "鞋子", imageSrc: "slots/shoes", position: "right" });

// 物品详情弹窗尺寸
export const goodsDialogSize = new Map<EQUIPMENT_TYPE, Size>();
goodsDialogSize.set(EQUIPMENT_TYPE.CLOTH, new Size(240, 400));

export const clothes: Equipment[] = [
  {
    type: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ZHAN,
    label: "新手赠送-梁山伯&祝英台",
    sex: SEX.BOY,
    level: 1,
    description: "新手赠送衣服，穿上此装备，开启你的旅程吧！",
    sellPirce: 0,
    icon: "clothes/icon/1/1",
    in: "clothes/in/1/1",
    out: "clothes/out/1/1",
    physicalAttack: [0, 10],
    magicAttack: [0, 1],
    taoistAttack: [0, 1],
    physicalDefense: [0, 10],
    magicDefense: [0, 10],
    taoistDefense: [0, 10],
    maxHp: 100,
  },
  {
    type: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ZHAN,
    label: "新手赠送-梁山伯&祝英台",
    sex: SEX.GRIL,
    level: 1,
    description: "新手赠送衣服，穿上此装备，开启你的旅程吧！",
    sellPirce: 0,
    icon: "clothes/icon/1/2",
    in: "clothes/in/1/2",
    out: "clothes/out/1/2",
    physicalAttack: [0, 10],
    magicAttack: [0, 1],
    taoistAttack: [0, 1],
    physicalDefense: [0, 10],
    magicDefense: [0, 10],
    taoistDefense: [0, 10],
    maxHp: 100,
  },
];
