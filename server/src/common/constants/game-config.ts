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

import { GROWTH_CURVES } from "../../shared/game-data.generated";

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
