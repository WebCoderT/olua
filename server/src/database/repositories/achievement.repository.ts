import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { AchievementRow } from "../rows";
import { ACHIEVEMENT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 成就列表查询条件 */
export interface AchievementListOptions {
  page: number;
  size: number;
  /** 分类筛选：battle | growth | explore（不传 = 全部） */
  category?: string;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 成就配置数据访问（#401）
 *
 * 与任务配置同一取向（`seedRow` 用 INSERT OR IGNORE —— 运营改过的行不会被重启覆盖；
 * 允许动态增删，被 `role_achievements` 引用中的行由调用方拒删）。
 *
 * 与任务配置的一处差别：成就 id 是**语义串**（`ach_kill_10`），按 id 排序没有意义，
 * 默认序是「分类内顺序」（见 `ACHIEVEMENT_SORT`）。
 */
@Injectable()
export class AchievementRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过） */
  seedRow(row: AchievementRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO achievements
         (id, category, label, description, condition_type, condition_target, condition_count,
          reward_gold, reward_exp, reward_items, sort_order, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.category,
        row.label,
        row.description,
        row.condition_type,
        row.condition_target,
        row.condition_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.sort_order,
        row.hidden,
        row.updated_at,
      ],
    );
  }

  /** 新增一行（重复 id 由调用方先查重，这里不吞异常） */
  insert(row: AchievementRow): void {
    this.db.run(
      `INSERT INTO achievements
         (id, category, label, description, condition_type, condition_target, condition_count,
          reward_gold, reward_exp, reward_items, sort_order, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.category,
        row.label,
        row.description,
        row.condition_type,
        row.condition_target,
        row.condition_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.sort_order,
        row.hidden,
        row.updated_at,
      ],
    );
  }

  update(row: AchievementRow): { changes: number } {
    return this.db.execute(
      `UPDATE achievements SET
         category = ?, label = ?, description = ?,
         condition_type = ?, condition_target = ?, condition_count = ?,
         reward_gold = ?, reward_exp = ?, reward_items = ?,
         sort_order = ?, hidden = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.category,
        row.label,
        row.description,
        row.condition_type,
        row.condition_target,
        row.condition_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.sort_order,
        row.hidden,
        row.updated_at,
        row.id,
      ],
    );
  }

  /** 删除一行（有玩家达成记录时由调用方拒绝） */
  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM achievements WHERE id = ?", [id]);
  }

  findByKey(id: string): AchievementRow | undefined {
    return this.db.get<AchievementRow>("SELECT * FROM achievements WHERE id = ?", [id]);
  }

  /** 全部成就（玩家侧快照用：一次读全表，成就总量是几十条的量级） */
  listAll(): AchievementRow[] {
    return this.db.all<AchievementRow>("SELECT * FROM achievements ORDER BY category ASC, sort_order ASC, id ASC");
  }

  /** 分页检索（默认「分类 → 分类内顺序」） */
  list(options: AchievementListOptions): AchievementRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<AchievementRow>(
      `SELECT * FROM achievements ${clause}
       ORDER BY ${resolveSort(ACHIEVEMENT_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: AchievementListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM achievements ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: AchievementListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.category) {
      where.push("category = ?");
      params.push(options.category);
    }
    if (options.keyword) {
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
