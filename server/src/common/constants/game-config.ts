/**
 * 养成配置（称号 / 战魂）的共享常量
 *
 * 称号与战魂的**等级序列是固定的**（客户端 configs 定义外观与等级数，服务端 seed 时落库），
 * 后台只允许改内容、不允许增删行 —— 所以这里没有「创建」语义需要的任何常量。
 */

/** 称号的获得渠道（`titles.acquire_channel` 列的取值域） */
export const AcquireChannel = {
  /** 称号升级：玩家花费绑定元宝逐级购买（升级价格即 `bind_gold` 列） */
  UPGRADE: "upgrade",
  /** 系统赠送：由运营活动 / 里程碑等系统行为发放（**发放逻辑暂未实现**，只是先把渠道标出来） */
  GRANT: "grant",
  /** 无法获取：暂不放出的称号（**seed 后的默认值**——先让全部存量称号保持原状，由运营逐个开放） */
  UNAVAILABLE: "unavailable",
} as const;

export type AcquireChannelValue = (typeof AcquireChannel)[keyof typeof AcquireChannel];

/** 全部渠道（DTO 枚举校验用） */
export const ACQUIRE_CHANNELS: AcquireChannelValue[] = Object.values(AcquireChannel);

/** 渠道中文名（管理端界面与接口文档用） */
export const ACQUIRE_CHANNEL_LABELS: Record<AcquireChannelValue, string> = {
  [AcquireChannel.UPGRADE]: "称号升级",
  [AcquireChannel.GRANT]: "系统赠送",
  [AcquireChannel.UNAVAILABLE]: "无法获取",
};

// —— 成长曲线（#256）——

import { COMBAT_RANGE_KEYS, COMBAT_SINGLE_KEYS, GROWTH_CURVES } from "../../shared/game-data.generated";

/**
 * 成长曲线键清单（**派生**自生成物的 GROWTH_CURVES，不许手写字面量清单 ——
 * 客户端 configs/growth 增删曲线，这里与服务端校验自动跟着变）
 */
export const GROWTH_CURVE_KEYS = Object.keys(GROWTH_CURVES);

/**
 * 成长标量参数的取值域（键 → 约束）
 *
 * `min` / `max` 拦住明显拍错的值（把回血率写成 100、把等级上限写成 0 这类）；
 * `integer` 标记该键必须是整数。曲线分段自身的连续性校验在 service（跨行约束）。
 */
export interface GrowthScalarSpec {
  min: number;
  max: number;
  /** 必须是整数（等级上限、击杀数这类）；小数参数（比率）为 false */
  integer: boolean;
}

export const GROWTH_SCALAR_SPECS: Record<string, GrowthScalarSpec> = {
  "roleMaxLevel": { min: 1, max: 200, integer: true },
  "attributeRange.minRate": { min: 0, max: 1, integer: false },
  "attributeRange.mpRate": { min: 0, max: 10, integer: false },
  "attributeRange.hpRecoverRate": { min: 0, max: 1, integer: false },
  "expGain.expPerLevel": { min: 1, max: 100000, integer: true },
  "expGain.maxLevelGap": { min: 0, max: 100, integer: true },
};

/** 标量参数的中文说明（管理端列表直接展示；键必须与 GROWTH_SCALARS 一致） */
export const GROWTH_SCALAR_DESCRIPTIONS: Record<string, string> = {
  "roleMaxLevel": "角色等级上限（四条曲线的最后一段必须正好覆盖到它）",
  "attributeRange.minRate": "属性取值下限倍率：实际值在 [上限×minRate, 上限] 之间随机",
  "attributeRange.mpRate": "最大魔法值 = 最大生命 × 该值",
  "attributeRange.hpRecoverRate": "每秒回血 = 最大生命 × 该值（回血的唯一强度入口）",
  "expGain.expPerLevel": "每级基准经验：同级击杀经验 = (怪物等级+1) × 该值",
  "expGain.maxLevelGap": "角色与怪物等级差达到该值（含）后不再获得经验",
};

