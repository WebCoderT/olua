import { Equipment, EQUIPMENT_TYPE, Goods, RELATION_SHIP } from "../types/common";
import { clothes } from "./equipments";
import { bagCol, bagRow } from "./game";
import { levelMap } from "./level";

export class Role {
  id: string;
  name: string;
  occupation: string;
  sex: string;
  level: number = 1;
  fashionCloth: number | null = null;
  relationShip: RELATION_SHIP = RELATION_SHIP.SELF;
  avatar: number = 0;
  gold: number = 10000;
  bindGold: number = 10000;
  silver: number = 10000;
  exp: number = 0;
  maxHp: number;
  bag: Array<Array<Goods | null>>;
  equipments: Map<EQUIPMENT_TYPE, Equipment> = new Map();
  constructor(name: string, occupation: string, sex: string) {
    this.id = new Date().getTime().toString();
    this.name = name;
    this.occupation = occupation;
    this.sex = sex;
    this.maxHp = levelMap.get(this.level).maxHp;

    // 初始化背包数据
    this.bag = [];
    for (let row = 0; row < bagRow; row++) {
      this.bag[row] = [];
      for (let col = 0; col < bagCol; col++) {
        this.bag[row][col] = null;
      }
    }
    // 初始化成功后，默认赠送物品
    this.bag[0][0] = clothes[0];
    this.bag[0][1] = clothes[1];

    // 初始化角色装备
    this.equipments.set(EQUIPMENT_TYPE.OTHER1, null);
    this.equipments.set(EQUIPMENT_TYPE.CLOTH, null);
    this.equipments.set(EQUIPMENT_TYPE.OTHER2, null);

    this.equipments.set(EQUIPMENT_TYPE.WEAPON, null);
    this.equipments.set(EQUIPMENT_TYPE.NECKLACE, null);
    this.equipments.set(EQUIPMENT_TYPE.RING, null);
    this.equipments.set(EQUIPMENT_TYPE.ACCESSORIES, null);
    this.equipments.set(EQUIPMENT_TYPE.SHINGUARD, null);

    this.equipments.set(EQUIPMENT_TYPE.HELMET, null);
    this.equipments.set(EQUIPMENT_TYPE.SCAPULAR, null);
    this.equipments.set(EQUIPMENT_TYPE.BELT, null);
    this.equipments.set(EQUIPMENT_TYPE.WRISTBAND, null);
    this.equipments.set(EQUIPMENT_TYPE.SHOES, null);
  }
}
