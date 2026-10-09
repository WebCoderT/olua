import { SetMetadata } from "@nestjs/common";

/**
 * 审计元数据 key
 *
 * 两件事分开存：**动作**由 `ApiAdminDoc` 自动写入（就是 operationId，唯一来源已经存在，
 * 不需要每个接口再抄一遍），**目标类型**由 `@AuditTarget` 按需标注。
 */
export const AUDIT_ACTION_KEY = "olua:audit:action";
export const AUDIT_TARGET_KEY = "olua:audit:target";

/** 审计目标类型（与 AuditLogRow.target_type 一致；界面按它决定怎么展示目标） */
export type AuditTargetType = "account" | "role" | "admin";

/**
 * 目标 id 从哪来
 * - `param`（默认）：路由参数 `:id`
 * - `self`：当前登录者自己（自助改密这类「只操作自身」的接口没有 :id）
 */
export type AuditTargetSource = "param" | "self";

export interface AuditTargetMeta {
  type: AuditTargetType;
  source: AuditTargetSource;
}

/**
 * 声明该接口的审计目标
 *
 * 动作（action）不用标 —— 由 `ApiAdminDoc({ operationId })` 顺带写入审计元数据，
 * 保证「文档里的接口标识」与「审计日志里的动作」永远是同一个字符串。
 *
 * 只对**写方法**（POST / PUT / PATCH / DELETE）生效，读接口不记（否则日志会被查询刷满）。
 */
export function AuditTarget(type: AuditTargetType, source: AuditTargetSource = "param") {
  return SetMetadata(AUDIT_TARGET_KEY, { type, source } satisfies AuditTargetMeta);
}
