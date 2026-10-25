import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapSpawnAreaRow } from "../rows";

/**
 * 刷怪区数据访问（#295 阶段一：刷怪区配置归服务端）
 *
 * 与称号 / 战魂 / 军衔同一取向：**没有对外的 insert / remove 语义** ——
 * 行只能来自启动 seed（表空时从 SPAWN_AREAS 快照灌入，INSERT OR IGNORE 幂等）
 * 或导入工具 `tools/import-spawn-areas.cjs --db` 整份替换；后台接口暂不开放增删
 * （后续收口成管理页时再补）。快照是唯一真相，运营手改行会被下一次导入覆盖。
 */
@Injectable()
export class MapSpawnAreaRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（同图同名已存在则跳过） */
  seedRow(row: Omit<MapSpawnAreaRow, "id">): void {
    this.db.run(
      `INSERT OR IGNORE INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.map_id, row.name, row.monster_key, row.min, row.max, row.cx, row.cy, row.w, row.h, row.updated_at],
    );
  }

  /** 一张图的全部刷怪区（按 id 升序 = 导入顺序，发牌可复现） */
  listByMap(mapId: string): MapSpawnAreaRow[] {
    return this.db.all<MapSpawnAreaRow>("SELECT * FROM map_spawn_areas WHERE map_id = ? ORDER BY id ASC", [mapId]);
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM map_spawn_areas");
  }
}
