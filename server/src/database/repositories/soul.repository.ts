import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { SoulRow } from "../rows";
import { SOUL_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 战魂列表查询条件 */
export interface SoulListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配名称与描述 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 战魂配置数据访问
 *
 * 与 `TitleRepository` 同构，只少 `acquire_channel` 一列 —— 战魂 37 阶逐阶购买，
 * 没有「获得渠道」语义。同样**没有对外的 insert / remove**：行只能来自启动 seed。
 */
@Injectable()
export class SoulRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: SoulRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO souls
        (level, label, description, animation, animation_frame_rate, bind_gold,
         max_hp, hp_recover, physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.level,
        row.label,
        row.description,
        row.animation,
        row.animation_frame_rate,
        row.bind_gold,
        row.max_hp,
        row.hp_recover,
        row.physical_attack_min,
        row.physical_attack_max,
        row.magic_attack_min,
        row.magic_attack_max,
        row.taoist_attack_min,
        row.taoist_attack_max,
        row.physical_defense_min,
        row.physical_defense_max,
        row.magic_defense_min,
        row.magic_defense_max,
        row.taoist_defense_min,
        row.taoist_defense_max,
        row.updated_at,
      ],
    );
  }

  update(row: SoulRow): { changes: number } {
    return this.db.execute(
      `UPDATE souls SET
         label = ?, description = ?, animation = ?, animation_frame_rate = ?, bind_gold = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE level = ?`,
      [
        row.label,
        row.description,
        row.animation,
        row.animation_frame_rate,
        row.bind_gold,
        row.max_hp,
        row.hp_recover,
        row.physical_attack_min,
        row.physical_attack_max,
        row.magic_attack_min,
        row.magic_attack_max,
        row.taoist_attack_min,
        row.taoist_attack_max,
        row.physical_defense_min,
        row.physical_defense_max,
        row.magic_defense_min,
        row.magic_defense_max,
        row.taoist_defense_min,
        row.taoist_defense_max,
        row.updated_at,
        row.level,
      ],
    );
  }

  findByLevel(level: number): SoulRow | undefined {
    return this.db.get<SoulRow>("SELECT * FROM souls WHERE level = ?", [level]);
  }

  /** 分页检索（默认按阶数升序） */
  list(options: SoulListOptions): SoulRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<SoulRow>(
      `SELECT * FROM souls ${clause}
       ORDER BY ${resolveSort(SOUL_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: SoulListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM souls ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: SoulListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
