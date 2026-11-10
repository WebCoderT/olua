import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { EventLogRow } from "../rows";

/** 玩家行为流水的查询条件 */
export interface EventLogListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配角色名 / 目标 / 载荷 */
  keyword?: string;
  /** 事件类型（EVENT_TYPE 的取值） */
  type?: string;
  roleId?: string;
  accountId?: string;
  mapId?: string;
  /** "true" 只看成功 / "false" 只看失败（与审计查询同一约定：字符串避免隐式转换） */
  success?: string;
  /** 起始时间（含，毫秒） */
  from?: number;
  /** 结束时间（含，毫秒） */
  to?: number;
}

/**
 * 玩家行为流水数据访问（#886 / J3）
 *
 * 写入侧有一个**刻意的设计**：`insertMany` 把一次操作产生的多条记录拼成一条多值 INSERT
 * 放进同一个事务。一次群攻打死 8 只怪是 8 条 `kill`、一键批量回收是 N 条 `consume` ——
 * 逐条 `INSERT` 会在这个最热的路径上产生 N 次 WAL 提交。这**不是**「异步批量写」：
 * 调用返回时数据已经落库（#886 原文要求异步，实做按「同步 + 订阅方内合并」定，
 * 见 docs/37 D 类；理由是没有 flush 定时器与退出兜底也能保证「刚做完就能查到」）。
 */
@Injectable()
export class EventLogRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: EventLogRow): void {
    this.insertMany([row]);
  }

  /** 一次写多条（空数组直接返回；单条走普通 INSERT，避免多值语法在这里也要判一次） */
  insertMany(rows: EventLogRow[]): void {
    if (rows.length === 0) return;
    if (rows.length === 1) {
      this.db.run(INSERT_SQL, paramsOf(rows[0]));
      return;
    }
    const tuple = `(${Array.from({ length: COLUMN_COUNT }, () => "?").join(", ")})`;
    const sql = `INSERT INTO event_logs (${COLUMNS.join(", ")}) VALUES ${rows.map(() => tuple).join(", ")}`;
    this.db.transaction(() => {
      this.db.run(sql, rows.flatMap(paramsOf));
    });
  }

  /**
   * 分页检索（固定按时间倒序）
   *
   * 末尾用 `rowid DESC` 兜底：同一毫秒写入的多条（一次群攻的 8 条击杀、一封邮件的
   * 「金币 + 物品」两条）排序值完全相同，没有兜底键时翻页会出现「第 2 页又冒出第 1 页
   * 看过的那条」。
   *
   * 兜底键用 **`rowid` 而不是 `id`**：`id` 是随机 uuid，同一毫秒内谁排前面纯看字符串，
   * 同一次操作的两条记录在列表里可能颠来倒去（e2e 的「附件金币」断言就被这个抓到过）；
   * `rowid` 是插入顺序，一次 `recordMany` 的多行稳定按写入次序排。
   */
  list(options: EventLogListOptions): EventLogRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<EventLogRow>(
      `SELECT * FROM event_logs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: EventLogListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM event_logs ${clause}`, params);
  }

  /** 库里出现过哪些类型（筛选下拉的数据源 —— 字典里有、数据里没有的类型不会出现在界面） */
  distinctTypes(): string[] {
    return this.db
      .all<{ type: string }>("SELECT DISTINCT type FROM event_logs ORDER BY type ASC")
      .map((row) => row.type);
  }

  /** 每个类型各有多少条（类型清单用：0 条的类型一眼能看出「还没埋上」） */
  countByType(): Array<{ type: string; total: number }> {
    return this.db.all<{ type: string; total: number }>(
      "SELECT type, COUNT(1) AS total FROM event_logs GROUP BY type ORDER BY type ASC",
    );
  }

  /** 某个角色最近 N 条（排查「这个号昨晚干了什么」用；e2e 也走这条） */
  recentOfRole(roleId: string, limit: number): EventLogRow[] {
    return this.db.all<EventLogRow>(
      "SELECT * FROM event_logs WHERE role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      [roleId, limit],
    );
  }

  /** 总行数（清理判断用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM event_logs");
  }

  /** 只保留最新的 maxRows 条，返回清掉的条数（0 表示不清理） */
  prune(maxRows: number): number {
    if (maxRows <= 0) return 0;
    const total = this.countAll();
    if (total <= maxRows) return 0;
    // 超出部分一次算准再删：分两次 count 之间可能又写进来几行，差值与实际删除量会不齐
    const overflow = total - maxRows;
    return this.db.execute(
      "DELETE FROM event_logs WHERE rowid IN (SELECT rowid FROM event_logs ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      [overflow],
    ).changes;
  }

  /** 清掉早于某个时刻的记录，返回清掉的条数（与 maxRows 是两道独立的闸） */
  pruneOlderThan(before: number): number {
    return this.db.execute("DELETE FROM event_logs WHERE created_at < ?", [before]).changes;
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: EventLogListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义，否则角色名里的 `_`（单字符通配）会被当成占位符
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(role_name LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (options.type) {
      where.push("type = ?");
      params.push(options.type);
    }
    if (options.roleId) {
      where.push("role_id = ?");
      params.push(options.roleId);
    }
    if (options.accountId) {
      where.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options.mapId) {
      where.push("map_id = ?");
      params.push(options.mapId);
    }
    if (options.success === "true" || options.success === "false") {
      where.push("success = ?");
      params.push(options.success === "true" ? 1 : 0);
    }
    if (options.from !== undefined) {
      where.push("created_at >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("created_at <= ?");
      params.push(options.to);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

/** 列清单（insert 与 insertMany 共用同一份，加列只改这里） */
const COLUMNS = [
  "id",
  "type",
  "account_id",
  "role_id",
  "role_name",
  "zone_id",
  "map_id",
  "target",
  "amount",
  "detail",
  "ip",
  "success",
  "created_at",
] as const;

const COLUMN_COUNT = COLUMNS.length;

const INSERT_SQL = `INSERT INTO event_logs (${COLUMNS.join(", ")}) VALUES (${Array.from(
  { length: COLUMN_COUNT },
  () => "?",
).join(", ")})`;

function paramsOf(row: EventLogRow): SqlParam[] {
  return [
    row.id,
    row.type,
    row.account_id,
    row.role_id,
    row.role_name,
    row.zone_id,
    row.map_id,
    row.target,
    row.amount,
    row.detail,
    row.ip,
    row.success,
    row.created_at,
  ];
}
