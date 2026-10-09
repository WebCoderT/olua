import type { SortSpec } from "./sort.util";

/**
 * 列表排序白名单的**唯一来源**
 *
 * 集中放一处的原因有两个：
 * 1. 仓储只为「已登记的键」映射 SQL 列（`Record<K, string>` 少一个键就编译不过），
 *    接口文档又要列出同一份字段名 —— 各写一份必然漂移，这里给两边同一份；
 * 2. e2e 可以直接遍历这张表断言「白名单外的值一律退回默认排序」（防注入）。
 *
 * 键是**对外的字段名**（客户端与界面用的），值是 SQL 列（含表别名）。
 */

/** 账号列表：字段名 → 列；`roleCount` 是列表查询里的子查询别名 */
export const ACCOUNT_SORT: SortSpec<"username" | "status" | "roleCount" | "createdAt" | "lastLoginAt"> = {
  columns: {
    username: "a.username",
    status: "a.status",
    roleCount: "role_count",
    createdAt: "a.created_at",
    lastLoginAt: "a.last_login_at",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 角色列表：`accountName` 来自 join 出来的账号表 */
export const ROLE_SORT: SortSpec<"name" | "accountName" | "level" | "revision" | "createdAt" | "updatedAt"> = {
  columns: {
    name: "r.name",
    accountName: "a.username",
    level: "r.level",
    revision: "r.revision",
    createdAt: "r.created_at",
    updatedAt: "r.updated_at",
  },
  default: "updatedAt",
  defaultOrder: "desc",
};

/** 管理员列表：默认保持既有行为（创建时间升序，最早注册的在最前） */
export const ADMIN_SORT: SortSpec<"username" | "role" | "status" | "createdAt" | "updatedAt" | "lastLoginAt"> = {
  columns: {
    username: "username",
    role: "role",
    status: "status",
    createdAt: "created_at",
    updatedAt: "updated_at",
    lastLoginAt: "last_login_at",
  },
  default: "createdAt",
  defaultOrder: "asc",
};

/** 操作日志 */
export const AUDIT_SORT: SortSpec<"createdAt" | "actorName" | "action" | "targetType" | "success" | "statusCode" | "ip"> = {
  columns: {
    createdAt: "a.created_at",
    actorName: "a.actor_name",
    action: "a.action",
    targetType: "a.target_type",
    success: "a.success",
    statusCode: "a.status_code",
    ip: "a.ip",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 公告列表：默认按更新时间倒序（运营改完一条就能在列表顶部看到） */
export const ANNOUNCEMENT_SORT: SortSpec<"title" | "level" | "enabled" | "startsAt" | "endsAt" | "createdAt" | "updatedAt"> = {
  columns: {
    title: "title",
    level: "level",
    enabled: "enabled",
    startsAt: "starts_at",
    endsAt: "ends_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  default: "updatedAt",
  defaultOrder: "desc",
};

/** 邮件投递队列：默认按创建时间倒序（运营刚点的那封在最上面） */
export const MAIL_SORT: SortSpec<"toEmail" | "status" | "attempts" | "sentAt" | "createdAt" | "updatedAt"> = {
  columns: {
    toEmail: "m.to_email",
    status: "m.status",
    attempts: "m.attempts",
    sentAt: "m.sent_at",
    createdAt: "m.created_at",
    updatedAt: "m.updated_at",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 把白名单里的字段名拼成一行，供接口文档说明用（`sort` 的取值） */
export function sortFieldNames<K extends string>(spec: SortSpec<K>): string {
  return Object.keys(spec.columns)
    .map((key) => `\`${key}\``)
    .join(" / ");
}
