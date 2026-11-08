/**
 * 日常口径的时间尺子（#815）
 *
 * 全服统一**每日 05:00 切日**：把「现在」映射成一个整数天号，日常任务、以后的签到 /
 * 活动周期都用同一把尺子。放在 common 而不是 quest 模块里 —— 多一个有自己的尺子
 * 就会多一个会漂移的口径（同一件事两处算，迟早对不上）。
 *
 * ## 为什么是 05:00 而不是 00:00
 *
 * 玩家在 23:40 接的日常，00:10 再上线时会发现「昨天没做完的任务凭空变了」。
 * 05:00 是低峰，且把「晚上这一段连续游玩」划进同一天。
 *
 * ## 为什么用「天号」而不是存日期字符串
 *
 * 天号是整数，比较大小就是比较先后，`reset_day < today` 一句话表达「这条落后了」；
 * 存 `2026-11-09` 这种字符串则要解析、要处理时区、还无法区分「落后」和「时钟回拨」。
 */
export const DAILY_RESET_HOUR = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 把时间戳映射成天号：跨过当天 05:00 天号 +1
 *
 * 例（本地时间）：`D 04:59` → n，`D 05:00` → n+1。
 * 天号的**绝对值**没有意义，只在同一台机器上做差 —— 不要当日期用。
 */
export function resetDayOf(now: number, offsetHour: number = DAILY_RESET_HOUR): number {
  return Math.floor((now - offsetHour * HOUR_MS) / DAY_MS);
}

/** 当前天号（`resetDayOf(Date.now())` 的语义化写法） */
export function todayResetDay(): number {
  return resetDayOf(Date.now());
}
