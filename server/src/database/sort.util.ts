/**
 * 列表排序的白名单解析器
 *
 * 为什么必须有这一层：**排序列是拼进 SQL 文本的** —— 值可以用占位符 `?`，
 * 列名不行（`ORDER BY ?` 会被当成常量）。所以请求里的字符串绝不能直接拼进去，
 * 只认白名单里登记过的键；命中不了就退回默认列。方向同理，只认 asc / desc。
 *
 * 白名单写在**各自仓储的模块顶部**（见 account/role/admin/audit.repository）：
 * 只有仓储知道列名与表别名，DTO 层不该认识数据库。
 */

/** 排序方向（只认这两个词，大小写不敏感） */
export type SortOrder = "asc" | "desc";

export interface SortSpec<K extends string> {
  /** 允许排序的字段名 → SQL 列（含表别名，如 `r.updated_at`） */
  columns: Record<K, string>;
  /** 默认字段：客户端没传 sort、或传了白名单外的值时用它 */
  default: K;
  /** 默认方向；不传即降序（列表默认看最新的） */
  defaultOrder?: SortOrder;
}

/**
 * 把入参收敛成一段可安全拼接的 `ORDER BY` 片段（**不带 `ORDER BY` 前缀**）
 *
 * 未知的 sort 静默退回默认列而**不报错**：界面只会送白名单里的值，
 * 手写请求传了错值也该拿到一份合理的列表，而不是 400。
 */
export function resolveSort<K extends string>(spec: SortSpec<K>, sort?: string, order?: string): string {
  const key = sort && Object.prototype.hasOwnProperty.call(spec.columns, sort) ? (sort as K) : spec.default;
  const direction = pickOrder(order) ?? (spec.defaultOrder ?? "desc").toUpperCase();
  return `${spec.columns[key]} ${direction}`;
}

/** 方向解析（`asc`/`ASC` 都认，其余忽略） */
function pickOrder(order?: string): "ASC" | "DESC" | undefined {
  if (!order) return undefined;
  const value = order.toLowerCase();
  if (value === "asc") return "ASC";
  if (value === "desc") return "DESC";
  return undefined;
}
