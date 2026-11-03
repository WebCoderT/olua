import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { GrowthScalarRow, LevelExpRow } from "../rows";
import { GROWTH_SCALAR_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 成长标量参数列表查询条件 */
export interface GrowthScalarListOptions {
  page: number;
  size: number;
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 升级经验的数据访问（#655：**权威表 = `role_levels.exp`**，与 60 行属性同居一行）
 *
 * 为什么还留在这里：`roles.service` 的升级判定走本仓储。以前它读 `level_exps`，
 * 现在读 `role_levels` —— 表没了还留着旧读法就会「管理端改了经验、玩家按旧值升级」。
 * 老库的 `level_exps` 由 `make data-migrate` 一次性搬进 `role_levels` 后删除。
 */
@Injectable()
export class GrowthRepository {
  constructor(private readonly db: DatabaseService) {}

  // —— 等级经验 ——

  updateLevelExp(row: LevelExpRow): { changes: number } {
    return this.db.execute("UPDATE role_levels SET exp = ?, updated_at = ? WHERE level = ?", [
      row.exp,
      row.updated_at,
      row.level,
    ]);
  }

  findLevelExp(level: number): LevelExpRow | undefined {
    return this.db.get<LevelExpRow>("SELECT level, exp, updated_at FROM role_levels WHERE level = ?", [level]);
  }

  // —— 标量参数 ——

  seedScalar(row: GrowthScalarRow): void {
    this.db.run("INSERT OR IGNORE INTO growth_scalars (key, value, description, updated_at) VALUES (?, ?, ?, ?)", [
      row.key,
      row.value,
      row.description,
      row.updated_at,
    ]);
  }

  updateScalar(row: GrowthScalarRow): { changes: number } {
    return this.db.execute("UPDATE growth_scalars SET value = ?, updated_at = ? WHERE key = ?", [
      row.value,
      row.updated_at,
      row.key,
    ]);
  }

  findScalar(key: string): GrowthScalarRow | undefined {
    return this.db.get<GrowthScalarRow>("SELECT * FROM growth_scalars WHERE key = ?", [key]);
  }

  listScalars(options: GrowthScalarListOptions): GrowthScalarRow[] {
    const { clause, params } = this.scalarWhere(options);
    return this.db.all<GrowthScalarRow>(
      `SELECT * FROM growth_scalars ${clause}
       ORDER BY ${resolveSort(GROWTH_SCALAR_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  countScalars(options: GrowthScalarListOptions): number {
    const { clause, params } = this.scalarWhere(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM growth_scalars ${clause}`, params);
  }

  private scalarWhere(options: GrowthScalarListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与称号 / 战魂同一手法），键与说明都参与匹配
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(key LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
