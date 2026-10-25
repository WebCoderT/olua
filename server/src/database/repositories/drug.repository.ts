import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { DrugRow } from "../rows";
import { DRUG_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 药品列表查询条件 */
export interface DrugListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 / 描述 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 药品数据访问（#253）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**没有 insert / remove 的对外语义** ——
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除
 * （药品 id 被掉落表与背包引用，id 清单固定）。
 */
@Injectable()
export class DrugRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: DrugRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO drugs
        (id, label, description, level, sell_price, max_stack, cooldown,
         effect_hp, effect_mp, effect_hp_percent, effect_mp_percent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.label,
        row.description,
        row.level,
        row.sell_price,
        row.max_stack,
        row.cooldown,
        row.effect_hp,
        row.effect_mp,
        row.effect_hp_percent,
        row.effect_mp_percent,
        row.updated_at,
      ],
    );
  }

  update(row: DrugRow): { changes: number } {
    return this.db.execute(
      `UPDATE drugs SET
         label = ?, description = ?, sell_price = ?, max_stack = ?, cooldown = ?,
         effect_hp = ?, effect_mp = ?, effect_hp_percent = ?, effect_mp_percent = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.description,
        row.sell_price,
        row.max_stack,
        row.cooldown,
        row.effect_hp,
        row.effect_mp,
        row.effect_hp_percent,
        row.effect_mp_percent,
        row.updated_at,
        row.id,
      ],
    );
  }

  findByKey(id: string): DrugRow | undefined {
    return this.db.get<DrugRow>("SELECT * FROM drugs WHERE id = ?", [id]);
  }

  /** 分页检索（默认按 id 升序 —— 8 行的小表，id 字典序即血药组在前蓝药组在后的分组习惯） */
  list(options: DrugListOptions): DrugRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<DrugRow>(
      `SELECT * FROM drugs ${clause}
       ORDER BY ${resolveSort(DRUG_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: DrugListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM drugs ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: DrugListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
