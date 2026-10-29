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

/**
 * 装备前缀（品质）：数值即强度序号。
 * 属性倍率见 configs/growth 的 equipmentPrefixRates，文案/颜色见 configs/equipments。
 * 名称与文字颜色随前缀变化（后缀只影响自己的颜色）。
 */
export enum EQUIPMENT_PREFIX {
  /** 普通的（×1.0） */
  NORMAL = 0,
  /** 强化的（×1.1） */
  STRENGTHENED = 1,
  /** 精良的（×1.2） */
  FINE = 2,
  /** 极品的（×1.3） */
  SUPERB = 3,
  /** 超神的（×1.4） */
  GODLY = 4,
}

/** 装备后缀（阶级）：数值即强度序号，属性倍率见 configs/growth 的 equipmentSuffixRates */
export enum EQUIPMENT_SUFFIX {
  /** 人级（×1.0） */
  MORTAL = 0,
  /** 天级（×2.0） */
  HEAVEN = 1,
  /** 神级（×3.0） */
  GODLY = 2,
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

/**
 * 外观变换（装备与角色默认外观共用）
 *
 * 应用在**外观节点**上的缩放与按方向的位置。Equipment 与 configs/role 的 RoleDefaultCloth 都满足它，
 * 于是「穿上衣服 / 脱下衣服回退默认身体」在 ui/components/role/RoleAppearance 里走的是同一套代码。
 */
export interface OutTransform {
  /** 外观缩放（缺省 1） */
  outScale?: number;
  /**
   * 外观位置（按 8 方向各一个）
   * 数组下标顺序与 configs/animation 的 directions 一致：
   * up / right_up / right / right_down / down / left_down / left / left_up
   * 坐标为相对角色节点原点（脚底锚点）的偏移，y 向上；缺省原位
   */
  outPositions?: Vec2[];
  /**
   * 武器的位置语义（#509）：true = `outPositions` 是**绝对位置**，false/缺省 = 运行时按身体帧自动算
   *
   * 衣服与裸模一直是绝对位置，不看这个字段。武器之所以要开关：自动算法在素材裁剪留白、
   * 影子、身体比例差异大的情况下会偏（见 #505 / #509 的比对结论），
   * 由管理端「装备对齐」工作台逐件调过的武器置 true，没调的继续走自动算法 ——
   * 渐进替换，不会一次把 20 把武器全部推到原点。
   */
  outManual?: boolean;
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
  /**
   * 内观位置（衣服 = 身体在弹窗里的落点）
   *
   * 弹窗坐标系（原点 = 弹窗中心，y 向上），锚点是**节点中心**（画布中心，见 `inScaleX` 的说明）。
   * 衣服一直读它；武器只在 `inManual = true` 时读它，否则由 RoleInShowView 按身体内容 bbox 现算
   * （历史原因：20 把武器 20 组手调数字对不上任何一件身体，见 #505 的比对结论）。
   * 这两条数字都可以由管理端「内观对齐」工作台（#523）覆盖，客户端进游戏时拉一次。
   */
  inPosition: Vec2;
  /**
   * 武器内观的位置语义（#523）：true = `inPosition` / `inScaleX` / `inScaleY` 是**最终值**，
   * false / 缺省 = 运行时按当前衣服的内容 bbox 自动算（#505 的算法）
   *
   * 与外观的 `outManual` 同一个套路：工作台调过的武器置 true，没调的继续走自动算 ——
   * 渐进替换，不会一次把 19 把武器全部推到原点。衣服不看这个字段（它一直是绝对位置）。
   */
  inManual?: boolean;
  /** 外观缩放 */
  outScale: number;
  /**
   * 外观位置（按 8 方向各一个）
   * 数组下标顺序与 configs/animation 的 directions 一致：
   * up / right_up / right / right_down / down / left_down / left / left_up
   * 衣服：相对角色节点原点（脚底锚点）的偏移，y 向上 —— **身体站哪儿就是它**；
   * 武器：只当**微调**（默认 0），实际位置由 RoleAppearance.applyWeaponTransform 贴着当前身体帧现算。
   */
  outPositions: Vec2[];
  // 外观
  out: string;
  /** 标签 */
  tags: string[];
  /** 前缀（品质，决定名称/前缀文字颜色与属性倍率） */
  prefix: EQUIPMENT_PREFIX;
  /** 后缀（阶级，只决定后缀文字颜色，另有独立属性倍率） */
  suffix: EQUIPMENT_SUFFIX;
  /**
   * 回收价格，货币是**绑定元宝**（背包「一键回收」按它结算，见 ui/core/StorageManager.recycleBagEquipments）
   *
   * 默认值 = 按装备自己的 level 从配置曲线取（configs/growth.equipmentRecyclePrice），
   * 再乘前后缀倍率（普通·人级 = 基础价，超神·神级 = 4.2 倍），在 configs/equipments.buildEquipmentMap 里生成。
   * 想整体调价改那条曲线；想给某件装备单独定价，就在它的条目里写 recyclePrice（覆盖生成值）。
   */
  recyclePrice: number;
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
 *
 * prefix/suffix/recyclePrice 不在条目里配置：
 * prefix/suffix 由构建时按「前缀 × 后缀」全组合展开（基础件即「普通的·人级」，沿用原 key），见 configs/equipments；
 * recyclePrice 的缺省值按 level 从 configs/growth 的回收价曲线生成（想给某件装备单独定价才写它）。
 */
export type EquipmentData = Omit<Equipment, keyof BattleAttributes | "prefix" | "suffix" | "recyclePrice"> &
  Partial<BattleAttributes> & { key: string; recyclePrice?: number };

/** 药品使用效果（新增效果类型时在此扩展） */
export interface DrugEffect {
  /** 恢复血量（固定值） */
  hp?: number;
  /** 恢复魔法（固定值） */
  mp?: number;
  /** 按角色 maxHp 的百分比回复血量（整数，50 = 50%；与 hp 可同条共存，各自生效） */
  hpPercent?: number;
  /** 按角色 maxMp 的百分比回复魔法（整数，50 = 50%；与 mp 可同条共存，各自生效） */
  mpPercent?: number;
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

/** 背包格子的行列坐标（拖动落点、跨格搬运都用它定位） */
export interface BagCellPos {
  row: number;
  col: number;
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
