import { Vec2 } from "cc";
import { Equipment, EQUIPMENT_TYPE, EquipmentSlot, GOOD_TYPE } from "../types/good";
import { OECCUPATION, SEX } from "../types/role";

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

// 衣服
export const clothes: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "* 唯一深爱(衣) *",
    sex: SEX.ALL,
    level: 1,
    description: "葬爱家族专属衣服，穿上此装备，开启你的旅程吧！",
    sellPirce: 0,
    icon: "clothes/icon/005",
    in: "clothes/in/005",
    out: "clothes/out/005",
    physicalAttack: [0, 100],
    magicAttack: [0, 100],
    taoistAttack: [0, 100],
    physicalDefense: [0, 50],
    magicDefense: [0, 50],
    taoistDefense: [0, 50],
    maxHp: 3000,
    inPosition: new Vec2(-72.5, 48),
    tags: ["第一大陆"],
    prefix: "葬爱",
    suffix: "魂级",
    inScale: 1.3,
    outScale: 1,
    outPosition: new Vec2(0, 0),
  },
];

// 武器
export const weapons: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.WEAPON,
    occupation: OECCUPATION.ALL,
    label: "武器++++名字还没想好",
    sex: SEX.ALL,
    level: 1,
    description: "武器++++介绍还没想好",
    sellPirce: 0,
    icon: "weapons/icon/001",
    in: "weapons/in/001",
    out: "weapons/out/001",
    physicalAttack: [0, 10],
    magicAttack: [0, 1],
    taoistAttack: [0, 1],
    physicalDefense: [0, 0],
    magicDefense: [0, 0],
    taoistDefense: [0, 0],
    maxHp: 0,
    inPosition: new Vec2(0, 0),
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];

// 戒指
export const rings: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.RING,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手戒指",
    level: 1,
    description: "新手戒指，穿上此装备，开启你的旅程吧！",
    icon: "item/2010210",
    sellPirce: 0,
    physicalAttack: [0, 1],
    magicAttack: [0, 1],
    taoistAttack: [0, 1],
    physicalDefense: [0, 0],
    magicDefense: [0, 0],
    taoistDefense: [0, 0],
    maxHp: 0,
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];

// 项链
export const nicklaces: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.NECKLACE,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手项链",
    level: 1,
    description: "新手项链，穿上此装备，开启你的旅程吧！",
    icon: "item/2010310",
    sellPirce: 0,
    physicalAttack: [0, 1],
    magicAttack: [0, 1],
    taoistAttack: [0, 1],
    physicalDefense: [0, 0],
    magicDefense: [0, 0],
    taoistDefense: [0, 0],
    maxHp: 0,
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];

// 鞋子
export const shoes: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.SHOES,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手鞋子",
    level: 1,
    description: "新手鞋子，穿上此装备，开启你的旅程吧！",
    icon: "item/2030410",
    sellPirce: 0,
    physicalAttack: [0, 0],
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: [0, 5],
    magicDefense: [0, 5],
    taoistDefense: [0, 5],
    maxHp: 5,
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];

// 头盔
export const helmets: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.HELMET,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手头盔",
    level: 1,
    description: "新手头盔，穿上此装备，开启你的旅程吧！",
    icon: "item/2030702",
    sellPirce: 0,
    physicalAttack: [0, 0],
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: [0, 5],
    magicDefense: [0, 5],
    taoistDefense: [0, 5],
    maxHp: 5,
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];

// 腰带
export const belts: Equipment[] = [
  {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.BELT,
    occupation: OECCUPATION.ALL,
    sex: SEX.ALL,
    in: "",
    inPosition: new Vec2(),
    out: "",
    label: "新手腰带",
    level: 1,
    description: "新手腰带，穿上此装备，开启你的旅程吧！",
    icon: "item/2030810",
    sellPirce: 0,
    physicalAttack: [0, 0],
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: [0, 5],
    magicDefense: [0, 5],
    taoistDefense: [0, 5],
    maxHp: 5,
    tags: [],
    prefix: "",
    suffix: "",
    inScale: 1,
    outScale: 1,
    outPosition: new Vec2(),
  },
];
