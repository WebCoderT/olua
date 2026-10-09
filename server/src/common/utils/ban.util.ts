import { AccountRow } from "../../database/rows";
import { ENTITY_STATUS } from "../constants/status";

/**
 * 封禁判定与文案（纯函数，可在 e2e 里直接 require dist 产物验证）
 *
 * 账号状态机刻意保持两态（`active` / `disabled`），把「临时封禁」表达成 `ban_until`：
 * 到期后**不需要任何人去点解封** —— 判定函数直接按时间算，定时器只负责把库里的
 * 状态扫回 active（见 modules/admin/ban-scheduler.service），两者互不依赖。
 *
 * `ban_until = null` 有两种含义，必须靠 status 区分：
 *   - status = active   → 从没被封过
 *   - status = disabled → 永久封禁
 * 所以判据只能是「disabled 且有结束时间且已到期」，只看 ban_until 会把
 * 「正常账号」误判成「已解封」。
 */
export function isBanExpired(account: Pick<AccountRow, "status" | "ban_until">, now: number = Date.now()): boolean {
  return account.status === ENTITY_STATUS.DISABLED && account.ban_until !== null && account.ban_until <= now;
}

/** 是否处于封禁中（已到期的临时封禁按「未封禁」算） */
export function isBanned(account: Pick<AccountRow, "status" | "ban_until">, now: number = Date.now()): boolean {
  return account.status === ENTITY_STATUS.DISABLED && !isBanExpired(account, now);
}

/** 把毫秒时长说成人话（登录被拒的提示里用） */
export function humanizeDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  // 已经有「天」的时候不再报分钟，少一点噪音
  if (minutes > 0 && days === 0) parts.push(`${minutes} 分钟`);
  return parts.join(" ") || "1 分钟";
}

/**
 * 封禁提示文案
 *
 * 玩家登录被拒时**只能**从这句话里知道为什么 —— 那时他拿不到账号详情，
 * 所以原因、是否永久、还剩多久都要说清楚。剩余时长不依赖时区，比「解封时间」稳。
 */
export function describeBan(
  account: Pick<AccountRow, "status" | "ban_until" | "ban_reason">,
  now: number = Date.now(),
): string {
  const reason = account.ban_reason?.trim();
  const head = reason ? `账号已被封禁：${reason}` : "账号已被封禁";
  if (account.ban_until === null) return `${head}（永久封禁，如有疑问请联系客服）`;
  const remain = account.ban_until - now;
  if (remain <= 0) return head;
  return `${head}（剩余 ${humanizeDuration(remain)}后自动解封）`;
}

/** 封禁时长上限（小时）：一年。超过这个量级就等于永久，没必要再细分 */
export const BAN_DURATION_MAX_HOURS = 24 * 365;
