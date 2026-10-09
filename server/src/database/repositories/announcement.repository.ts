import { Injectable } from "@nestjs/common";
import { AnnouncementLevel } from "../../common/constants/announcement";
import { DatabaseService, SqlParam } from "../database.service";
import { AnnouncementRow } from "../rows";
import { ANNOUNCEMENT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 公告列表查询条件 */
export interface AnnouncementListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配标题与正文 */
  keyword?: string;
  /** 级别筛选（normal / important） */
  level?: string;
  /** "true" 只看启用 / "false" 只看停用（query 用字符串，避免隐式转换把 "false" 变 true） */
  enabled?: string;
  /** "true" 只看当前生效中 / "false" 只看当前不在生效窗口内（含已过期与未开始） */
  active?: string;
  sort?: string;
  order?: string;
  /**
   * 判定「生效中」用的当前时刻（毫秒）
   *
   * 从外面传进来而不是在 SQL 里现取 `Date.now()`：e2e 要能对「刚好卡在时间窗边界」
   * 的行为做断言，取数时刻必须是可控的。
   */
  now?: number;
}

/**
 * 公告数据访问
 *
 * 「生效中」的判据只在下面这个 `ACTIVE_SQL` 里写一次 —— 公共拉取接口与列表筛选
 * 用的是同一段条件，不会出现「玩家看到的」与「后台筛选出来的」两套口径。
 */
@Injectable()
export class AnnouncementRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: AnnouncementRow): void {
    this.db.run(
      `INSERT INTO announcements
        (id, title, content, level, enabled, starts_at, ends_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.title,
        row.content,
        row.level,
        row.enabled,
        row.starts_at,
        row.ends_at,
        row.created_by,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  /**
   * 按 id 覆盖可编辑字段
   *
   * `created_by` 刻意**不在更新列里**：发布人是历史事实，编辑公告的人不该把自己写成发布人。
   */
  update(row: AnnouncementRow): { changes: number } {
    return this.db.execute(
      `UPDATE announcements
       SET title = ?, content = ?, level = ?, enabled = ?, starts_at = ?, ends_at = ?, updated_at = ?
       WHERE id = ?`,
      [row.title, row.content, row.level, row.enabled, row.starts_at, row.ends_at, row.updated_at, row.id],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM announcements WHERE id = ?", [id]);
  }

  findById(id: string): AnnouncementRow | undefined {
    return this.db.get<AnnouncementRow>("SELECT * FROM announcements WHERE id = ?", [id]);
  }

  /**
   * 分页检索（默认按更新时间倒序）
   *
   * 末尾固定追加 `id DESC` 兜底：批量发布（或同一毫秒内改了多条）时排序值会完全相同，
   * 没有兜底键时 SQLite 的相对顺序不保证稳定，翻页会出现重复/漏项。
   */
  list(options: AnnouncementListOptions): AnnouncementRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<AnnouncementRow>(
      `SELECT * FROM announcements ${clause}
       ORDER BY ${resolveSort(ANNOUNCEMENT_SORT, options.sort, options.order)}, id DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: AnnouncementListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM announcements ${clause}`, params);
  }

  /**
   * 当前生效中的公告（公共接口用，不分页）
   *
   * 排序：**重要在前**，同级按发布时间倒序 —— 玩家第一眼该看到的是重要公告，
   * 而不是最近发的一条闲聊。
   */
  listActive(now: number): AnnouncementRow[] {
    return this.db.all<AnnouncementRow>(
      `SELECT * FROM announcements WHERE ${ACTIVE_SQL}
       ORDER BY CASE level WHEN '${AnnouncementLevel.IMPORTANT}' THEN 0 ELSE 1 END ASC, created_at DESC`,
      [now, now],
    );
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: AnnouncementListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义，否则标题里的 `_`（下划线是单字符通配）会被当成占位符
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (options.level) {
      where.push("level = ?");
      params.push(options.level);
    }
    if (options.enabled) {
      where.push("enabled = ?");
      params.push(options.enabled === "true" ? 1 : 0);
    }
    if (options.active) {
      const now = options.now ?? Date.now();
      // 取反要用括号包住整段：`NOT (a AND b)` 与 `NOT a AND b` 不是一回事
      where.push(options.active === "true" ? ACTIVE_SQL : `NOT ${ACTIVE_SQL}`);
      params.push(now, now);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

/**
 * 「当前生效中」的判据（**唯一来源**）
 *
 * 三道闸全部满足才算生效：手动启用了、已到开始时间、还没到结束时间。
 * `starts_at` / `ends_at` 为 NULL 分别表示「立即生效」「不设截止」——
 * 把这两种情况写进 SQL 而不是在业务层补默认时间戳，是为了让「长期公告」不需要编造一个
 * 遥远的结束时间来占位（编出来的时间总会在某天真的到期）。
 */
const ACTIVE_SQL =
  "(enabled = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?))";
