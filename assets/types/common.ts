import { Size, Vec2 } from "cc";

export interface RoleOccupationInfo {
  name: string;
  // 介绍文字的图片路径
  description: string;
  // 介绍文字的图片尺寸
  descriptionSize: Size;
}

// 职业
export enum OECCUPATION {
  ZHAN = "1",
  FA = "2",
  DAO = "3",
}

// 性别
export enum SEX {
  BOY = "1",
  GRIL = "2",
}

// 关系MAP
export enum RELATION_SHIP {
  SELF = "1",
  BROTHER = "2",
}

// 8方向：地图或角色朝向的八个离散方向编码
export enum ROLE_DIRECTION {
  // 上
  UP = "up",
  // 右上
  RIGHT_UP = "right_up",
  // 右
  RIGHT = "right",
  // 右下
  RIGHT_DOWN = "right_down",
  // 下
  DOWN = "down",
  // 左下
  LEFT_DOWN = "left_down",
  // 左
  LEFT = "left",
  // 左上
  LEFT_UP = "left_up",
}

// 动作：角色或NPC可能的动作状态，用以控制动画与移动逻辑
export enum ROLE_ACTION {
  // 站立
  STAND = "stand",
  // 走路
  WALK = "walk",
  // 跑动
  RUN = "run",
}

// 物品类型
export enum GOOD_TYPE {
  GOLD = "gold", // 金
}

// 游戏中的所有基础属性
export interface CommonAttributes {
  // 名称
  label: string;
  // 等级
  level: number;
  // 介绍
  description: string;
  // 图标
  icon: string;
  // 出售价格
  sellPirce: number;
}

export interface LevelConfig {
  // 等级存储经验
  exp: number;
  // 等级基础最大血量
  maxHp: number;
  // 等级基础物理攻击
  // 等级基础魔法攻击
  // 等级基础道术攻击
  // 等级基础物理防御
  // 等级基础魔法防御
  // 等级基础道术防御
}

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

// 装备接口
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

export type Goods = Equipment;
