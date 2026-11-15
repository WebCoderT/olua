import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { DROP_RECORD_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";
import { DropRecordRow } from "../rows";

/** 一条待写入的流水（自增 id 由库给） */
export type DropRecordInsert = Omit<DropRecordRow, "id">;

/** 流水查询条件（管理端列表与概况共用） */
export interface DropRecordListOptions {
  /** 区（**必须**：管理端一次只在一个区里干活，见 ZoneContextGuard） */
  zoneId: number;
  /** 只看某张图 */
  mapId?: string;
  /** picked / expired / overflow / restart_lost */
  result?: string;
  /** 归属者名字（模糊；用例名里的 `_` 会转义） */
  ownerName?: string;
  /**
   * 来源怪物（模糊）
   *
   * 同时匹配 `monster_key` 与 `monster_label`（落地那一刻的快照）：运营手里通常只有中文名，
   * 而反查页点过来的是精确 key —— 一个输入框兼容两种来源，比让人先查 key 再用。
   */
  monsterKey?: string;
  /** 拾取者名字（模糊；只有 picked 的行有值，其余行筛不出来） */
  pickedName?: string;
  /** 物品 id（精确：运营查「这件东西都掉过谁手里」） */
  goodId?: string;
  /** 起始时间（含，毫秒；按 created_at） */
  from?: number;
  /** 结束时间（含，毫秒） */
  to?: number;
  page: number;
  size: number;
  sort?: string;
  order?: string;
}

/**
 * 掉落**终态流水**（`drop_records`）的读写（#803）
 *
 * ## 谁写谁读
 *
 * - **写**：实时进程的 `DropService`（`resolve()` 攒批、重启清场转 `restart_lost`）——
 *   一次 flush 一条 INSERT 语句写多行（`insertMany`），不为每件掉落单独开事务；
 * - **读**：存档进程的管理端接口（`GET /admin/drops/records` 与 `.../summary`）。
 *
 * 两个进程只有 SQLite 这一条路（同 `MapMonitorRepository` 顶部那段），所以这里的方法
 * 刻意做成「写侧只 append、读侧只 select」的形状：不做更新、不做删除单条 —— 流水是
 * append-only 的历史，唯一会动的只有两道保留闸（条数 / 天数）。
 *
 * ## 为什么读侧也在这里
 *
 * 管理端的两个接口都是「按区 + 若干筛选读这张表」，与写侧共用同一份列名与排序白名单。
 * 拆成两个仓储只会让「列名改一处忘一处」这种事故多一个发生点。
 */
@Injectable()
export class DropRecordRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 一次写一批（一拍掉落的所有终态）
   *
   * 一个事务里多条 INSERT：flushing 100ms 一拍的场景下，单条提交会让 WAL 涨得比数据快。
   * 空数组直接返回，不开事务。
   */
  insertMany(rows: DropRecordInsert[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(INSERT_SQL, [
          row.drop_id,
          row.zone_id,
          row.map_id,
          row.good_id,
          row.good_type,
          row.good_label,
          row.count,
          row.bound,
          row.monster_key,
          row.monster_label,
          row.monster_instance_id,
          row.owner_account_id,
          row.owner_role_id,
          row.owner_name,
          row.result,
          row.reason,
          row.picked_account_id,
          row.picked_role_id,
          row.picked_name,
          row.created_at,
          row.resolved_at,
          row.lived_ms,
        ]);
      }
    });
  }

  /**
   * 一页流水（默认按终态时刻倒序；末尾用 id 兜底，同一毫秒的多条不会翻页重复）
   *
   * **不按 `drop_id` 去重**：`dropId` 的序号每区自增，进程重启后从 1 重新开始 ——
   * 两段进程生命周期里可能生成同一个 `dropId`，而它们的流水都留着（docs/18 §3.5）。
   * 所以稳定排序与翻页的锚点是自增 `id`，`drop_id` 只是个「当时的实体标识」。
   */
  list(options: DropRecordListOptions): DropRecordRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<DropRecordRow>(
      `SELECT * FROM drop_records ${clause}
       ORDER BY ${resolveSort(DROP_RECORD_SORT, options.sort, options.order)}, id DESC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 同一套条件下的总条数（分页用） */
  count(options: DropRecordListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM drop_records ${clause}`, params);
  }

  /**
   * 按结果分组的计数（页面顶部概况卡）
   *
   * 刻意**不吃 `result` 筛选**：传了 `result` 就是「只看 picked」，概况卡再按 picked 分组
   * 只剩一行 —— 那不是概况。其余筛选（图 / 归属人 / 物品 / 时间）照样生效。
   */
  summary(options: DropRecordListOptions): Array<{ result: string; total: number }> {
    const { clause, params } = this.where({ ...options, result: undefined });
    return this.db.all<{ result: string; total: number }>(
      `SELECT result, COUNT(1) AS total FROM drop_records ${clause} GROUP BY result ORDER BY total DESC, result ASC`,
      params,
    );
  }

  /**
   * 裁剪一张图的旧流水，只留最近 `keep` 条（#803 的条数闸）
   *
   * 与 `map_monitor_events` 同一个做法：只在**写入攒够一批**时触发，不是每写一条就 DELETE
   * （每件掉落都删一次会让 WAL 白涨）。条目只在这个区这张图内部收敛，不跨图。
   */
  trimPerMap(zoneId: number, mapId: string, keep: number): number {
    if (keep <= 0) return 0;
    return this.db.execute(
      `DELETE FROM drop_records
       WHERE zone_id = ? AND map_id = ? AND id <= (
         SELECT id FROM drop_records
         WHERE zone_id = ? AND map_id = ?
         ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      [zoneId, mapId, zoneId, mapId, keep],
    ).changes;
  }

  /**
   * 按**时间**删掉过期流水（#803 的天数闸），返回删了几行
   *
   * 条数闸只在写入时触发 —— 它天然管不住「这张图从此没人打怪」：没有写入就没有裁剪。
   * 天数闸扫全表、与图无关，死图的旧流水到点就走。
   */
  trimOlderThan(cutoff: number): number {
    return this.db.execute("DELETE FROM drop_records WHERE created_at < ?", [cutoff]).changes;
  }

  /** 条件拼装（list / count / summary 共用，避免三处条件写岔） */
  private where(options: DropRecordListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = ["zone_id = ?"];
    const params: SqlParam[] = [options.zoneId];
    if (options.mapId) {
      where.push("map_id = ?");
      params.push(options.mapId);
    }
    if (options.result) {
      where.push("result = ?");
      params.push(options.result);
    }
    if (options.goodId) {
      where.push("good_id = ?");
      params.push(options.goodId);
    }
    if (options.ownerName) {
      where.push("owner_name LIKE ? ESCAPE '\\'");
      params.push(likeParam(options.ownerName));
    }
    if (options.monsterKey) {
      // key 与快照名都试：中文名和 `slime_1` 都该能搜到（快照名可能为 null，null LIKE 恒 false）
      where.push("(monster_key LIKE ? ESCAPE '\\' OR monster_label LIKE ? ESCAPE '\\')");
      const pattern = likeParam(options.monsterKey);
      params.push(pattern, pattern);
    }
    if (options.pickedName) {
      where.push("picked_name LIKE ? ESCAPE '\\'");
      params.push(likeParam(options.pickedName));
    }
    if (options.from !== undefined) {
      where.push("created_at >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("created_at <= ?");
      params.push(options.to);
    }
    return { clause: `WHERE ${where.join(" AND ")}`, params };
  }
}

/**
 * 名字类条件的 `%…%` 参数
 *
 * LIKE 的通配符要转义：玩家名里的 `_` 是单字符通配，不转义会把「a_b」也筛出来。
 * 三个模糊条件（归属者 / 怪物 / 拾取者）共用这一处，避免各写一遍写岔。
 */
function likeParam(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

const INSERT_SQL = `INSERT INTO drop_records (
  drop_id, zone_id, map_id, good_id, good_type, good_label, count, bound,
  monster_key, monster_label, monster_instance_id,
  owner_account_id, owner_role_id, owner_name,
  result, reason, picked_account_id, picked_role_id, picked_name,
  created_at, resolved_at, lived_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
