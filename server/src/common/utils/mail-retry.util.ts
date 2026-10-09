import { MAIL_RETRY_MAX_FACTOR } from "../constants/mail";

/**
 * 投递失败后的重试等待：指数退避（**纯函数**，不碰时钟也不碰数据库）
 *
 * 第 n 次失败 → 等待 `baseMs * 2^(n-1)`，倍数封顶 `MAIL_RETRY_MAX_FACTOR`。
 *
 * 为什么封顶：不封顶的话第 20 次失败要等 `base * 2^19`（基数 60 秒时约等于 21 年），
 * 那条任务会挂在「重试中」直到有人手工清理 —— 而「重试中」在界面上的含义是
 * 「系统还在努力」，实际上它已经放弃了。封顶之后最坏情况也是「几小时内重试完并标为失败」。
 *
 * 为什么是**指数**而不是固定间隔：SMTP 不可达通常是持续几分钟到几小时的故障，
 * 固定 30 秒重试会在故障期间刷出上千次无意义的连接尝试（还可能被对方判定为骚扰而拉黑）；
 * 指数退避把「快速恢复」与「不骚扰对方」这两件事同时做到。
 */
export function retryDelayMs(attempts: number, baseMs: number, maxFactor: number = MAIL_RETRY_MAX_FACTOR): number {
  if (attempts <= 0) return 0;
  const factor = Math.min(2 ** (attempts - 1), maxFactor);
  return Math.max(0, baseMs) * factor;
}