/**
 * 物品大类取值清单（与客户端 types/good.ts 的 GOOD_TYPE 枚举逐值一致；同 AcquireChannel，
 * 属结构常量住在服务端常量层，不派生自快照 —— 快照 ITEM_TYPES 只反映「配置里出现过的值」，
 * 而筛选取值域要与客户端枚举全集一致：other 当前无条目，筛它返回空列表是正确行为）
 */
export const GOOD_TYPE_VALUES = ["equipment", "drug", "material", "other"];

// —— 技能与状态（#367）——

/**
 * 技能 / 状态的归属（`skills.owner` / `statuses.owner` 列的取值域）
 *
 * 角色与怪物共用同一张表：技能对两边完全同构（一个动作 + 一套倍率，或一段状态），
 * 分表只会让「同一个技能既给人又给怪」变成复制两份、还必然漂移。
 */
export const SkillOwner = {
  /** 角色技能（seed 自生成物 SKILLS；id 被技能栏 / 快捷键 / 角色存档引用） */
  ROLE: "role",
  /** 怪物技能（#12 主体那一刀接管增删） */
  MONSTER: "monster",
} as const;

export type SkillOwnerValue = (typeof SkillOwner)[keyof typeof SkillOwner];

/** 全部归属（筛选项与 DTO 枚举校验用） */
export const SKILL_OWNER_VALUES: SkillOwnerValue[] = Object.values(SkillOwner);

/** 归属中文名（管理端界面与接口文档用） */
export const SKILL_OWNER_LABELS: Record<SkillOwnerValue, string> = {
  [SkillOwner.ROLE]: "角色",
  [SkillOwner.MONSTER]: "怪物",
};

/**
 * 技能分类（= 客户端 `types/skill.SkillType` 的枚举值，**逐值一致**）
 *
 * 客户端按这个值决定「怎么放」：0 主动（走一次伤害结算）/ 1 被动 / 2 状态（给自己挂状态）/
 * 3 回复。这里不另起一套语义 —— 存客户端原值，下发时就是原样覆写，少一层映射少一处漂移。
 */
export const SKILL_CATEGORY_VALUES = ["0", "1", "2", "3"];

/** 技能分类中文名（与客户端 skillTypeLabels 一致） */
export const SKILL_CATEGORY_LABELS: Record<string, string> = {
  "0": "主动",
  "1": "被动",
  "2": "状态",
  "3": "回复",
};

/** 目标类型（= 客户端 `types/skill.SkillTargetType` 的枚举值：区域 / 单体 / 群体 / 自身） */
export const SKILL_TARGET_TYPE_VALUES = ["0", "1", "2", "3"];

/** 目标类型中文名（与客户端 skillTargetTypeLabels 一致） */
export const SKILL_TARGET_TYPE_LABELS: Record<string, string> = {
  "0": "区域",
  "1": "单体",
  "2": "群体",
  "3": "自身",
};

/** 状态来源（= 客户端 `types/status.StatusSource` 的枚举值） */
export const STATUS_SOURCE_VALUES = ["skill", "equipment", "privilege", "other"];

/** 状态来源中文名 */
export const STATUS_SOURCE_LABELS: Record<string, string> = {
  skill: "技能",
  equipment: "装备",
  privilege: "特权",
  other: "其他",
};

/**
 * 伤害系数的基数类型取值域（= 客户端 `BattleAttributes` 的键）
 *
 * 技能倍率只能乘在战斗属性上，所以从生成物的两份键清单拼 —— 与角色属性汇总同一来源，
 * 客户端加一个属性这里自动跟上。
 */
export const DAMAGE_BASE_TYPES: string[] = [...COMBAT_SINGLE_KEYS, ...COMBAT_RANGE_KEYS];
