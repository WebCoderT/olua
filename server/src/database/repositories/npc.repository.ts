import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { NpcRow } from "../rows";
import { NPC_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** NPC 列表查询条件 */
export interface NpcListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * NPC 基础数据访问（#258）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**没有 insert / remove 的对外语义** ——
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除
 * （NPC id 被 Tiled 地图对象组引用，清单固定）。
 */
@Injectable()
export class NpcRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: NpcRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO npcs (id, label, dialog, updated_at) VALUES (?, ?, ?, ?)`,
      [row.id, row.label, row.dialog, row.updated_at],
    );
  }

  update(row: NpcRow): { changes: number } {
    return this.db.execute(`UPDATE npcs SET label = ?, dialog = ?, updated_at = ? WHERE id = ?`, [
      row.label,
      row.dialog,
      row.updated_at,
      row.id,
    ]);
  }

  findByKey(id: string): NpcRow | undefined {
    return this.db.get<NpcRow>("SELECT * FROM npcs WHERE id = ?", [id]);
  }

  /** 分页检索（默认按 id 升序 —— id 的分段习惯即功能分组） */
  list(options: NpcListOptions): NpcRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<NpcRow>(
      `SELECT * FROM npcs ${clause}
       ORDER BY ${resolveSort(NPC_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: NpcListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM npcs ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: NpcListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
