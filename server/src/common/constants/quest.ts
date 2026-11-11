/**
 * 任务的两把尺子（#862/#863/#864）
 *
 * 放在 common/constants 而不是 quest 模块里，理由与 `daily-clock` 同一个：
 * 同一件事只该有一个口径。距离阈值将来拾取（#817）、商城 NPC、传送都要用；
 * 切周的尺子则要与日常的 05:00 同源，不能各算各的。
 */

import { DAILY_RESET_HOUR, resetDayOf } from "../utils/daily-clock";

/**
 * NPC 交互半径（像素，#862/#863 已定 120）
 *
 * 口径：角色脚底与 NPC 图元中心的**直线距离**（与掉落拾取半径同一种量法）。
 * 取 120 的理由：
 * - NPC 精灵本身 60~100px 宽，120 差不多是「贴着 NPC 站」，但要给手机端点按与
 *   寻路落点留一点余量（40px 的拾取半径是「踩上去」，对话不该这么苛刻）；
 * - 再大（200）就变成「半个屏外也能接任务」：跑图任务的「走过去」这一步会被抹掉。
 *
 * 这是服务端口径，**客户端不自己判**：客户端可以提前把远处的「接取」按钮灰掉，
 * 但最终的拒绝必须来自这里。
 */
export const QUEST_NPC_RADIUS = 120;

/**
 * NPC 交互能容忍的位置快照年龄（毫秒）
 *
 * 位置快照由实时进程每秒写一次（`role_positions`），所以正常在线的人最多滞后 1 秒；
 * 取 10 秒是给「刚进图 / 网络抖一个广播节拍」留余量，同时保证**掉线 10 秒之后
 * 那张旧位置不再放行**。超过它就是「不知道你在哪」，一律拒绝交互 ——
 * 宁可让玩家再走一步，也不让一个已经下线的人对着 NPC 空接任务。
 */
export const QUEST_POS_STALE_MS = 10_000;

const DAY_MS = 86_400_000;

/**
 * 把时刻映射成「本周周一的日号」（#864 周常的尺子）
 *
 * 与日常**同一把尺子**（`resetDayOf`，每日 05:00 切日），只是再往下取整到周一：
 * 玩家周日 23:40 接的周常，到周一 04:59 仍然算「这一周」，不会凭空作废。
 *
 * 为什么不用 `Date.getDay()` 再算日期字符串：那会把「周一 00:00」和「周一 05:00」
 * 两个口径混进同一张表，跨天的那一小时必然对不上。天号是整数，减一下就落到周一。
 *
 * 星期推导：天号 0 是 `1970-01-01 05:00`（周四），所以 `(day + 4) % 7` 即「周日 = 0」的
 * 星期序号，距上一个周一的天数 = `(weekday + 6) % 7`。
 */
export function weekStartDayOf(now: number, offsetHour: number = DAILY_RESET_HOUR): number {
  const day = resetDayOf(now, offsetHour);
  const weekday = (((day + 4) % 7) + 7) % 7;
  return day - ((weekday + 6) % 7);
}

/** 当前周号（`weekStartDayOf(Date.now())` 的语义化写法） */
export function thisWeekStartDay(): number {
  return weekStartDayOf(Date.now());
}

/** 一周的毫秒数（只有测试与文档用得上，但放在同一处省得各处再写 7 * 86400000） */
export const WEEK_MS = 7 * DAY_MS;
