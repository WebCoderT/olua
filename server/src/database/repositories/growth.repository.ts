import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { GrowthScalarRow } from "../rows";
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
 * 成长标量的数据访问
 *
 * #786：升级经验与每级属性都不是表了（`role_levels` 已删），改由
 * `role_level_curves` 的曲线段求值（见 `RoleLevelCurveRepository` 与
 * `common/constants/role-level-curve.ts`）。这里只剩「全线一个数」的标量参数。
 */
@Injectable()
export class GrowthRepository {
  constructor(private readonly db: DatabaseService) {}

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
