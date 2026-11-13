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

  /** 覆盖一间房（区 + 图 + 线）的快照（主键 = zone_id + map_id + slot，#809 起三列） */
  saveState(row: MapMonitorStateRow): void {
    this.db.run(
      `INSERT INTO map_monitor_state (zone_id, map_id, slot, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(zone_id, map_id, slot) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [row.zone_id, row.map_id, row.slot, row.payload, row.updated_at],
    );
  }

  /**
   * 一张图**所有区所有线**的快照（管理端没指定区 / 线时按最新一帧选区）
   *
   * 排序把 `slot` 放进去了（#809）：同一张图同时有多条线的帧时，管理端默认看到的那一帧
   * 应该是**公共线**（`'0'` 排最前），而不是「谁最后写谁赢」。
   */
  listStates(mapId: string): MapMonitorStateRow[] {
    return this.db.all<MapMonitorStateRow>(
      "SELECT * FROM map_monitor_state WHERE map_id = ? ORDER BY updated_at DESC, zone_id ASC, slot ASC",
      [mapId],
    );
  }

  /** 一间房的快照（指定了线时用它；没有就返回 null —— 这条线还没人进过） */
  findState(zoneId: number, mapId: string, slot: string): MapMonitorStateRow | null {
    return (
      this.db.get<MapMonitorStateRow>(
        "SELECT * FROM map_monitor_state WHERE zone_id = ? AND map_id = ? AND slot = ?",
        [zoneId, mapId, slot],
      ) ?? null
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

  /**
   * 按**时间**删掉过期事件（#887），返回删了几行
   *
   * 与上面 `trimEvents`（每图条数）是两道独立的闸，取先到：
   * - 条数闸在**写入时**触发 —— 它天然管不住「这张图从此没人进」，因为没有写入就没有裁剪；
   * - 时间闸扫全表、与图无关 —— 死图的那 2000 条到点就走，不需要有人来往里写东西。
   *
   * 走 `idx_map_monitor_events_at`（`at` 单列索引）：删除条件只按时间，用不上
   * `(zone_id, map_id, id)` 那条的前缀。
   */
  trimOlderThan(cutoff: number): number {
    return this.db.execute("DELETE FROM map_monitor_events WHERE at < ?", [cutoff]).changes;
  }
}
