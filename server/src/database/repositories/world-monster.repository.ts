import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { WorldMonsterRow } from "../rows";

/** 覆盖式写入（同 instance_id 更新，否则插入）——upsert 与 upsertBatch 共用一条 SQL */
const UPSERT_SQL = `INSERT INTO world_monsters
  (instance_id, map_id, zone_id, monster_key, x, y, hp, max_hp, alive, killed_at, respawn_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(instance_id) DO UPDATE SET
  map_id = excluded.map_id,
  zone_id = excluded.zone_id,
  monster_key = excluded.monster_key,
  x = excluded.x,
  y = excluded.y,
  hp = excluded.hp,
  max_hp = excluded.max_hp,
  alive = excluded.alive,
  killed_at = excluded.killed_at,
  respawn_at = excluded.respawn_at,
  updated_at = excluded.updated_at`;

/** 行 → SQL 参数（列顺序与 UPSERT_SQL 的占位符一一对应） */
function rowParams(row: WorldMonsterRow): (string | number | null)[] {
  return [
    row.instance_id,
    row.map_id,
    row.zone_id,
    row.monster_key,
    row.x,
    row.y,
    row.hp,
    row.max_hp,
    row.alive,
    row.killed_at,
    row.respawn_at,
    row.updated_at,
  ];
}

/**
 * 世界怪物实例的数据访问（#35 世界权威；#295 阶段二起带区维度）
 *
 * 表只有服务端一个写者（客户端通过实时通道间接改），所以没有乐观锁列；
 * 写入全部走 `upsert`（同主键覆盖），读按「区（+ 地图）」取整批 —— 世界服务的两个消费面
 * （tick 重生落盘 / 进图下发快照）用 listByZoneMap，合并区重排用 listByZone。
 */
@Injectable()
export class WorldMonsterRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 覆盖式写入一只实例（同 instance_id 更新，否则插入） */
  upsert(row: WorldMonsterRow): void {
    this.db.run(UPSERT_SQL, rowParams(row));
  }

  /** 批量覆盖写入（一个事务：tick 的节流落盘与关机 flush 都走这里，写放大只到事务级别） */
  upsertBatch(rows: WorldMonsterRow[]): void {
    this.db.transaction(() => {
      for (const row of rows) this.db.run(UPSERT_SQL, rowParams(row));
    });
  }

  /** 取一个区一张地图的全部实例（世界加载 / 合并区重排都按这个口径读） */
  listByZoneMap(zoneId: number, mapId: string): WorldMonsterRow[] {
    return this.db.all<WorldMonsterRow>(
      "SELECT * FROM world_monsters WHERE zone_id = ? AND map_id = ? ORDER BY instance_id ASC",
      [zoneId, mapId],
    );
  }

  /** 取一个区的全部实例（合并区时整批读出来重排 instanceId） */
  listByZone(zoneId: number): WorldMonsterRow[] {
    return this.db.all<WorldMonsterRow>(
      "SELECT * FROM world_monsters WHERE zone_id = ? ORDER BY map_id ASC, instance_id ASC",
      [zoneId],
    );
  }

  /** 改写一只实例的 instanceId（合并区重排发牌用；zone_id 一并在同一句里落） */
  rekey(oldInstanceId: string, row: WorldMonsterRow): void {
    this.db.run(
      `UPDATE world_monsters SET
        instance_id = ?, map_id = ?, zone_id = ?, monster_key = ?, x = ?, y = ?,
        hp = ?, max_hp = ?, alive = ?, killed_at = ?, respawn_at = ?, updated_at = ?
       WHERE instance_id = ?`,
      [...rowParams(row), oldInstanceId],
    );
  }

  /** 全表实例数（启动日志 / 运维观察用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM world_monsters");
  }
}
