import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { WorldMonsterRow } from "../rows";

/** 覆盖式写入（同 instance_id 更新，否则插入）——upsert 与 upsertBatch 共用一条 SQL */
const UPSERT_SQL = `INSERT INTO world_monsters
  (instance_id, map_id, monster_key, x, y, hp, max_hp, alive, killed_at, respawn_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(instance_id) DO UPDATE SET
  map_id = excluded.map_id,
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
 * 世界怪物实例的数据访问（#35 世界权威）
 *
 * 表只有服务端一个写者（客户端通过实时通道间接改），所以没有乐观锁列；
 * 写入全部走 `upsert`（同主键覆盖），读按地图取整批 —— 世界服务的两个消费面
 * （tick 重生落盘 / 进图下发快照）各自只用这两条 SQL。
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

  /** 取一张地图的全部实例 */
  listByMap(mapId: string): WorldMonsterRow[] {
    return this.db.all<WorldMonsterRow>("SELECT * FROM world_monsters WHERE map_id = ? ORDER BY instance_id ASC", [mapId]);
  }

  /** 删掉一张地图的全部实例（换版重播种时用；正常游玩不会走到） */
  deleteByMap(mapId: string): void {
    this.db.run("DELETE FROM world_monsters WHERE map_id = ?", [mapId]);
  }

  /** 全表实例数（启动日志 / 运维观察用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM world_monsters");
  }
}
