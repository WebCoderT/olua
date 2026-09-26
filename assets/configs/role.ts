import { Equipment, clothes } from "./equipments";
import { bagCol, bagRow } from "./game";
import { RELATION_SHIP } from "./game";
import { levelMap } from "./level";

export interface Role {
  // 编号
  id: string;
  // 名称
  name: string;
  // 职业
  occupation: string;
  // 性别
  sex: string;
  // 等级
  level: number;
  // 经验
  exp: number;
  // 最大血量
  maxHp: number;
  // 关系
  relationShip: RELATION_SHIP;
  // 头像
  avatar: number;
  // 金币(元宝)
  gold: number;
  // 绑定金币(绑定元宝)
  bindGold: number;
  // 银子
  silver: number;
  // 角色衣服-时装
  fashionCloth: number | null;
  // 背包
  bag: Array<Array<Equipment | null>>;
}

export class Role implements Role {
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
  bag: Equipment[][];
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
  }
}
