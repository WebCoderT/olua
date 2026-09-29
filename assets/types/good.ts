import type { BattleAttributes, CommonAttributes } from "./common";
import type { OECCUPATION, SEX } from "./role";
import { Vec2 } from "cc";

// 装备类型
export enum EQUIPMENT_TYPE {
  CLOTH = "cloth", // 衣服
  ACCESSORIES = "accessories", // 饰品
  BELT = "belt", // 腰带
  HELMET = "helmet", // 头盔
  NECKLACE = "necklace", // 项链
  RING = "ring", // 戒指
  SCAPULAR = "scapular", // 肩胛
  SHINGUARD = "shinguard", // 护腿
  SHOES = "shoes", // 鞋子
  WEAPON = "weapon", // 武器
  WRISTBAND = "wristband", // 护腕
  OTHER1 = "other1", // 其他1
  OTHER2 = "other2", // 其他2
}

// 装备槽接口
export interface EquipmentSlot {
  // 名称
  label: string;
  // 图片地址
  imageSrc: string;
  // 插槽位置
  position: "left" | "right" | "bottom" | "custom";
  // 下方特殊插槽为主,当为
  customPosition?: Vec2;
}

// 物品接口
export interface Good extends CommonAttributes {
  // 装备类型
  type: EQUIPMENT_TYPE;
  // 职业
  occupation: OECCUPATION;
  // 性别
  sex: SEX;
  // 内观
  in: string;
  // 内观偏移
  inOffset: Vec2;
  // 外观
  out: string;
}

// 装备接口
export interface Equipment extends Good, BattleAttributes {}

export type Goods = Equipment | Good;
