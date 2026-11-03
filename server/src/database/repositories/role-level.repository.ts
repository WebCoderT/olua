import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { RoleLevelRow } from "../rows";
import { ROLE_LEVEL_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 角色等级列表查询条件 */
export interface RoleLevelListOptions {
  page: number;
  size: number;
  /** 关键字：按等级号精确 / 前缀匹配（等级是数字列，LIKE 只用于「快查第 N 级」） */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 角色等级表数据访问（#655）
 *
 * 一行 = 一个等级的最终裸属性 + 升级经验。**没有 create / remove 的对外语义**：
 * 等级序列固定 1..roleMaxLevel，行只能由迁移脚本一次性写入（`seedRow`），
 * 之后管理端只改内容。曲线（`growth_segments`）已从运行时移除，这里就是权威。
 */
@Injectable()
export class RoleLevelRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 写入一行出厂值（已存在则跳过 —— 运营改过的值不会被重跑迁移覆盖回去） */
  seedRow(row: RoleLevelRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO role_levels
        (level, exp, max_hp, max_mp, hp_recover,
         physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.level,
        row.exp,
        row.max_hp,
        row.max_mp,
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

  update(row: RoleLevelRow): { changes: number } {
    return this.db.execute(
      `UPDATE role_levels SET
         exp = ?, max_hp = ?, max_mp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE level = ?`,
      [
        row.exp,
        row.max_hp,
        row.max_mp,
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

  findByLevel(level: number): RoleLevelRow | undefined {
    return this.db.get<RoleLevelRow>("SELECT * FROM role_levels WHERE level = ?", [level]);
  }

  /** 全量（启动装载覆盖层、快照、导出用；调用方按等级升序消费） */
  listAll(): RoleLevelRow[] {
    return this.db.all<RoleLevelRow>("SELECT * FROM role_levels ORDER BY level ASC");
  }

  list(options: RoleLevelListOptions): RoleLevelRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<RoleLevelRow>(
      `SELECT * FROM role_levels ${clause}
       ORDER BY ${resolveSort(ROLE_LEVEL_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  count(options: RoleLevelListOptions = { page: 1, size: 0 }): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM role_levels ${clause}`, params);
  }

  private where(options: RoleLevelListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("CAST(level AS TEXT) LIKE ? ESCAPE '\\'");
      params.push(like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
