import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MallCategoryRow, MallGoodRow, MallSaleRow } from "../rows";

/**
 * 商城分类与上架商品数据访问（#758）
 *
 * 与称号 / 战魂等配置表**方向相反**：这两张表都**允许动态增删** —— 分类是运营自建的
 * 陈列分组；商品是运营从装备变体里**挑出来上架**的那一部分（商品本体在装备数据里，
 * 这里只存售价与购买等级）。seed 只在存量库迁移时灌「默认分类」，出厂数据为空：
 * 商城开张前运营必须先建分类、再上架商品。
 */
@Injectable()
export class MallRepository {
  constructor(private readonly db: DatabaseService) {}

  //#region 分类

  listCategories(): MallCategoryRow[] {
    return this.db.all<MallCategoryRow>("SELECT * FROM mall_categories ORDER BY sort_order ASC, id ASC");
  }

  findCategory(id: string): MallCategoryRow | undefined {
    return this.db.get<MallCategoryRow>("SELECT * FROM mall_categories WHERE id = ?", [id]);
  }

  insertCategory(row: MallCategoryRow): void {
    this.db.run(
      "INSERT INTO mall_categories (id, label, sort_order, updated_at) VALUES (?, ?, ?, ?)",
      [row.id, row.label, row.sort_order, row.updated_at],
    );
  }

