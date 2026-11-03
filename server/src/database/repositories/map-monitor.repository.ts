import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MapMonitorEventRow, MapMonitorStateRow } from "../rows";

/**
 * 实时地图监控的镜像存取（#665）
 *
 * ## 谁写谁读
 *
 * - **写**：实时进程的 `MapMonitorService`（每秒采样一次世界状态）+ 击杀事件（结算侧）；
 * - **读**：存档进程的 `/admin/maps/:id/monitor`（地图管理页的实时监控弹窗）。
 *
 * 两个进程只有 SQLite 这一条路，所以这里的读写方法刻意做成「写侧只 upsert/append、
 * 读侧只 select」的最简形状：不提供删除单条、不做乐观锁 —— 它不是业务数据，
 * 是**运行时的投影**，谁最后写谁算。
 */
@Injectable()
export class MapMonitorRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 覆盖一个区一张图的快照（主键 = zone_id + map_id） */
  saveState(row: MapMonitorStateRow): void {
    this.db.run(
      `INSERT INTO map_monitor_state (zone_id, map_id, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(zone_id, map_id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [row.zone_id, row.map_id, row.payload, row.updated_at],
    );
  }

  /** 一张图**所有区**的快照（管理端没指定区时按最新一帧选区） */
  listStates(mapId: string): MapMonitorStateRow[] {
    return this.db.all<MapMonitorStateRow>(
      "SELECT * FROM map_monitor_state WHERE map_id = ? ORDER BY updated_at DESC, zone_id ASC",
      [mapId],
    );
  }

  /** 追加一条文字事件，返回它的自增 id（= 管理端轮询的游标） */
  appendEvent(row: Omit<MapMonitorEventRow, "id">): number {
    this.db.run("INSERT INTO map_monitor_events (zone_id, map_id, at, kind, payload) VALUES (?, ?, ?, ?, ?)", [
      row.zone_id,
      row.map_id,
      row.at,
      row.kind,
      row.payload,
    ]);
    return Number(this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
  }

  /**
   * 取游标之后的事件（按 id 升序 = 时间顺序）
   *
   * `since` = 上一次拿到的最大 id；传 0 表示「最新的 limit 条」（第一次打开页面时
   * 应该看到的是最近发生的事，而不是这张图从开服以来的全部历史）。
   */
  listEvents(zoneId: number, mapId: string, since: number, limit: number): MapMonitorEventRow[] {
    if (since > 0) {
      return this.db.all<MapMonitorEventRow>(
        "SELECT * FROM map_monitor_events WHERE zone_id = ? AND map_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
        [zoneId, mapId, since, limit],
      );
    }
    const rows = this.db.all<MapMonitorEventRow>(
      "SELECT * FROM map_monitor_events WHERE zone_id = ? AND map_id = ? ORDER BY id DESC LIMIT ?",
      [zoneId, mapId, limit],
    );
    return rows.reverse();
  }

  /**
   * 裁剪一个区一张图的旧事件，只留最近 `keep` 条
   *
   * 监控页是「看最近发生了什么」，不是审计（要追溯去看 audit_logs）。不裁剪的话
   * 高频刷怪服一天能攒出几十万行，而它们既没人看又拖慢每次读取。
   */
  trimEvents(zoneId: number, mapId: string, keep: number): number {
    return this.db.execute(
      `DELETE FROM map_monitor_events
       WHERE zone_id = ? AND map_id = ? AND id <= (
         SELECT id FROM map_monitor_events
         WHERE zone_id = ? AND map_id = ?
         ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      [zoneId, mapId, zoneId, mapId, keep],
    ).changes;
  }
}
