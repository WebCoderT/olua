import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { MonsterDropRow } from "../rows";
import { MONSTER_DROP_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 每怪掉落列表查询条件 */
export interface MonsterDropListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配怪物 key */
  keyword?: string;
  /** 按来源筛：table / entries / none */
  source?: string;
  sort?: string;
  order?: string;
}

/**
 * 每怪掉落配置数据访问（#254）
 *
 * 行与怪物一一对应（monster_key 主键，清单固定不可增删）——只有 seed（INSERT OR IGNORE
 * 幂等）与 update（PATCH 整份替换），没有 insert / remove 的对外语义。
 * 将来的服务端掉落结算直读本表（与 monsters 表同一读法，改表即时生效）。
 */
@Injectable()
export class MonsterDropRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: MonsterDropRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO monster_drops (monster_key, source, table_id, picks, entries, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.monster_key, row.source, row.table_id, row.picks, row.entries, row.updated_at],
    );
  }

  update(row: MonsterDropRow): void {
    this.db.execute(
      `UPDATE monster_drops SET source = ?, table_id = ?, picks = ?, entries = ?, updated_at = ?
       WHERE monster_key = ?`,
      [row.source, row.table_id, row.picks, row.entries, row.updated_at, row.monster_key],
    );
  }

  findByKey(monsterKey: string): MonsterDropRow | undefined {
    return this.db.get<MonsterDropRow>("SELECT * FROM monster_drops WHERE monster_key = ?", [monsterKey]);
  }

  /** 分页检索（默认按 key 数值升序 —— 与怪物配置页同一动线） */
  list(options: MonsterDropListOptions): MonsterDropRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<MonsterDropRow>(
      `SELECT * FROM monster_drops ${clause}
       ORDER BY ${resolveSort(MONSTER_DROP_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: MonsterDropListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM monster_drops ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: MonsterDropListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("monster_key LIKE ? ESCAPE '\\'");
      params.push(like);
    }
    if (options.source) {
      where.push("source = ?");
      params.push(options.source);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
