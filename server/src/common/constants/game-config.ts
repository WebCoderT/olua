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

// —— 成长参数（#256 / #655）——

import { COMBAT_RANGE_KEYS, COMBAT_SINGLE_KEYS } from "./game-enums";

/**
 * 成长标量参数的取值域（键 → 约束）
 *
 * `min` / `max` 拦住明显拍错的值（把经验基数写成 0、把等级上限写成 0 这类）；
 * `integer` 标记该键必须是整数。
 *
 * **只收「全线一个数」的全局参数**：#655 起每级属性 / 回血 / 魔法上限都是 `role_levels`
 * 逐条配好的列，`attributeRange.*` 那三个换算比率已经没有消费方，随曲线一起下架了。
 */
export interface GrowthScalarSpec {
  min: number;
  max: number;
  /** 必须是整数（等级上限、击杀数这类）；小数参数（比率）为 false */
  integer: boolean;
}

export const GROWTH_SCALAR_SPECS: Record<string, GrowthScalarSpec> = {
  // #786：等级改回曲线后没有「表里几行」的物理上限，100 万只是出厂值，留十倍余量给运营
  "roleMaxLevel": { min: 1, max: 10000000, integer: true },
  "expGain.expPerLevel": { min: 1, max: 100000, integer: true },
  "expGain.maxLevelGap": { min: 0, max: 100, integer: true },
  // 允许小数：回复是「每秒 N 点 × 经过秒数」累加的，0.5 这种半速配置是合法需求（#605）
  "mpRecoverPerSecond": { min: 0, max: 1000, integer: false },
  // 泡点活动（#722）：rate=0 是合法且是出厂值 —— 活动默认关闭，运营在管理端开
  "soakExpPerTick": { min: 0, max: 1000000, integer: true },
  "soakTickSeconds": { min: 1, max: 3600, integer: true },
  // 暴击（#826）：两个都是角色基础值，技能自带的暴击在 skills.crit_rate / crit_damage 上
  "critRate": { min: 0, max: 1, integer: false },
  "critDamage": { min: 0, max: 10, integer: false },
  // 属性点（#833）：每点加成系数与洗点花费。系数四项共用一个键（见 attr-points.util 的文件头），
  // 上限 5 是防手滑 —— 写个 100 就让「堆一项」直接顶满面板
  "attrPointRatio": { min: 0, max: 5, integer: false },
  "attrResetCost": { min: 0, max: 1000000, integer: true },
};

/** 标量参数的中文说明（管理端列表直接展示；键必须与 GROWTH_SCALARS 一致） */
export const GROWTH_SCALAR_DESCRIPTIONS: Record<string, string> = {
  "roleMaxLevel": "角色等级上限（1..10000000）。改它会把四条曲线的末段结束等级一起拉过去；超过末段的等级按该段公式外推",
  "expGain.expPerLevel": "每级基准经验：同级击杀经验 = (怪物等级+1) × 该值",
  "expGain.maxLevelGap": "角色与怪物等级差达到该值（含）后不再获得经验",
  "mpRecoverPerSecond": "魔法值自然回复速度（点 / 秒，0 = 关闭自然回蓝；由服务端结算，客户端读快照同步）",
  "soakExpPerTick": "泡点活动：在线角色每拍获得的经验（0 = 活动关闭；服务端定时发放，走击杀同一套升级链路）",
  "soakTickSeconds": "泡点活动：发经验的拍间隔（秒；与上一条配合出「每 M 秒发 N 点」的速率）",
  "critRate": "角色基础暴击率（0~1；与技能自带的暴击率**相加**。出厂 0 = 新号不暴击）",
  "critDamage": "角色基础暴击倍率（> 1 才生效；技能配了自己的倍率时以技能为准。出厂 1.5 倍）",
  "attrPointRatio":
    "属性点：每点加成系数（出厂 0.005 = 每点 0.5%）。力量→物攻、体质→生命+物防、精神→法攻+道攻+法力按**等级曲线基础值**的百分比放大；敏捷→暴击率按**绝对百分点**加（0.005 = +0.5%）",
  "attrResetCost": "属性点：洗点花费的绑定元宝（0 = 免费洗点。四维归零、已分配点数全部退还）",
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

/**
 * 技能的职业归属（= 客户端 `types/role.OECCUPATION` 的枚举值，**逐值一致**）
 *
 * #603 第十一域起跟着技能行入库：客户端技能栏按这一列重建「职业 → 技能」映射,
 * 所以它是「这个技能归谁」的唯一来源（以前那份手写映射已删）。
 * 注意 4 = **全职业**（不是「第四个职业」）。
 *
 * 取值域与中文名都**不在这里定义**：职业码清单与名字的唯一来源是公共数据
 * `shared/game-data` 的 `ROLE_OCCUPATION_CODES` / `OCCUPATION_LABELS`（由客户端
 * `configs/role.occupations` 生成）—— 在这里再写一遍就是「客户端加了个职业、服务端不认」。
 */

/** 目标类型中文名（与客户端 skillTargetTypeLabels 一致） */
export const SKILL_TARGET_TYPE_LABELS: Record<string, string> = {
  "0": "区域",
  "1": "单体",
  "2": "群体",
  "3": "自身",
};

/** 状态来源（= 客户端 `types/status.StatusSource` 的枚举值） */
export const STATUS_SOURCE_VALUES = ["skill", "equipment", "privilege", "other"];

/**
 * 状态分类（#826 第三批）
 *
 * 只用于管理端分组与前端展示，**判据不靠它**：控制看 `control_flags`、周期看 `tick_ms`。
 * 分类与行为不一致（比如 kind=buff 但配了 stun）时行为按 flags 走 —— 那是运营手滑，
 * 不该让玩家的技能失灵。
 */
export const STATUS_KIND_VALUES = ["buff", "damage", "control", "speed"];

/** 状态分类中文名 */
export const STATUS_KIND_LABELS: Record<string, string> = {
  buff: "增益 / 纯数值",
  damage: "持续伤害",
  control: "控制",
  speed: "加减速",
};

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
