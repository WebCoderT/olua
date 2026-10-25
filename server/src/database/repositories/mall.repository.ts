import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MallPriceRow, MallSettingsRow } from "../rows";

/**
 * 商城定价数据访问（#251）
 *
 * 与称号 / 战魂等配置表**方向相反**：`mall_prices` **允许动态增删** —— 定价是运营数据，
 * 商品本体（装备清单）来自生成物，不归这里管。`mall_settings` 是单行表（id 恒为 1），
 * seed 自生成物 MALL_DEFAULT_PRICE，运营可改。
 */
@Injectable()
export class MallRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 统一价单行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedSettings(defaultPrice: number): void {
    this.db.run(`INSERT OR IGNORE INTO mall_settings (id, default_price, updated_at) VALUES (1, ?, 0)`, [defaultPrice]);
  }

  getSettings(): MallSettingsRow | undefined {
    return this.db.get<MallSettingsRow>("SELECT * FROM mall_settings WHERE id = 1");
  }

  updateSettings(defaultPrice: number): void {
    this.db.run(`UPDATE mall_settings SET default_price = ?, updated_at = ? WHERE id = 1`, [defaultPrice, Date.now()]);
  }

  /** 全部特殊价行（商品清单在生成物里，列表由 service 合并后内存分页） */
  listAll(): MallPriceRow[] {
    return this.db.all<MallPriceRow>("SELECT * FROM mall_prices ORDER BY id ASC");
  }

  findByKey(goodId: string): MallPriceRow | undefined {
    return this.db.get<MallPriceRow>("SELECT * FROM mall_prices WHERE id = ?", [goodId]);
  }

  /** upsert 一条特殊价（存在则改价，不存在则新增 —— 定价行动态增删的「增/改」半边） */
  upsert(row: MallPriceRow): void {
    this.db.run(
      `INSERT INTO mall_prices (id, price, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`,
      [row.id, row.price, row.updated_at],
    );
  }

  /** 删一条特殊价（商品回到统一价 —— 「删」半边） */
  remove(goodId: string): { changes: number } {
    return this.db.execute("DELETE FROM mall_prices WHERE id = ?", [goodId]);
  }
}
