import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { StatusRow } from "../rows";
import { STATUS_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 状态列表查询条件 */
export interface StatusListOptions {
  page: number;
  size: number;
  /** 归属筛选：role | monster（不传 = 两边都要） */
  owner?: string;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 状态数据访问（#367）
 *
 * 与技能同一取向：**只能 seed 与更新，不能增删** —— 状态 id 被技能（`skills.status_id`）
 * 与将来的装备 / 特权引用，删掉一行等于让引用它的人变成隐形状态。怪物状态的增删随
 * #12 主体那一刀一起开（同表 `owner=monster`）。
 */
@Injectable()
export class StatusRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: StatusRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO statuses
         (id, owner, label, icon, duration, source, description, effect, effect_hold_last, combat, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.owner,
        row.label,
        row.icon,
        row.duration,
        row.source,
        row.description,
        row.effect,
        row.effect_hold_last,
        row.combat,
        row.updated_at,
      ],
    );
  }

  update(row: StatusRow): { changes: number } {
    return this.db.execute(
      `UPDATE statuses SET
         label = ?, icon = ?, duration = ?, source = ?, description = ?,
         effect = ?, effect_hold_last = ?, combat = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.icon,
        row.duration,
        row.source,
        row.description,
        row.effect,
        row.effect_hold_last,
        row.combat,
        row.updated_at,
        row.id,
      ],
    );
  }

  findByKey(id: string): StatusRow | undefined {
    return this.db.get<StatusRow>("SELECT * FROM statuses WHERE id = ?", [id]);
  }

  /** 全量（服务端 AI 的状态缓存来源，#372：怪物释放状态技能后要按 combat 改伤害） */
  listAll(): StatusRow[] {
    return this.db.all<StatusRow>("SELECT * FROM statuses ORDER BY id ASC");
  }

  /** 分页检索（默认按 id 数值序） */
  list(options: StatusListOptions): StatusRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<StatusRow>(
      `SELECT * FROM statuses ${clause}
       ORDER BY ${resolveSort(STATUS_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: StatusListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM statuses ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: StatusListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.owner) {
      where.push("owner = ?");
      params.push(options.owner);
    }
    if (options.keyword) {
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
