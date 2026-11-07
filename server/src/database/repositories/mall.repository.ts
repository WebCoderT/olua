import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MallCategoryRow, MallGoodRow } from "../rows";

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
      "INSERT INTO mall_goods (id, category_id, price, required_level, updated_at) VALUES (?, ?, ?, ?, ?)",
      [row.id, row.category_id, row.price, row.required_level, row.updated_at],
    );
  }

  updateGood(id: string, fields: { category_id?: string; price?: number; required_level?: number }): void {
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
    params.push(id);
    this.db.run(`UPDATE mall_goods SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /** 删一条上架商品（下架 —— 商品回到「不在商城售卖」状态） */
  removeGood(id: string): { changes: number } {
    return this.db.execute("DELETE FROM mall_goods WHERE id = ?", [id]);
  }

  //#endregion

  private count(sql: string, params: Array<string | number> = []): number {
    const row = this.db.get<{ total: number }>(sql, params);
    return Number(row?.total ?? 0);
  }
}
