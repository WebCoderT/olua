import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MonsterPresentationRow } from "../rows";

/**
 * 怪物表现 / 资源（`monster_presentation` 表，#655）
 *
 * 一行 = 一只怪的图集路径 + 基准帧几何 + AI 视觉参数。原来的书写处是生成物
 * `monster-presentation.generated.ts`（`client/tools/gen-monster-config.cjs` 从图集
 * 实测 trim）。现在生成器**直接写库**，运行时只读这张表 —— 代码里不再有第三份副本。
 *
 * 没有 `list` / `update` 之外的口子，也没有管理端写接口：这是资源侧数据，
 * 运营改它没有意义（改了图不对齐）。要改就改客户端资源再重跑生成器。
 */
@Injectable()
export class MonsterPresentationRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 生成器/导入工具用：整行写入（同 id 覆盖 —— 这张表的真相就是资源文件） */
  upsert(row: MonsterPresentationRow): void {
    this.db.run(
      `INSERT INTO monster_presentation
         (id, icon, out, out_offset_x, out_offset_y, content_width, content_height,
          move_speed, aggressive, detect_range, speed_rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         icon = excluded.icon,
         out = excluded.out,
         out_offset_x = excluded.out_offset_x,
         out_offset_y = excluded.out_offset_y,
         content_width = excluded.content_width,
         content_height = excluded.content_height,
         move_speed = excluded.move_speed,
         aggressive = excluded.aggressive,
         detect_range = excluded.detect_range,
         speed_rate = excluded.speed_rate,
         updated_at = excluded.updated_at`,
      [
        row.id,
        row.icon,
        row.out,
        row.out_offset_x,
        row.out_offset_y,
        row.content_width,
        row.content_height,
        row.move_speed,
        row.aggressive,
        row.detect_range,
        row.speed_rate,
        row.updated_at,
      ],
    );
  }

  /**
   * 全部行，按 **id 数值**升序（与客户端图集命名一致）
   *
   * `id` 是 TEXT，`ORDER BY id` 会把 "10" 排在 "2" 前面 —— 快照里顺序一变，
   * 客户端 diff 就整份重下，所以排序在 SQL 里定一次。
   */
  listAll(): MonsterPresentationRow[] {
    return this.db.all<MonsterPresentationRow>(
      "SELECT * FROM monster_presentation ORDER BY CAST(id AS INTEGER) ASC, id ASC",
    );
  }

  getById(id: string): MonsterPresentationRow | null {
    return this.db.get<MonsterPresentationRow>("SELECT * FROM monster_presentation WHERE id = ?", [id]) ?? null;
  }

  count(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM monster_presentation");
  }
}
