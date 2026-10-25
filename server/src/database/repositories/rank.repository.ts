import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { RankRow } from "../rows";
import { RANK_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 军衔列表查询条件 */
export interface RankListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配衔名 / 大段名 / 描述 */
  keyword?: string;
  /** 按大段名筛（如「校尉」） */
  tier?: string;
  sort?: string;
  order?: string;
}

/**
 * 军衔配置数据访问（#250）
 *
 * 与称号 / 战魂同一取向：**没有 insert / remove 的对外语义** —— 行只能来自启动 seed
 * （`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除。
 * 军衔 100 阶全量就是成长链（顺序天然按阶），**没有成长列表序号列**。
 */
@Injectable()
export class RankRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: RankRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO ranks
        (level, label, tier, description, bind_gold,
         max_hp, hp_recover, physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.level,
        row.label,
        row.tier,
        row.description,
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

  update(row: RankRow): { changes: number } {
    return this.db.execute(
      `UPDATE ranks SET
         label = ?, tier = ?, description = ?, bind_gold = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE level = ?`,
      [
        row.label,
        row.tier,
        row.description,
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

  findByLevel(level: number): RankRow | undefined {
    return this.db.get<RankRow>("SELECT * FROM ranks WHERE level = ?", [level]);
  }

  /** 分页检索（默认按阶数升序 —— 军衔列表本来就是一张「晋升价目表」） */
  list(options: RankListOptions): RankRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<RankRow>(
      `SELECT * FROM ranks ${clause}
       ORDER BY ${resolveSort(RANK_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: RankListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM ranks ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: RankListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与称号 / 战魂同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(label LIKE ? ESCAPE '\\' OR tier LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (options.tier) {
      where.push("tier = ?");
      params.push(options.tier);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
