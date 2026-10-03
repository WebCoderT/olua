import type { BattleAttributes, CommonAttributes } from "./common";
import type { OECCUPATION, SEX } from "./role";
import { Vec2 } from "cc";

/**
 * 物品大类
 * 新增物品类型时：
 * 1. 在此扩展枚举，并实现对应接口（接口统一继承 Good）
 * 2. 在 configs/items 注册该类型的配置来源
 * 3. 若该类型有「使用行为」，在 StorageManager.useGood 中补一条分发分支并实现对应的 useXxx
 */
export enum GOOD_TYPE {
  EQUIPMENT = "equipment", // 装备
  DRUG = "drug", // 药品
  MATERIAL = "material", // 材料
  OTHER = "other", // 其他
}

/** 装备槽位类型 */
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

/** 装备槽接口 */
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

/** 物品通用属性（所有物品共有） */
export interface Good extends CommonAttributes {
  /** 物品 id（物品总表 configs/items 的键，缺省由注册表按类别+序号生成） */
  id?: string;
  /** 物品大类 */
  type: GOOD_TYPE;
  /** 是否可叠加（药品/材料等）；缺省表示不可叠加（装备） */
  stackable?: boolean;
  /** 最大叠加数量（可叠加时有效，缺省 99） */
  maxStack?: number;
  /** 当前数量（运行时字段，仅背包/掉落物使用，缺省 1） */
  count?: number;
}

/** 装备 */
export interface Equipment extends Good, BattleAttributes {
  type: GOOD_TYPE.EQUIPMENT;
  /** 装备槽位 */
  slot: EQUIPMENT_TYPE;
  // 职业
  occupation: OECCUPATION;
  // 性别
  sex: SEX;
  // 内观
  in: string;
  /** 内观横向缩放（缺省 1） */
  inScaleX?: number;
  /** 内观纵向缩放（缺省 1） */
  inScaleY?: number;
  /** 内观旋转角度（度，缺省 0） */
  inRotate?: number;
  // 内观位置
  inPosition: Vec2;
  /** 外观缩放 */
  outScale: number;
  /**
   * 外观位置（按 8 方向各一个）
   * 数组下标顺序与 configs/animation 的 directions 一致：
   * up / right_up / right / right_down / down / left_down / left / left_up
   * 坐标为相对角色节点原点（脚底锚点）的偏移，y 向上
   */
  outPositions: Vec2[];
  // 外观
  out: string;
  /** 标签 */
  tags: string[];
  /** 前缀 */
  prefix: string;
  /** 后缀 */
  suffix: string;
}

/**
 * 装备配置数据（configs/equipments 里的条目形态）
 *
 * **key 只做关联**：背包 / 掉落表 / 职业初始装备都用它引用同一件装备；
 * key 可以是任意字符串（不要求是数字，例如 "cloth_fire"），也不参与任何数值计算。
 * 数值一律按 level（配合 slot）从 configs/growth 的装备曲线派生。
 *
 * 战斗属性是**可选**的：不写就由 equipmentStats(level, slot) 按等级生成，
 * 写了就覆盖生成值（要单独给某件装备加特例时用）。
 */
export type EquipmentData = Omit<Equipment, keyof BattleAttributes> & Partial<BattleAttributes> & { key: string };

/** 药品使用效果（新增效果类型时在此扩展） */
export interface DrugEffect {
  /** 恢复血量 */
  hp?: number;
  /** 恢复魔法 */
  mp?: number;
  /** 持续时间（秒），增益类效果使用 */
  duration?: number;
}

/** 药品 */
export interface Drug extends Good {
  type: GOOD_TYPE.DRUG;
  /** 使用效果（可多项叠加） */
  effects: DrugEffect[];
  /** 使用冷却（秒），缺省无冷却 */
  cooldown?: number;
}

/** 材料（合成/任务等用途） */
export interface Material extends Good {
  type: GOOD_TYPE.MATERIAL;
}

export type Goods = Equipment | Drug | Material;

/**
 * 背包格子：只存物品 key 与数量，物品数据经 configs/items 实时解析
 * （改物品配置后重启即生效，无需重新拾取）
 */
export interface BagCell {
  /** 物品 id（configs/items 总表的 key） */
  id: string;
  /** 数量（不可叠加物品恒为 1） */
  count: number;
}

/** 是否为装备 */
export function isEquipment(good: Goods): good is Equipment {
  return good.type === GOOD_TYPE.EQUIPMENT;
}

/** 是否为药品 */
export function isDrug(good: Goods): good is Drug {
  return good.type === GOOD_TYPE.DRUG;
}

/** 获取物品数量（不可叠加物品恒为 1） */
export function getGoodCount(good: Goods): number {
  return good.stackable ? Math.max(1, good.count ?? 1) : 1;
}
