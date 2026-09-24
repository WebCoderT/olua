import { RELATION_SHIP } from "./game";

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
  constructor(name: string, occupation: string, sex: string) {
    this.id = new Date().getTime().toString();
    this.name = name;
    this.occupation = occupation;
    this.sex = sex;
  }
}
