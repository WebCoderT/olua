import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { RoleReportRow, RoleReportWithNameRow } from "../rows";

/** 举报列表的查询条件（全部可选，条件之间是「与」） */
export interface ReportListOptions {
  /** abuse / cheat / name / other */
  category?: string;
  status?: string;
  /** 模糊匹配双方角色名或 id */
  keyword?: string;
  page: number;
  size: number;
}

/**
 * 举报数据访问（#398）
 *
 * ## 为什么单独一张表而不是复用审计日志
 * 审计记的是**管理员的写操作**，举报是**玩家的上报** —— 两者受众、保留期、可见权限都不同
 * （`audit:read` 不该顺带让人看到玩家之间的指控）。放一起还会让「按状态处理」这种
 * 后续动作没有落脚点。
 *
 * ## 为什么没有外键
 * 举报是证据：被举报的人被删号之后，这条记录仍要能查（怎么处理、处理过谁），
 * 所以两端的角色 id 都不加 `REFERENCES`，名字在查询时 LEFT JOIN 出来 ——
 * 角色没了就显示 id，而不是整行跟着级联消失。
 */
@Injectable()
export class ReportRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 写一条举报（调用方负责判重与自举报） */
  insert(row: RoleReportRow): void {
    this.db.run(
      `INSERT INTO role_reports (id, role_id, target_role_id, category, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.role_id, row.target_role_id, row.category, row.reason, row.status, row.created_at],
    );
  }

  /** 这一对（我 → 他）还有没有没处理完的举报（判重：同一对只留一条 pending） */
  findOpen(roleId: string, targetRoleId: string, status: string): RoleReportRow | undefined {
    return this.db.get<RoleReportRow>(
      "SELECT * FROM role_reports WHERE role_id = ? AND target_role_id = ? AND status = ? LIMIT 1",
      [roleId, targetRoleId, status],
    );
  }

  /**
   * 分页列表（管理端只读）
   *
   * 排序固定「新举报在前 + id 兜底」：同一毫秒落两条是很正常的事（同一秒连点两次举报
   * 在不同目标上），只按 created_at 排会让翻页时有一条在页边界反复出现或消失。
   * 不做可配置排序：这一页的用途是「按时间往下清」，没有第二种看法。
   */
  list(options: ReportListOptions): PageResult<RoleReportWithNameRow> {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.category) {
      where.push("rep.category = ?");
      params.push(options.category);
    }
    if (options.status) {
      where.push("rep.status = ?");
      params.push(options.status);
    }
    const keyword = (options.keyword ?? "").trim();
    if (keyword) {
      // 匹配两端角色名与 id：运营手里可能是名字（玩家说的），也可能是 id（日志里的）
      where.push(
        "(rep.role_id LIKE ? OR rep.target_role_id LIKE ? OR reporter.name LIKE ? OR target.name LIKE ?)",
      );
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.count(
      `SELECT COUNT(1) AS total
         FROM role_reports rep
         LEFT JOIN roles reporter ON reporter.id = rep.role_id
         LEFT JOIN roles target ON target.id = rep.target_role_id
         ${clause}`,
      params,
    );
    const list = this.db.all<RoleReportWithNameRow>(
      `SELECT rep.*, reporter.name AS role_name, target.name AS target_name
         FROM role_reports rep
         LEFT JOIN roles reporter ON reporter.id = rep.role_id
         LEFT JOIN roles target ON target.id = rep.target_role_id
         ${clause}
        ORDER BY rep.created_at DESC, rep.id DESC
        LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
    return { list, total, page: options.page, size: options.size };
  }
}