  updateCategory(id: string, fields: { label?: string; sort_order?: number }): void {
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number> = [Date.now()];
    if (fields.label !== undefined) {
      sets.push("label = ?");
      params.push(fields.label);
    }
    if (fields.sort_order !== undefined) {
      sets.push("sort_order = ?");
      params.push(fields.sort_order);
    }
    params.push(id);
    this.db.run(`UPDATE mall_categories SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  deleteCategory(id: string): { changes: number } {
    return this.db.execute("DELETE FROM mall_categories WHERE id = ?", [id]);
  }

  /** 分类下的上架商品数（删除分类前的校验用） */
  countGoodsInCategory(categoryId: string): number {
    return this.count("SELECT COUNT(1) AS total FROM mall_goods WHERE category_id = ?", [categoryId]);
  }

  /**
   * 这一批 id 里有多少行还挂在商城上（#773 删装备前的引用检查）
   *
   * 传入的是「基础件 id + 它的全部变体 id」：商城的商品 id 就是装备变体 id，
   * 所以只要其中任何一个还在架上，这件装备就删不得。
   */
  countGoodsAmong(ids: string[]): number {
    if (ids.length === 0) return 0;
    return this.count(
      `SELECT COUNT(1) AS total FROM mall_goods WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
  }

  //#endregion

  //#region 上架商品

  listGoods(): MallGoodRow[] {
    return this.db.all<MallGoodRow>("SELECT * FROM mall_goods ORDER BY category_id ASC, id ASC");
  }

  findGood(id: string): MallGoodRow | undefined {
    return this.db.get<MallGoodRow>("SELECT * FROM mall_goods WHERE id = ?", [id]);
  }

  insertGood(row: MallGoodRow): void {
    this.db.run(
      "INSERT INTO mall_goods (id, category_id, price, required_level, daily_limit, stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.category_id, row.price, row.required_level, row.daily_limit, row.stock, row.updated_at],
    );
  }

  updateGood(
    id: string,
    fields: { category_id?: string; price?: number; required_level?: number; daily_limit?: number; stock?: number },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number> = [Date.now()];
    if (fields.category_id !== undefined) {
      sets.push("category_id = ?");
      params.push(fields.category_id);
    }
    if (fields.price !== undefined) {
      sets.push("price = ?");
      params.push(fields.price);
    }
    if (fields.required_level !== undefined) {
      sets.push("required_level = ?");
      params.push(fields.required_level);
    }
    if (fields.daily_limit !== undefined) {
      sets.push("daily_limit = ?");
      params.push(fields.daily_limit);
    }
    if (fields.stock !== undefined) {
      sets.push("stock = ?");
      params.push(fields.stock);
    }
    params.push(id);
    this.db.run(`UPDATE mall_goods SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /** 删一条上架商品（下架 —— 商品回到「不在商城售卖」状态） */
  removeGood(id: string): { changes: number } {
    return this.db.execute("DELETE FROM mall_goods WHERE id = ?", [id]);
  }

  //#endregion

  //#region 限购与库存（#846 · 运行时，不进快照）

  /**
   * 事务透传（业务 service 不许直接注入 `DatabaseService`，见 `audit-server-boundaries`）
   *
   * 购买要在**同一个事务**里做「占库存 → 占限购名额 → 扣款入包」：任何一步失败都得把前两步
   * 退回去，否则一次失败购买就白白吃掉一个名额（库存小的商品会被这种空转慢慢吃光）。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  /**
   * 占一件库存：**条件自增**（`sold < stock` 才 +1），返回 false = 已售罄
   *
   * 判据写在 SQL 的 WHERE 里而不是「先查再写」：API 与实时是两个进程、同一份库，
   * 先查再写会在两个请求之间留一道缝（超卖一件的代价是「限量商品凭空多出一件」）。
   * `stock < 0` = 不限量 → 不占位也不计数（列表里那条商品的已售数就一直是 0，符合「不限量」语义）。
   */
  reserveStock(goodId: string, stock: number): boolean {
    if (stock < 0) return true;
    const now = Date.now();
    this.db.run("INSERT OR IGNORE INTO mall_stock (good_id, sold, updated_at) VALUES (?, 0, ?)", [goodId, now]);
    const { changes } = this.db.execute(
      "UPDATE mall_stock SET sold = sold + 1, updated_at = ? WHERE good_id = ? AND sold < ?",
      [now, goodId, stock],
    );
    return changes > 0;
  }

  /** 已卖件数（不限量的商品恒 0；商品没卖过也返回 0） */
  soldOf(goodId: string): number {
    return this.count("SELECT sold AS total FROM mall_stock WHERE good_id = ?", [goodId]);
  }

  /** 全部商品的已卖件数（管理端列表一次取，别逐行查） */
  soldMap(): Map<string, number> {
    const rows = this.db.all<{ good_id: string; sold: number }>("SELECT good_id, sold FROM mall_stock");
    return new Map(rows.map((row) => [row.good_id, Number(row.sold) || 0]));
  }

  /** 重置库存（运营手动续货）：把这一件的已卖数清零，商品重新可买 */
  resetStock(goodId: string): { changes: number } {
    return this.db.execute("UPDATE mall_stock SET sold = 0, updated_at = ? WHERE good_id = ?", [Date.now(), goodId]);
  }

  /**
   * 占一个「今日名额」：**条件自增**（`count < limit` 才 +1），返回 false = 今天买满了
   *
   * `ON CONFLICT ... DO UPDATE ... WHERE` 是原子的「有则加、到上限就不加」：
   * 返回的 changes 就是「加没加上」，不需要先 SELECT 一次再决定。
   * `limit <= 0` = 不限购 → 不占位也不计数。
   */
  reserveDaily(roleId: string, goodId: string, day: number, limit: number): boolean {
    if (limit <= 0) return true;
    const now = Date.now();
    const { changes } = this.db.execute(
      "INSERT INTO mall_sales (role_id, good_id, day, count, updated_at) VALUES (?, ?, ?, 1, ?) " +
        "ON CONFLICT(role_id, good_id, day) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at " +
        "WHERE mall_sales.count < ?",
      [roleId, goodId, day, now, limit],
    );
    return changes > 0;
  }

  /** 今天已经买了几件（只读；给「我的限购」与购买回执用） */
  dailyCountOf(roleId: string, goodId: string, day: number): number {
    return this.count("SELECT count AS total FROM mall_sales WHERE role_id = ? AND good_id = ? AND day = ?", [
      roleId,
      goodId,
      day,
    ]);
  }

  /** 这个角色今天的全部购买计数（一次取，商城弹窗开的时候拉一遍） */
  listSalesOf(roleId: string, day: number): MallSaleRow[] {
    return this.db.all<MallSaleRow>("SELECT * FROM mall_sales WHERE role_id = ? AND day = ? ORDER BY good_id ASC", [
      roleId,
      day,
    ]);
  }

  /**
   * 清掉更早天号的计数（购买链路每天顺手跑一次）
   *
   * 限购只对「今天」有意义，历史行留着没人读 —— 不清就是每个角色每天每件商品一行，
   * 玩家越多长得越快。用天号比较而不是日期字符串：一句话表达「这条落后了」。
   */
  purgeSalesBefore(day: number): { changes: number } {
    return this.db.execute("DELETE FROM mall_sales WHERE day < ?", [day]);
  }

  //#endregion

  private count(sql: string, params: Array<string | number> = []): number {
    const row = this.db.get<{ total: number }>(sql, params);
    return Number(row?.total ?? 0);
  }
}
