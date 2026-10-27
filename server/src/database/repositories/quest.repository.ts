import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { QuestRow } from "../rows";
import { QUEST_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 任务列表查询条件 */
export interface QuestListOptions {
  page: number;
  size: number;
  /** 类型筛选：main | daily（不传 = 两边都要） */
  kind?: string;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 任务配置数据访问（#396）
 *
 * 行来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等 —— 运营改过的值不会被重启覆盖）；
 * 管理端允许动态增删（同 drop_tables 的纪律）：删除前由调用方确认
 * 没有玩家进度引用、也没有别的任务把它当主线链前置。
 */
@Injectable()
export class QuestRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: QuestRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO quests
         (id, kind, label, description, prev_quest_id, min_level, npc_id,
          objective_type, objective_target, objective_count,
          reward_gold, reward_exp, reward_items, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.label,
        row.description,
        row.prev_quest_id,
        row.min_level,
        row.npc_id,
        row.objective_type,
        row.objective_target,
        row.objective_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.updated_at,
      ],
    );
  }

  /** 新增一行（重复 id 由调用方先查重，这里不吞异常） */
  insert(row: QuestRow): void {
    this.db.run(
      `INSERT INTO quests
         (id, kind, label, description, prev_quest_id, min_level, npc_id,
          objective_type, objective_target, objective_count,
          reward_gold, reward_exp, reward_items, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.label,
        row.description,
        row.prev_quest_id,
        row.min_level,
        row.npc_id,
        row.objective_type,
        row.objective_target,
        row.objective_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.updated_at,
      ],
    );
  }

  /** 删除一行（被进度 / 链前置引用时由调用方拒绝） */
  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM quests WHERE id = ?", [id]);
  }

  update(row: QuestRow): { changes: number } {
    return this.db.execute(
      `UPDATE quests SET
         kind = ?, label = ?, description = ?, prev_quest_id = ?, min_level = ?, npc_id = ?,
         objective_type = ?, objective_target = ?, objective_count = ?,
         reward_gold = ?, reward_exp = ?, reward_items = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.kind,
        row.label,
        row.description,
        row.prev_quest_id,
        row.min_level,
        row.npc_id,
        row.objective_type,
        row.objective_target,
        row.objective_count,
        row.reward_gold,
        row.reward_exp,
        row.reward_items,
        row.updated_at,
        row.id,
      ],
    );
  }

  findByKey(id: string): QuestRow | undefined {
    return this.db.get<QuestRow>("SELECT * FROM quests WHERE id = ?", [id]);
  }

  listAll(): QuestRow[] {
    return this.db.all<QuestRow>("SELECT * FROM quests ORDER BY id ASC");
  }

  /** 分页检索（默认按 id 数值序 —— 与后台的展示动线一致） */
  list(options: QuestListOptions): QuestRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<QuestRow>(
      `SELECT * FROM quests ${clause}
       ORDER BY ${resolveSort(QUEST_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: QuestListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM quests ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: QuestListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
