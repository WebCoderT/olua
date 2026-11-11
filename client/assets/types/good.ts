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
  MONEY = "money", // 货币道具（使用后直接给账本入账：绑定元宝 / 元宝 / 银子）
  SCROLL = "scroll", // 升级卷轴（使用后硬性 +1 级，带等级区间；#787）
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
   * 武器的位置语义（#509 遗留，**#541 起客户端不再读它**）
   *
   * 外观帧算法已删除：客户端外观（衣服与武器）一律把 `outPositions` 当绝对位置摆，
   * 这个字段只剩数据管道意义（服务端 DTO / apply-snapshot 的基线还原、工作台的保存语义）。
   * 工作台保存时仍默认写 true。
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
   * 衣服与武器都是**绝对位置**（相对角色节点原点 = 脚底锚点，y 向上，#541）：
   * 真值由服务端 `game-config/equip-align` 每次进图下发（或工作台定稿后烧回出厂配置）；
   * 出厂配置里留 0 = 未对齐占位。
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
 * prefix/suffix/recyclePrice **可以**写在条目里（#655）：服务端快照下发的是
 * 展开后的全部变体，每一行自带序号与最终回收价，客户端直接建表、不再乘倍率。
 * 工具链（`applyEquipmentSeed`，只给生成器与单测沙箱用）仍然传「基础件」，由
 * `buildEquipmentMap` 按倍率展开 —— 那条路只在 Node 里跑，不进游戏。
 */
export type EquipmentData = Omit<Equipment, keyof BattleAttributes | "prefix" | "suffix" | "recyclePrice"> &
  Partial<BattleAttributes> & {
    key: string;
    recyclePrice?: number;
    /** 前缀序号（0 = 普通的）；服务端变体行必带，种子行不带 */
    prefix?: Equipment["prefix"];
    /** 后缀序号（0 = 人级）；同上 */
    suffix?: Equipment["suffix"];
  };

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

/**
 * 货币道具（#785）：使用后直接给角色账本入账
 *
 * 与药品是两条链路：不结算血蓝，而是把 `amount` 加到 `currency` 对应的账本字段上
 * （服务端 `role.moneyUse`，金额读库里的表 —— 客户端这两个字段只用于陈列与提示）。
 */
export interface MoneyItem extends Good {
  type: GOOD_TYPE.MONEY;
  /** 入账到哪个账本字段：bindGold（绑定元宝，唯一货币） */
  currency: MoneyCurrency;
  /** 单件入账金额 */
  amount: number;
}

/** 货币（唯一 bindGold；#843/#844 收敛后 gold / silver 已删。与角色存档的账本字段同名，服务端 `SERVER_LEDGER_FIELDS` 是同一份） */
export type MoneyCurrency = "bindGold";

/**
 * 升级卷轴（#787）：使用后**硬性 +1 级**，带等级区间
 *
 * 与服务端是两条链路：不结算经验（等级 +1 不看 `exp` 够不够），也不进账本。
 * `minLevel` / `maxLevel` 只用于**本地预检与详情展示**（能不能用、该换哪一卷），
 * 真正的判定与 +1 在服务端（`role.levelScrollUse`，读库）—— 客户端这份是快照的副本。
 */
export interface LevelScroll extends Good {
  type: GOOD_TYPE.SCROLL;
  /** 可用等级下限（含） */
  minLevel: number;
  /** 可用等级上限（含）：用完这一卷就超出这段，要换下一卷 */
  maxLevel: number;
}

/** 材料（合成/任务等用途） */
export interface Material extends Good {
  type: GOOD_TYPE.MATERIAL;
}

export type Goods = Equipment | Drug | Material | MoneyItem | LevelScroll;

/**
 * 背包格子：只存物品 key 与数量，物品数据经 configs/items 实时解析
 * （改物品配置后重启即生效，无需重新拾取）
 */
/** 掉落溯源里两项文字的最大长度（与服务端 `BAG_ORIGIN_TEXT_MAX` 同数） */
export const BAG_ORIGIN_TEXT_MAX = 64;

/**
 * 掉落溯源（只有装备会有，见 `BagCell.from`）
 *
 * 记的是掉落**当时**的事实：角色改名、怪物改配置都不会追改这里，
 * 详情弹窗里显示的就是「这件是我打那只怪掉的」。
 */
export interface BagOrigin {
  /** 击杀者角色名 */
  role?: string;
  /** 怪物 key（用怪物配置翻成中文名；未知 key 直接显示 key） */
  monster?: string;
  /** 掉落时间（毫秒时间戳） */
  at?: number;
}

export interface BagCell {
  /** 物品 id（configs/items 总表的 key） */
  id: string;
  /** 数量（不可叠加物品恒为 1） */
  count: number;
  /**
   * **绑定角色**（不可交易）。由服务端在掉落时判定写入，客户端只读：
   * 搬运 / 整理时原样带回（服务端会拿它验守恒，缺省 = 未绑定），但不能凭空改。
   */
  bound?: boolean;
  /** 掉落溯源，只有装备会有（用户口径：其他物品只按是否绑定分成两种） */
  from?: BagOrigin;
}

/**
 * 一件穿在身上的装备（#816：装备槽不再只存裸 id）
 *
 * 为什么要带元数据：`bound` / `from` 是**这件东西的属性**，不是「背包格子的属性」。
 * 槽位只存 id 时，穿上去那一刻绑定与溯源就丢了 —— 脱下来变成一件未绑定、无溯源的新东西
 * （五瓶绑定药用到剩一瓶就变可交易，是同一个病的背包版，#789 修的是背包那一半）。
 *
 * 字段口径与 `BagCell` 完全一致（同一个 `BagOrigin`、同样缺省即未绑定），因为穿脱就是
 * 「背包格子 ↔ 槽位」之间搬运：**搬运不许改值，只许换地方**。
 * 客户端只读不判定（服务端在穿脱时搬这份元数据，见 server `role-inventory.ts`）。
 */
export interface WornItem {
  /** 装备 id（configs/items 总表的 key） */
  id: string;
  /** 绑定角色（缺省 = 未绑定） */
  bound?: boolean;
  /** 掉落溯源（只有装备会有） */
  from?: BagOrigin;
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

/** 是否为货币道具 */
export function isMoneyItem(good: Goods): good is MoneyItem {
  return good.type === GOOD_TYPE.MONEY;
}

/** 是否为升级卷轴（#787：使用后硬性 +1 级） */
export function isLevelScroll(good: Goods): good is LevelScroll {
  return good.type === GOOD_TYPE.SCROLL;
}

/** 获取物品数量（不可叠加物品恒为 1） */
export function getGoodCount(good: Goods): number {
  return good.stackable ? Math.max(1, good.count ?? 1) : 1;
}
