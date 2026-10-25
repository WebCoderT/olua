import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { DropTableRow } from "../rows";

/**
 * 具名掉落表数据访问（#254）
 *
 * **允许动态增删**（同 mall_prices 的定位：运营自建新表给多怪复用）——
 * 有完整的 insert / update / remove；remove 前的「是否被 monster_drops 引用」
 * 检查在 service（需要跨表查询，这里的 remove 只管删行）。
 */
@Injectable()
export class DropTableRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: DropTableRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO drop_tables (id, picks, entries, updated_at) VALUES (?, ?, ?, ?)`,
      [row.id, row.picks, row.entries, row.updated_at],
    );
  }

  insert(row: DropTableRow): void {
    this.db.run(
      `INSERT INTO drop_tables (id, picks, entries, updated_at) VALUES (?, ?, ?, ?)`,
      [row.id, row.picks, row.entries, row.updated_at],
    );
  }

  update(row: DropTableRow): void {
    this.db.execute(
      `UPDATE drop_tables SET picks = ?, entries = ?, updated_at = ? WHERE id = ?`,
      [row.picks, row.entries, row.updated_at, row.id],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute(`DELETE FROM drop_tables WHERE id = ?`, [id]);
  }

  findByKey(id: string): DropTableRow | undefined {
    return this.db.get<DropTableRow>("SELECT * FROM drop_tables WHERE id = ?", [id]);
  }

  list(): DropTableRow[] {
    return this.db.all<DropTableRow>("SELECT * FROM drop_tables ORDER BY id ASC");
  }

  /** 被某只怪引用的检查用：引用该表的 monster_drops 行数 */
  countMonsterReferences(id: string): number {
    return this.db.count("SELECT COUNT(1) AS total FROM monster_drops WHERE table_id = ?", [id]);
  }

  /** 全部表 id（e2e / 校验用） */
  ids(): string[] {
    return this.list().map((row) => row.id);
  }
}
