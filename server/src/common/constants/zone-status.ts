/**
 * 区服运营状态（#961）
 *
 * 放 `common/constants` 而不是 zone 模块里：**玩家侧**（登录闸门、选服、建角）与
 * **实时侧**（维护倒计时、合并踢线）都要判它，谁也不是 zone 模块的下游 ——
 * 让它们从 `modules/zone/zone.service` import 一个常量，会把「加载 zone 模块」
 * 变成「加载一个 service」的副作用。
 *
 * ```
 * open ──维护──▶ maintenance ──恢复──▶ open
 *   │                 │
 *   └──────关闭───────┴──▶ closed（不可逆）
 * ```
 */
export const ZONE_STATUS = {
  OPEN: "open",
  MAINTENANCE: "maintenance",
  CLOSED: "closed",
} as const;

export type ZoneStatus = (typeof ZONE_STATUS)[keyof typeof ZONE_STATUS];

/** 全部合法取值（DTO 只做字符串校验，取值域由服务层收） */
export const ZONE_STATUS_ALL: string[] = [ZONE_STATUS.OPEN, ZONE_STATUS.MAINTENANCE, ZONE_STATUS.CLOSED];

/** 这个状态还能不能进（玩家侧唯一判据：`open` 才能进） */
export function isPlayableStatus(status: string): boolean {
  return status === ZONE_STATUS.OPEN;
}
