import { Size, Vec2, Vec3 } from "cc";

export interface RoleOccupationInfo {
  /** 名称 */
  name: string;
  /** 介绍文字的图片路径 */
  description: string;
  /** 介绍文字的图片尺寸 */
  descriptionSize: Size;
}

// 职业
export enum OECCUPATION {
  /** 战士 */
  ZHAN = "1",
  /** 法师 */
  FA = "2",
  /** 道士 */
  DAO = "3",
  /** 全职业 */
  ALL = "4",
}

// 性别
export enum SEX {
  /** 男 */
  BOY = "1",
  /** 女 */
  GRIL = "2",
  /** 全性别 */
  ALL = "3",
}

// 关系MAP
export enum RELATION_SHIP {
  /** 自己 */
  SELF = "1",
  /** 兄弟 */
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

// 战斗属性接口
export interface BattleAttributes {
  /** 物理攻击 */
  physicalAttack: [number, number];
  /** 魔法攻击 */
  magicAttack: [number, number];
  /** 道术攻击 */
  taoistAttack: [number, number];
  /** 物理防御 */
  physicalDefense: [number, number];
  /** 魔法防御 */
  magicDefense: [number, number];
  /** 道术防御 */
  taoistDefense: [number, number];
  /** 最大血量 */
  maxHp: number;
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

export interface LevelConfig extends BattleAttributes {
  // 等级存储经验
  exp: number;
}

// npc接口
export interface NPC {
  // 名称
  label: string;
  // 地址
  src: string;
  // 放大倍率
  scale?: Vec3;
  // 位置
  position?: Vec3;
  // 点击事件
  onClick?: Function;
}

// 地图编号
export type MapId = "0" | "1";
// 地图类型
export enum MapType {
  // 安全
  SAFE = "0",
  // 测试
  TEST = "9999",
}

// 地图配置接口
export interface MapConfig {
  // 地图名称
  label: string;
  // 地图地址
  src: string;
  // 地图类型
  type: MapType;
}

// 技能类型
export enum SkillType {
  /** 主动技能 */
  PROACTIVE = "0",
  /** 被动技能 */
  PASSIVE = "1",
  /** 状态技能 */
  STATUS = "2",
  /** 回复技能 */
  REPLY = "3",
}

// 技能目标类型
export enum SkillTargetType {
  /** 区域 */
  PLACE = "0",
  /** 单体 */
  SINGLE = "1",
  /** 群体 */
  MUTIPLE = "2",
}

/** 技能伤害计算系数 */
export interface DamageCoefficient {
  /** 基础伤害类型来源 */
  baseType: keyof BattleAttributes;
  /** 基础伤害倍数 */
  baseTypeRate: number;
}

// 技能接口
export interface SkillConfig {
  /** 技能名称 */
  label: string;
  /** 技能图标 */
  icon: string;
  /** 技能冷却时间:秒 */
  cooldown: number;
  /** 技能目标类型 */
  targetType: SkillTargetType;
  /** 技能职业 */
  oeccupation: OECCUPATION;
  /** 技能开启等级 */
  level: number;
  /** 技能描述 */
  description: string;
  /** 技能类型 */
  type: SkillType;
  /** 技能等级与伤害系数 */
  damageCoefficients: DamageCoefficient[];
}

/** 技能ID */
export type SkillId = "1000" | "1001" | "1002" | "1003" | "1004" | "1005" | "1006" | "1007" | "1008" | "1009" | "1010" | "1011";

/** 怪物接口 */
export interface MonsterConfig extends CommonAttributes, BattleAttributes {
  /** 图标 */
  icon: string;
  // 内观
  in: string;
  // 内观偏移
  inOffset: Vec2;
  // 外观
  out: string;
  /** 外观偏移 */
  outOffset: Vec2;
}
