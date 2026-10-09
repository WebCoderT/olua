import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { buildCsv, fileStamp, localDateTime } from "../../common/utils/csv.util";
import { AuditListOptions, AuditRepository } from "../../database/repositories/audit.repository";
import { AuditLogRow } from "../../database/rows";
import { normalizePage } from "../admin/dto/query.dto";
import { AuditExportDto, AuditLogDto, AuditQueryDto } from "./dto/audit.dto";

/** 写日志的入参（除 action 外都可省） */
export interface AuditEntryInput {
  /** 操作人（匿名事件如登录失败传 null） */
  actor?: { id: string; username: string; role?: string } | null;
  /** 动作：接口的 operationId（如 adminRole.patch），或 `auth.login` 这类自定义动作 */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** 附加上下文（请求体 / 登录失败的用户名等）；落库前会打码 */
  detail?: unknown;
  ip?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  success?: boolean;
  errorCode?: number | null;
  errorMessage?: string | null;
}

/** 敏感字段名（打码用）：口令、密钥、令牌、注册码… */
const SENSITIVE_KEY = /pass(word)?|secret|token|registercode|credential/i;

/** 每写这么多条就顺手清一次超量的旧日志 */
const PRUNE_EVERY = 200;

/**
 * 操作日志
 *
 * 定位：回答「**谁**在**什么时候**对**谁**做了什么、成没成」。三件事缺一不可，所以
 * 操作人账号名与目标 id 都冗余存在日志行里 —— 操作人可能被删、角色可能被删，
 * 只留外键的话事后谁也认不出这条记录说的是谁。
 *
 * 写入路径有两条：
 * 1. **管理端写接口自动记**（common/interceptors/audit.interceptor）—— 动作取 operationId；
 * 2. **认证事件手动记**（登录成功 / 失败、改密）—— 这些没有「已登录的管理员」可依附。
 *
 * **写日志绝不能影响主流程**：record 内部吞掉一切异常（日志表写不进去，
 * 也不该让管理员的一次封号操作失败）。
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);
  private writeCount = 0;

  constructor(
    private readonly logs: AuditRepository,
    private readonly config: ConfigService,
  ) {}

  /** 记一条（永不抛异常） */
  record(input: AuditEntryInput): void {
    try {
      const row: AuditLogRow = {
        id: randomUUID(),
        actor_id: input.actor?.id ?? null,
        actor_name: input.actor?.username ?? null,
        actor_role: input.actor?.role ?? null,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        detail: serialize(input.detail),
        ip: input.ip ?? null,
        method: input.method ?? null,
        path: input.path ?? null,
        status_code: input.statusCode ?? null,
        success: input.success === false ? 0 : 1,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        created_at: Date.now(),
      };
      this.logs.insert(row);
      this.pruneIfNeeded();
    } catch (error) {
      this.logger.warn(`操作日志写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 记一次登录尝试（成功与失败都记）
   *
   * 这条不归拦截器管：登录接口是公开的，那时还没有「已认证的操作人」；
   * 而登录失败恰恰是最需要留痕的事件（谁在什么时候从哪里猛试哪个账号）。
   * 失败时操作人留空，把尝试的用户名放进 `detail`。
   *
   * `route` 传**路由相对路径**（如 `auth/login`，不含 API 前缀），保持与部署前缀无关。
   */
  recordLoginAttempt(input: {
    action: string;
    route: string;
    username: string;
    ip?: string | null;
    ok: boolean;
    actor?: { id: string; username: string; role?: string } | null;
    errorCode?: number | null;
    errorMessage?: string | null;
    statusCode?: number;
  }): void {
    this.record({
      actor: input.actor ?? null,
      action: input.action,
      detail: { username: input.username, result: input.ok ? "成功" : "失败" },
      ip: input.ip ?? null,
      method: "POST",
      path: input.route,
      statusCode: input.statusCode ?? (input.ok ? 200 : 401),
      success: input.ok,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    });
  }

  /** 分页查询 */
  list(query: AuditQueryDto): PageResult<AuditLogDto> {
    const { page, size } = normalizePage(query);
    const options: AuditListOptions = { ...this.optionsOf(query), page, size };
    return {
      list: this.logs.list(options).map((row) => AuditLogDto.from(row)),
      total: this.logs.count(options),
      page,
      size,
    };
  }

  /**
   * 导出当前筛选条件下的日志（CSV 文本）
   *
   * 与列表**共用同一套筛选条件**（`optionsOf`）—— 各写一份的话，导出的行和界面看到的行
   * 会对不上，而这种「看着对了其实筛错了」最难被发现。
   *
   * 条数上限取配置 `AUDIT_EXPORT_MAX_ROWS`：一次「全部条件都不填」的导出在这种表上
   * 轻松几万行，直接拼成字符串会把内存和响应体一起撑爆。
   */
  exportCsv(query: AuditQueryDto): AuditExportDto {
    const limit = this.config.get<number>("auditExportMaxRows") ?? 0;
    const options: AuditListOptions = { ...this.optionsOf(query), page: 1, size: limit > 0 ? limit : 1000 };
    const total = this.logs.count(options);
    const rows = this.logs.list(options);
    const dto = new AuditExportDto();
    dto.filename = `${fileStamp(new Date(), "olua-audit")}.csv`;
    dto.content = buildCsv(
      AUDIT_EXPORT_COLUMNS.map((column) => column.header),
      rows.map((row) => {
        const item = AuditLogDto.from(row);
        return AUDIT_EXPORT_COLUMNS.map((column) => column.pick(item));
      }),
    );
    dto.rows = rows.length;
    dto.total = total;
    dto.truncated = total > rows.length;
    return dto;
  }

  /** 出现过的动作清单（界面筛选下拉用，不写死清单） */
  actions(): string[] {
    return this.logs.distinctActions();
  }

  /**
   * query → 仓储筛选条件（列表与导出共用）
   *
   * 两处各写一份条件必然漂移，而「导出的行和界面看到的行不一样」这种错最难被发现 ——
   * 所以条件只在这一个地方拼。
   */
  private optionsOf(query: AuditQueryDto): Omit<AuditListOptions, "page" | "size"> {
    return {
      keyword: query.keyword?.trim() || undefined,
      actorId: query.actorId?.trim() || undefined,
      action: query.action?.trim() || undefined,
      targetType: query.targetType,
      targetId: query.targetId?.trim() || undefined,
      ip: query.ip?.trim() || undefined,
      actorRole: query.actorRole,
      success: query.success,
      from: query.from,
      to: query.to,
      sort: query.sort,
      order: query.order,
    };
  }

  /**
   * 启动时先按保留策略清一次
   *
   * 否则陈年日志要等到累计写满 `PRUNE_EVERY` 条才被清 —— 一个每天只写十几条的部署
   * 永远轮不到清理，保留天数就形同虚设。
   */
  onModuleInit(): void {
    this.prune();
  }

  /** 定期清理（每 PRUNE_EVERY 次写入触发一次） */
  private pruneIfNeeded(): void {
    this.writeCount += 1;
    if (this.writeCount % PRUNE_EVERY !== 0) return;
    this.prune();
  }

  /**
   * 按保留策略清理：先按天数、再按条数
   *
   * 两道闸独立生效（都为 0 = 不清理）：条数上限防刷爆磁盘，天数上限防陈年堆积。
   * 与 record 一样**吞异常** —— 清理失败不该影响任何主流程，下次触发会再试。
   */
  private prune(): void {
    try {
      const days = this.config.get<number>("auditRetentionDays") ?? 0;
      if (days > 0) {
        const removed = this.logs.pruneOlderThan(Date.now() - days * 24 * 3600_000);
        if (removed > 0) this.logger.log(`操作日志超过保留期 ${days} 天，已清理 ${removed} 条`);
      }
      const maxRows = this.config.get<number>("auditLogMaxRows") ?? 0;
      const overflow = this.logs.prune(maxRows);
      if (overflow > 0) this.logger.log(`操作日志超过上限 ${maxRows} 条，已清理最旧的 ${overflow} 条`);
    } catch (error) {
      this.logger.warn(`操作日志清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 导出的列定义（表头 → 取值）
 *
 * 收成一张表而不是手写一遍 `map`：加字段只改这里，表头与取值顺序天然对齐。
 * 「时间」给两列是因为给运营看的是可读时间，而进程序处理要的是毫秒（无时区歧义）。
 */
const AUDIT_EXPORT_COLUMNS: { header: string; pick: (item: AuditLogDto) => unknown }[] = [
  { header: "时间", pick: (item) => localDateTime(item.createdAt) },
  { header: "时间戳(毫秒)", pick: (item) => item.createdAt },
  { header: "操作人", pick: (item) => item.actorName },
  { header: "操作人角色", pick: (item) => item.actorRole },
  { header: "动作", pick: (item) => item.action },
  { header: "目标类型", pick: (item) => item.targetType },
  { header: "目标名称", pick: (item) => item.targetName },
  { header: "目标id", pick: (item) => item.targetId },
  { header: "结果", pick: (item) => (item.success ? "成功" : "失败") },
  { header: "业务码", pick: (item) => item.errorCode },
  { header: "错误信息", pick: (item) => item.errorMessage },
  { header: "来源IP", pick: (item) => item.ip },
  { header: "方法", pick: (item) => item.method },
  { header: "路径", pick: (item) => item.path },
  { header: "HTTP状态", pick: (item) => item.statusCode },
  { header: "上下文", pick: (item) => (item.detail === null ? null : JSON.stringify(item.detail)) },
];

/** 序列化上下文并打码（口令一类字段绝不落库） */
export function serialize(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const masked = maskSensitive(detail);
  if (masked === undefined) return null;
  try {
    const text = JSON.stringify(masked);
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

/**
 * 递归打码：字段名命中敏感词就换成 `***`
 *
 * 审计日志是「事后必看」的东西，因此**宁可多打**：口令、令牌、注册码都不可能
 * 靠日志回放来定位问题，但泄漏一次就是明文口令躺在数据库里。
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[深度超限]";
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? "***" : maskSensitive(item, depth + 1);
  }
  return result;
}
