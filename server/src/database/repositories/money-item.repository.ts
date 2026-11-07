import { Injectable } from "@nestjs/common";
import { MONEY_ITEM_ID_PATTERN, MONEY_KINDS, MoneyKind } from "../../common/constants/money-items";
import { DatabaseService, SqlParam } from "../database.service";
import { MoneyItemRow } from "../rows";
import { MONEY_ITEM_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 货币物品列表查询条件 */
export interface MoneyItemListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 / 描述 */
  keyword?: string;
  /** 只看某种货币（gold / bindGold / silver） */
  currency?: string;
  sort?: string;
  order?: string;
}

/**
 * 货币物品数据访问（#785）
 *
 * 与药品 / 物品那两张表**取向相反**：这里**有** create / update / remove ——
 * 面值是运营自己的事（想开 2000 就开 2000），而且货币道具不被掉落表按 id 引用
 * （它可以出现在任何掉落条目里，但那是运营自己填的，删行只是让那条掉落变成无效引用）。
 *
 * 删除**不碰玩家存档**：背包里还留着已删 id 的格子只是「认不出的道具」，
 * 客户端与结算都是安静跳过（与装备删除同一条口径）。
 */
@Injectable()
export class MoneyItemRepository {
  constructor(private readonly db: DatabaseService) {}

  findByKey(id: string): MoneyItemRow | undefined {
    return this.db.get<MoneyItemRow>("SELECT * FROM money_items WHERE id = ?", [id]);
  }

  /** 全部行（配置快照用；顺序 = 货币 → 面值，客户端背包 / 图鉴按这个顺序陈列） */
  listAll(): MoneyItemRow[] {
    return this.db.all<MoneyItemRow>(
      "SELECT * FROM money_items ORDER BY currency ASC, amount ASC, id ASC",
    );
  }

  /** 某一页（管理端列表） */
  list(options: MoneyItemListOptions): MoneyItemRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<MoneyItemRow>(
      `SELECT * FROM money_items ${clause}
       ORDER BY ${resolveSort(MONEY_ITEM_SORT, options.sort, options.order)}, amount ASC, id ASC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 与 list 同一套条件的总数 */
  count(options: MoneyItemListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM money_items ${clause}`, params);
  }

  insert(row: MoneyItemRow): void {
    this.db.run(
      `INSERT INTO money_items
         (id, label, description, icon, currency, amount, max_stack, sell_price, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.label,
        row.description,
        row.icon,
        row.currency,
        row.amount,
        row.max_stack,
        row.sell_price,
        row.updated_at,
      ],
    );
  }

  update(row: MoneyItemRow): { changes: number } {
    return this.db.execute(
      `UPDATE money_items SET
         label = ?, description = ?, icon = ?, currency = ?, amount = ?,
         max_stack = ?, sell_price = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.description,
        row.icon,
        row.currency,
        row.amount,
        row.max_stack,
        row.sell_price,
        row.updated_at,
        row.id,
      ],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM money_items WHERE id = ?", [id]);
  }

  /** 条件拼装（list / count 共用，避免两处写岔） */
  private where(options: MoneyItemListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.currency && (MONEY_KINDS as readonly string[]).includes(options.currency)) {
      where.push("currency = ?");
      params.push(options.currency as MoneyKind);
    }
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

/** id 是否合法（服务端与 DTO 共用这一份判定，别在两处各写一条正则） */
export function isValidMoneyItemId(id: string): boolean {
  return MONEY_ITEM_ID_PATTERN.test(id);
}
