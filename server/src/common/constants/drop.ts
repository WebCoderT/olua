/**
 * 掉落终态流水的取值（**唯一来源**，#803）
 *
 * `drop_records.result` 只认这五个值：`picked` / `expired` / `overflow` / `restart_lost`
 * （`ground` 是「还在场上」，不是终态，永远不写进流水）。
 *
 * ## 为什么 `overflow` 还要一列 `reason`
 *
 * 同一个 `overflow` 有两个来源：超单图上限被 `sweep` 挤掉（`auto`）与管理端按图清空
 * （`manual_clear`，#805）。两者的排查方向完全相反 —— 前者说明「产出 > 消耗」，
 * 后者是人为操作。**不新增 result 枚举**：那会改动 #802 定下的协议与统计口径，
 * 用一个可空的细分列更省事，也更容易回退。
 */

/** 终态（落 `drop_records.result`） */
export const DROP_RESULT = {
  /** 被某个玩家捡走（`picked_*` 三列有值） */
  PICKED: "picked",
  /** 到期自然消失（TTL 到点，扫描器或拾取时的兜底判定） */
  EXPIRED: "expired",
  /** 被挤掉：超单图上限（`reason=auto`）或管理端清空（`reason=manual_clear`） */
  OVERFLOW: "overflow",
  /** 进程重启时地上还没被捡走的那批（`resolved_at` = 启动时刻） */
  RESTART_LOST: "restart_lost",
} as const;

export type DropResult = (typeof DROP_RESULT)[keyof typeof DROP_RESULT];

/** 终态的中文名（管理端筛选下拉与概况卡） */
export const DROP_RESULT_LABELS: Record<DropResult, string> = {
  [DROP_RESULT.PICKED]: "已被拾取",
  [DROP_RESULT.EXPIRED]: "自然过期",
  [DROP_RESULT.OVERFLOW]: "被挤掉",
  [DROP_RESULT.RESTART_LOST]: "重启丢失",
};

/** 全部结果值（DTO 的 `@IsIn` 与文档枚举都用它） */
export const DROP_RESULTS: DropResult[] = Object.values(DROP_RESULT);

/** 判断一个字符串是不是登记过的结果值（未知值不拦，回显原值 —— 埋点先上、字典后补时不该整页空白） */
export function isKnownDropResult(value: string): value is DropResult {
  return (DROP_RESULTS as string[]).includes(value);
}

/** `overflow` 的细分来源（落 `drop_records.reason`） */
export const DROP_OVERFLOW_REASON = {
  /** 超单图上限（`maxGroundPerMap`）被扫描器挤掉最旧的 */
  AUTO: "auto",
  /** 管理端按图清空（#805） */
  MANUAL_CLEAR: "manual_clear",
} as const;

export type DropOverflowReason = (typeof DROP_OVERFLOW_REASON)[keyof typeof DROP_OVERFLOW_REASON];
