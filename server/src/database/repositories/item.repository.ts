import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { ItemRow } from "../rows";
import { ITEM_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 物品列表查询条件 */
export interface ItemListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 / 描述 */
  keyword?: string;
  /** 按物品大类筛（GOOD_TYPE 的枚举值，如 `material`） */
  type?: string;
  sort?: string;
  order?: string;
}

/**
 * 物品与材料数据访问（#255）
 *
 * 与称号 / 战魂 / 军衔 / 装备 / 药品同一取向：**没有 insert / remove 的对外语义** ——
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除
 * （物品 id 被掉落表与脚本引用，id 清单固定）。
 */
@Injectable()
export class ItemRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: ItemRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO items
        (id, type, label, description, level, sell_price, max_stack, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.type, row.label, row.description, row.level, row.sell_price, row.max_stack, row.updated_at],
    );
  }

  update(row: ItemRow): { changes: number } {
    return this.db.execute(
      `UPDATE items SET
         label = ?, description = ?, sell_price = ?, max_stack = ?, updated_at = ?
       WHERE id = ?`,
      [row.label, row.description, row.sell_price, row.max_stack, row.updated_at, row.id],
    );
  }

  findByKey(id: string): ItemRow | undefined {
    return this.db.get<ItemRow>("SELECT * FROM items WHERE id = ?", [id]);
  }

  /** 分页检索（默认按 id 升序 —— 物品 id 的字典序即分组习惯） */
  list(options: ItemListOptions): ItemRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<ItemRow>(
      `SELECT * FROM items ${clause}
       ORDER BY ${resolveSort(ITEM_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: ItemListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM items ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: ItemListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (options.type) {
      where.push("type = ?");
      params.push(options.type);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
