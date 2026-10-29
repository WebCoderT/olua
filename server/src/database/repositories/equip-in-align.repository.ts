import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { EquipInAlignRow } from "../rows";

/**
 * 装备内观几何数据访问（#523）
 *
 * 与 `EquipAlignRepository` 一样**没有分页 / 排序 / 筛选**：内观只涉及 12 件衣服 + 19 把武器，
 * 工作台一次要把它们全拿在手上（切换时不该再发请求）。`ORDER BY id` 只为让「整份下发」的
 * 字节序稳定，客户端与 e2e 都能按字符串直接比对。
 *
 * 为什么不合并到 `EquipAlignRepository`：两张表的**写操作是独立的** —— 重置内观不能顺手
 * 把外观清掉（反之亦然），一个仓储管两种形状只会让 `upsert` 长出两套字段分支。
 */
@Injectable()
export class EquipInAlignRepository {
  constructor(private readonly db: DatabaseService) {}

  list(): EquipInAlignRow[] {
    return this.db.all<EquipInAlignRow>("SELECT * FROM equip_in_aligns ORDER BY id ASC");
  }

  findById(id: string): EquipInAlignRow | undefined {
    return this.db.get<EquipInAlignRow>("SELECT * FROM equip_in_aligns WHERE id = ?", [id]);
  }

  /**
   * 写一条（有则整份替换，无则插入）
   *
   * UPSERT 而不是「先查再分 insert / update」：保存本来就是整份覆盖的幂等操作，
   * 中间那个「查到了但被别人删了」的窗口只会让幂等接口莫名其妙回 404。
   */
  upsert(row: EquipInAlignRow): void {
    this.db.run(
      `INSERT INTO equip_in_aligns (id, in_scale_x, in_scale_y, in_x, in_y, in_manual, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         in_scale_x = excluded.in_scale_x,
         in_scale_y = excluded.in_scale_y,
         in_x       = excluded.in_x,
         in_y       = excluded.in_y,
         in_manual  = excluded.in_manual,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [row.id, row.in_scale_x, row.in_scale_y, row.in_x, row.in_y, row.in_manual, row.updated_by, row.updated_at],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM equip_in_aligns WHERE id = ?", [id]);
  }
}
