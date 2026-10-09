import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { AUDIT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";
import { AuditLogRow, AuditLogWithNameRow } from "../rows";

/** 操作日志查询条件 */
export interface AuditListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配操作人账号名 / 动作 / 目标 id / 请求路径 */
  keyword?: string;
  /** 操作人 id */
  actorId?: string;
  /** 动作（operationId） */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** 来源 IP（**精确匹配**：想查「这个 IP 干了什么」，用网段/模糊筛出来的噪声比信号多） */
  ip?: string;
  /** 操作人角色（super_admin / admin / viewer） */
  actorRole?: string;
  /** "true" 只看成功 / "false" 只看失败（与角色筛选同一约定：query 用字符串，避免隐式转换把 "false" 变 true） */
  success?: string;
  /** 起始时间（含，毫秒） */
  from?: number;
  /** 结束时间（含，毫秒） */
  to?: number;
  /** 只看失败事件（登录失败等），等价于 success = "false" */
  onlyFailures?: boolean;
  /** 排序字段（白名单外的值退回默认） */
  sort?: string;
  order?: string;
}

/**
 * 操作日志数据访问
 *
 * 查询时按 `target_type` 关联出目标的**当前**名字（目标可能已被删 → 返回 null，
 * 界面退回显示 id）。用相关子查询而不是 JOIN：一张表要打三种目标，JOIN 会写成三段
 * UNION，可读性差得多，而这张表的量级（配置上限默认 2 万行）完全撑得住。
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: AuditLogRow): void {
    this.db.run(
      `INSERT INTO audit_logs
        (id, actor_id, actor_name, actor_role, action, target_type, target_id, detail,
         ip, method, path, status_code, success, error_code, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.actor_id,
        row.actor_name,
        row.actor_role,
        row.action,
        row.target_type,
        row.target_id,
        row.detail,
        row.ip,
        row.method,
        row.path,
        row.status_code,
        row.success,
        row.error_code,
        row.error_message,
        row.created_at,
      ],
    );
  }

  /**
   * 分页检索（默认按时间倒序）
   *
   * 末尾固定追加 `a.id DESC` 做**兜底次序**：同一毫秒写入的多条日志（批量操作很常见）
   * 排序值完全相同，没有兜底键时 SQLite 返回的相对顺序不保证稳定 —— 翻页会出现
   * 「第 2 页又冒出第 1 页看过的那条」。
   */
  list(options: AuditListOptions): AuditLogWithNameRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<AuditLogWithNameRow>(
      `SELECT a.*, ${TARGET_NAME_SQL} AS target_name
       FROM audit_logs a ${clause}
       ORDER BY ${resolveSort(AUDIT_SORT, options.sort, options.order)}, a.id DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: AuditListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM audit_logs a ${clause}`, params);
  }

  /** 出现过哪些动作（管理端筛选下拉用，不写死清单） */
  distinctActions(): string[] {
    return this.db
      .all<{ action: string }>("SELECT DISTINCT action FROM audit_logs ORDER BY action ASC")
      .map((row) => row.action);
  }

  /** 总行数（清理判断用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM audit_logs");
  }

  /** 只保留最新的 maxRows 条，返回清掉的条数（0 表示不清理） */
  prune(maxRows: number): number {
    if (maxRows <= 0 || this.countAll() <= maxRows) return 0;
    const overflow = this.countAll() - maxRows;
    const result = this.db.execute(
      `DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs ORDER BY created_at ASC, id ASC LIMIT ?)`,
      [overflow],
    );
    return result.changes;
  }

  /**
   * 清掉早于某个时刻的日志，返回清掉的条数（0 = 不清理）
   *
   * 与 `prune` 是两道各自独立的闸：条数上限防刷爆磁盘，天数上限防陈年堆积。
   */
  pruneOlderThan(before: number): number {
    return this.db.execute("DELETE FROM audit_logs WHERE created_at < ?", [before]).changes;
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: AuditListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义，否则玩家名里的 `_`（下划线是单字符通配）会当成占位符
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(
        "(a.actor_name LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\'" +
          " OR a.target_id LIKE ? ESCAPE '\\' OR a.path LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like);
    }
    if (options.actorId) {
      where.push("a.actor_id = ?");
      params.push(options.actorId);
    }
    if (options.action) {
      where.push("a.action = ?");
      params.push(options.action);
    }
    if (options.targetType) {
      where.push("a.target_type = ?");
      params.push(options.targetType);
    }
    if (options.targetId) {
      where.push("a.target_id = ?");
      params.push(options.targetId);
    }
    if (options.ip) {
      where.push("a.ip = ?");
      params.push(options.ip);
    }
    if (options.actorRole) {
      where.push("a.actor_role = ?");
      params.push(options.actorRole);
    }
    if (options.success) {
      where.push("a.success = ?");
      params.push(options.success === "true" ? 1 : 0);
    }
    if (options.onlyFailures) where.push("a.success = 0");
    if (options.from !== undefined) {
      where.push("a.created_at >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("a.created_at <= ?");
      params.push(options.to);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

/** 按目标类型取「当前」名字；目标已删则为 null（界面退回显示 id） */
const TARGET_NAME_SQL = `CASE a.target_type
  WHEN 'role' THEN (SELECT r.name FROM roles r WHERE r.id = a.target_id)
  WHEN 'account' THEN (SELECT c.username FROM accounts c WHERE c.id = a.target_id)
  WHEN 'admin' THEN (SELECT m.username FROM admins m WHERE m.id = a.target_id)
  WHEN 'announcement' THEN (SELECT n.title FROM announcements n WHERE n.id = a.target_id)
  ELSE NULL
END`;
