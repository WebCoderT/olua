/**
 * 消息频道（#436）
 *
 * 玩家在消息中心看到的**分类**。四个枚举必须收敛 —— 新增只能改这里，不能在各处写字符串，
 * 否则面板上会冒出「没有页签能装下」的消息（那条邮件等于永远看不到）。
 *
 * 与 `kind` 的分工：
 * - `channel` = **玩家视角的分类**（我要看哪一栏），四个，固定；
 * - `kind` = **来源标签**（成就兜底 / 好友申请 / BOSS 击杀 / 以后的活动补发），自由扩展，
 *   只用于日志、排查与将来做更细的筛选。
 *
 * 两者的典型错位：一条 `kind: "achievement"` 的消息属于 `channel: "reward"` —— 玩家不关心
 * 它是哪个玩法发的，只关心「这是不是奖励」。
 */
export const MAIL_CHANNELS = ["system", "reward", "social", "combat"] as const;

export type MailChannel = (typeof MAIL_CHANNELS)[number];

/** 频道的中文名（服务端只用于日志与默认标题，界面文案在客户端 configs/mail.ts） */
export const MAIL_CHANNEL_LABELS: Record<MailChannel, string> = {
  system: "系统",
  reward: "奖励",
  social: "社交",
  combat: "战斗",
};

/** 类型收窄（外部入参一律先过这里，别拿 `as MailChannel` 硬转） */
export function isMailChannel(value: unknown): value is MailChannel {
  return typeof value === "string" && (MAIL_CHANNELS as readonly string[]).includes(value);
}

/** 兜底归类：老数据或调用方漏传时落到「系统」，绝不让消息因为频道不认识而丢掉 */
export function toMailChannel(value: unknown): MailChannel {
  return isMailChannel(value) ? value : "system";
}
