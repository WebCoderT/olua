import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapRow } from "../rows";

/**
 * 地图玩法配置（`maps` 表，#573 / #655）
 *
 * 一行同时带**两类**东西：
 * - 运营可改的玩法字段（名称 / 类型 / 进入条件）—— `update` 只碰这五个；
 * - 资源侧的几何与对象组（格数 / 单格尺寸 / 像素尺寸 / 图层 JSON）—— 来自 TMX，
 *   由 `tools/import-map-resources.cjs` 写入，运营不改（改 TMX 才有意义）。
 *
 * 外加一对可空的 **复活点** 列（#672，`setRevivePoint` 只碰它们）：`null` = 这张图没有复活点。
 * 三组字段各写各的，谁都不顺手刷别人的追账字段。
 *
 * 插入只有 `seedRow` 一条路径：一张图存不存在由客户端的 TMX 决定，后台凭空造一行
 * 只会得到一张「点开就黑屏」的地图。行本身也不在代码里 —— 出厂数据在 `config-sync.sql`。
 */
@Injectable()
export class MapRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已有同 id 的行则跳过 —— 运营改过的值不会被重启盖回来） */
  seedRow(row: MapRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO maps (map_id, label, type, level, combat, soul_of_war,
         grid_cols, grid_rows, tile_width, tile_height, pixel_width, pixel_height, content,
         updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.map_id,
        row.label,
        row.type,
        row.level,
        row.combat,
        row.soul_of_war,
        row.grid_cols,
        row.grid_rows,
        row.tile_width,
        row.tile_height,
        row.pixel_width,
        row.pixel_height,
        row.content,
        row.updated_by,
        row.updated_at,
      ],
    );
  }

  /**
   * 写几何与对象组（导入工具用；可重复执行）
   *
   * 只动那 7 列，不碰运营字段 —— 重跑导入工具不该把运营改的地图名 / 进入条件改回去。
   */
  updateGeometry(row: MapRow): { changes: number } {
    return this.db.execute(
      `UPDATE maps SET grid_cols = ?, grid_rows = ?, tile_width = ?, tile_height = ?,
         pixel_width = ?, pixel_height = ?, content = ?
       WHERE map_id = ?`,
      [
        row.grid_cols,
        row.grid_rows,
        row.tile_width,
        row.tile_height,
        row.pixel_width,
        row.pixel_height,
        row.content,
        row.map_id,
      ],
    );
  }

  /**
   * 全部行，按 **id 数值**升序
   *
   * `map_id` 是 TEXT（"0"…"10"），`ORDER BY map_id` 会把 10 排到 2 前面；
   * 排序只能在 SQL 里按 CAST 做一次，让每个消费方都拿到同一个顺序。
   */
  listAll(): MapRow[] {
    return this.db.all<MapRow>("SELECT * FROM maps ORDER BY CAST(map_id AS INTEGER) ASC, map_id ASC");
  }

  getById(mapId: string): MapRow | null {
    return this.db.get<MapRow>("SELECT * FROM maps WHERE map_id = ?", [mapId]) ?? null;
  }

  /** 改内容（不做部分更新：一张图的五个字段是联动的一组状态，分字段更新会留下上一次的其它字段） */
  update(row: MapRow): void {
    this.db.run(
      `UPDATE maps SET label = ?, type = ?, level = ?, combat = ?, soul_of_war = ?, updated_by = ?, updated_at = ?
       WHERE map_id = ?`,
      [row.label, row.type, row.level, row.combat, row.soul_of_war, row.updated_by, row.updated_at, row.map_id],
    );
  }

  /**
   * 设 / 挪 / 清复活点（#672）
   *
   * 与 `update` / `updateGeometry` 同一条纪律：**只动自己那两列**（改复活点不该顺手把地图名或
   * 几何的追账字段刷一遍）。`cx`/`cy` 同时为 `null` 就是「这张图没有复活点」——
   * 清空是一条 UPDATE 把两列置 NULL，不是删行（行代表地图本身）。
   */
  setRevivePoint(mapId: string, cx: number | null, cy: number | null): void {
    this.db.run("UPDATE maps SET revive_cx = ?, revive_cy = ? WHERE map_id = ?", [cx, cy, mapId]);
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM maps");
  }
}
