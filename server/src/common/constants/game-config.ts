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

/** 是否是合法的获得渠道 */
export function isAcquireChannel(value: unknown): value is AcquireChannelValue {
  return typeof value === "string" && ACQUIRE_CHANNELS.includes(value as AcquireChannelValue);
}
