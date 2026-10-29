import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { EquipAlignRow } from "../rows";

/**
 * 装备对齐几何数据访问（#513）
 *
 * 只有 33 行（12 件衣服 + 19 把武器 + 2 套裸模），**没有分页 / 排序 / 筛选** ——
 * 工作台一次要看全量（8 个方向同屏比对），按页拿反而是负担。
 * `ORDER BY id` 只为让"整份下发"的字节序稳定，方便客户端与 e2e 比对。
 */
@Injectable()
export class EquipAlignRepository {
  constructor(private readonly db: DatabaseService) {}

  list(): EquipAlignRow[] {
    return this.db.all<EquipAlignRow>("SELECT * FROM equip_aligns ORDER BY id ASC");
  }

  findById(id: string): EquipAlignRow | undefined {
    return this.db.get<EquipAlignRow>("SELECT * FROM equip_aligns WHERE id = ?", [id]);
  }

  /**
   * 写一条（有则整份替换，无则插入）
   *
   * 用 UPSERT 而不是"先查再分 insert / update"：保存本来就是**整份覆盖的幂等操作**，
   * 两条语句中间会留下"查到了但被别人删了"的窗口，而这个窗口的表现是 404 —— 对一个
   * 幂等的保存来说那是最难解释的失败。
   */
  upsert(row: EquipAlignRow): void {
    this.db.run(
      `INSERT INTO equip_aligns (id, out_scale, out_positions, out_manual, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         out_scale     = excluded.out_scale,
         out_positions = excluded.out_positions,
         out_manual    = excluded.out_manual,
         updated_by    = excluded.updated_by,
         updated_at    = excluded.updated_at`,
      [row.id, row.out_scale, row.out_positions, row.out_manual, row.updated_by, row.updated_at],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM equip_aligns WHERE id = ?", [id]);
  }
}
