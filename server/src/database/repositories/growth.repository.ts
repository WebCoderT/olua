import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { GrowthScalarRow, GrowthSegmentRow, LevelExpRow } from "../rows";
import { GROWTH_SCALAR_SORT, GROWTH_SEGMENT_SORT, LEVEL_EXP_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 等级经验列表查询条件 */
export interface LevelExpListOptions {
  page: number;
  size: number;
  sort?: string;
  order?: string;
}

/** 成长曲线分段列表查询条件 */
export interface GrowthSegmentListOptions {
  page: number;
  size: number;
  /** 按曲线键筛（maxHp / attack / defense / killsPerLevel） */
  curve?: string;
  sort?: string;
  order?: string;
}

/** 成长标量参数列表查询条件 */
export interface GrowthScalarListOptions {
  page: number;
  size: number;
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 成长曲线数据访问（#256：level_exps / growth_segments / growth_scalars 三张表）
 *
 * 与称号 / 战魂同一取向：**没有 insert / remove 的对外语义** —— 行只能来自启动 seed
 * （`seedRow`，INSERT OR IGNORE 幂等），后台接口只改内容。曲线的形状（几条曲线、几段、
 * 几个标量）由客户端 configs/growth 定义，服务端不提供增删。
 */
@Injectable()
export class GrowthRepository {
  constructor(private readonly db: DatabaseService) {}

  // —— 等级经验 ——

  seedLevelExp(row: LevelExpRow): void {
    this.db.run("INSERT OR IGNORE INTO level_exps (level, exp, updated_at) VALUES (?, ?, ?)", [
      row.level,
      row.exp,
      row.updated_at,
    ]);
  }

  updateLevelExp(row: LevelExpRow): { changes: number } {
    return this.db.execute("UPDATE level_exps SET exp = ?, updated_at = ? WHERE level = ?", [
      row.exp,
      row.updated_at,
      row.level,
    ]);
  }

  findLevelExp(level: number): LevelExpRow | undefined {
    return this.db.get<LevelExpRow>("SELECT * FROM level_exps WHERE level = ?", [level]);
  }

  listLevelExps(options: LevelExpListOptions): LevelExpRow[] {
    return this.db.all<LevelExpRow>(
      `SELECT * FROM level_exps
       ORDER BY ${resolveSort(LEVEL_EXP_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [options.size, (options.page - 1) * options.size],
    );
  }

  countLevelExps(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM level_exps");
  }

  // —— 曲线分段 ——

  seedSegment(row: GrowthSegmentRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO growth_segments (curve, seq, from_level, to_level, start_value, per_level, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.curve, row.seq, row.from_level, row.to_level, row.start_value, row.per_level, row.updated_at],
    );
  }

  updateSegment(row: GrowthSegmentRow): { changes: number } {
    return this.db.execute(
      `UPDATE growth_segments
       SET from_level = ?, to_level = ?, start_value = ?, per_level = ?, updated_at = ?
       WHERE curve = ? AND seq = ?`,
      [row.from_level, row.to_level, row.start_value, row.per_level, row.updated_at, row.curve, row.seq],
    );
  }

  findSegment(curve: string, seq: number): GrowthSegmentRow | undefined {
    return this.db.get<GrowthSegmentRow>("SELECT * FROM growth_segments WHERE curve = ? AND seq = ?", [curve, seq]);
  }

  /** 某条曲线的全部分段（按段序升序 —— 连续性校验按这个顺序做） */
  listSegmentsOfCurve(curve: string): GrowthSegmentRow[] {
    return this.db.all<GrowthSegmentRow>("SELECT * FROM growth_segments WHERE curve = ? ORDER BY seq ASC", [curve]);
  }

  listSegments(options: GrowthSegmentListOptions): GrowthSegmentRow[] {
    const { clause, params } = this.segmentWhere(options);
    return this.db.all<GrowthSegmentRow>(
      `SELECT * FROM growth_segments ${clause}
       ORDER BY ${resolveSort(GROWTH_SEGMENT_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  countSegments(options: GrowthSegmentListOptions): number {
    const { clause, params } = this.segmentWhere(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM growth_segments ${clause}`, params);
  }

  private segmentWhere(options: GrowthSegmentListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.curve) {
      where.push("curve = ?");
      params.push(options.curve);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
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
