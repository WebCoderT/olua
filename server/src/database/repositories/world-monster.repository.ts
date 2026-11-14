import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { WorldMonsterRow } from "../rows";

/** 覆盖式写入（同 instance_id 更新，否则插入）——upsert 与 upsertBatch 共用一条 SQL */
const UPSERT_SQL = `INSERT INTO world_monsters
  (instance_id, map_id, zone_id, slot, monster_key, area_id, x, y, hp, max_hp, alive, killed_at, respawn_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(instance_id) DO UPDATE SET
  map_id = excluded.map_id,
  zone_id = excluded.zone_id,
  slot = excluded.slot,
  monster_key = excluded.monster_key,
  area_id = excluded.area_id,
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
    row.slot,
    row.monster_key,
    row.area_id,
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
 * 世界怪物实例的数据访问（#35 世界权威；#295 阶段二起带区维度；#809 起带线维度）
 *
 * 表只有服务端一个写者（客户端通过实时通道间接改），所以没有乐观锁列；
 * 写入全部走 `upsert`（同主键覆盖），读按「房间（区 + 图 + 线）」取整批 ——
 * 世界服务的两个消费面（tick 重生落盘 / 进图下发快照）用 listByRoom，
 * 合并区重排用 listByZone。
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

  /**
   * 取**一间房**的全部实例（世界加载 / 单图重载都按这个口径读）
   *
   * 从 `listByZoneMap` 改名（#809）：分线之后「一张图」不等于「一份世界」，
   * 少了 slot 这一段，公共线和 2 线会读到同一批实例。
   */
  listByRoom(zoneId: number, mapId: string, slot: string): WorldMonsterRow[] {
    return this.db.all<WorldMonsterRow>(
      "SELECT * FROM world_monsters WHERE zone_id = ? AND map_id = ? AND slot = ? ORDER BY instance_id ASC",
      [zoneId, mapId, slot],
    );
  }

  /** 取一个区的全部实例（合并区时整批读出来重排 instanceId） */
  listByZone(zoneId: number): WorldMonsterRow[] {
    return this.db.all<WorldMonsterRow>(
      "SELECT * FROM world_monsters WHERE zone_id = ? ORDER BY map_id ASC, instance_id ASC",
      [zoneId],
    );
  }

  /** 一个区有多少只实例（#961 区服列表的聚合列） */
  countByZone(zoneId: number): number {
    return this.db.count("SELECT COUNT(1) AS total FROM world_monsters WHERE zone_id = ?", [zoneId]);
  }

  /** 改写一只实例的 instanceId（合并区重排发牌用；zone_id / slot 一并在同一句里落） */
  rekey(oldInstanceId: string, row: WorldMonsterRow): void {
    this.db.run(
      `UPDATE world_monsters SET
        instance_id = ?, map_id = ?, zone_id = ?, slot = ?, monster_key = ?, area_id = ?, x = ?, y = ?,
        hp = ?, max_hp = ?, alive = ?, killed_at = ?, respawn_at = ?, updated_at = ?
       WHERE instance_id = ?`,
      [...rowParams(row), oldInstanceId],
    );
  }

  /**
   * 按 instanceId 整批删除（#852 密度裁剪：`alive > target` 时删掉多出来的几只）
   *
   * 一个事务删完：裁剪发生在 tick 里，删一半就报错会让「内存里删了、库里还在」——
   * 下次加载又把它们全捞回来，看着像杀不干净。
   */
  removeMany(instanceIds: string[]): void {
    if (instanceIds.length === 0) return;
    this.db.transaction(() => {
      for (const instanceId of instanceIds) this.db.run("DELETE FROM world_monsters WHERE instance_id = ?", [instanceId]);
    });
  }

  /**
   * 删掉**一间房**的全部实例（#809 单图热重载：整份重播之前先清干净）
   *
   * 按房间删而不是按 instanceId 列表删：重播的新实例要沿用同一批 id 前缀，
   * 「先删库再播种」比「算出哪些该删」少一次口径不一致的机会。
   * @returns 删掉的行数
   */
  removeByRoom(zoneId: number, mapId: string, slot: string): number {
    return this.db.execute("DELETE FROM world_monsters WHERE zone_id = ? AND map_id = ? AND slot = ?", [
      zoneId,
      mapId,
      slot,
    ]).changes;
  }

  /** 全表实例数（启动日志 / 运维观察用） */
  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM world_monsters");
  }

  /**
   * 每图每区的实例数与存活数（管理端地图页只读展示，%571）
   *
   * 只读聚合：世界服务自己的播种 / 重生逻辑不读它，避免「为了看统计而多写一条路径」。
   * `alive` 在库里是 0/1，SUM 出来就是存活只数。按 (图, 区, 线) 分组（#809）——
   * 分线之后「这张图几只怪」必须按线分开看，否则 1 线一只都没刷也会显示成满编。
   */
  countByMap(): Array<{ map_id: string; zone_id: number; slot: string; total: number; alive: number }> {
    return this.db.all<{ map_id: string; zone_id: number; slot: string; total: number; alive: number }>(
      `SELECT map_id, zone_id, slot, COUNT(1) AS total, SUM(alive) AS alive
       FROM world_monsters GROUP BY map_id, zone_id, slot ORDER BY map_id ASC, zone_id ASC, slot ASC`,
    );
  }
}
