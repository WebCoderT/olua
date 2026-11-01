import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapRow } from "../rows";

/**
 * 地图玩法配置（`maps` 表，#573）
 *
 * 与称号 / 战魂 / 军衔同一取向：**行只能来自启动 seed**（按资源清单补缺，`INSERT OR IGNORE` 幂等），
 * 运营能改的是**内容**（名称 / 类型 / 进入条件），不能增删行 —— 一张图存不存在由客户端的
 * TMX 决定，后台凭空造一行只会得到一张「点开就黑屏」的地图。
 *
 * 所以这里只有 `seedRow` 一条插入路径，和一条 `update` 改内容。
 */
@Injectable()
export class MapRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已有同 id 的行则跳过 —— 运营改过的值不会被重启盖回来） */
  seedRow(row: MapRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO maps (map_id, label, type, level, combat, soul_of_war, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.map_id, row.label, row.type, row.level, row.combat, row.soul_of_war, row.updated_by, row.updated_at],
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

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM maps");
  }
}
