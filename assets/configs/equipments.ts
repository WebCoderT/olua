import { CommonAttributes, EQUIPMENT_TYPE, OECCUPATION, SEX } from "./game";

export interface Equipment extends CommonAttributes {
  // 装备类型
  type: EQUIPMENT_TYPE;
  // 职业
  occupation: OECCUPATION;
  // 性别
  sex: SEX;
  // 内观
  in: string;
  // 外观
  out: string;
  // 物理攻击
  physicalAttack: [number, number];
  // 魔法攻击
  magicAttack: [number, number];
  // 道术攻击
  taoistAttack: [number, number];
  // 物理防御
  physicalDefense: [number, number];
  // 魔法防御
  magicDefense: [number, number];
  // 道术防御
  taoistDefense: [number, number];
  // 最大血量
  maxHp: number;
}

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
