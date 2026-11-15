import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { WorldDropRow } from "../rows";
import { DROP_GROUND_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 当前地面掉落的查询条件（管理端监控页，#805） */
export interface DropGroundListOptions {
  /** 区（**必须**：管理端一次只在一个区里干活，见 ZoneContextGuard） */
  zoneId: number;
  /** 只看某张图 */
  mapId?: string;
  /** 物品 id 模糊（表里没有物品名，名字由调用方按配置拼） */
  keyword?: string;
  /** 归属者角色名（模糊；`_` / `%` 会转义） */
  ownerName?: string;
  page: number;
  size: number;
  sort?: string;
  order?: string;
}

/** 地面概况的一组（按图分组的一行） */
export interface DropGroundSummaryRow {
  map_id: string;
  total: number;
  protected_total: number;
  expiring_total: number;
}

/**
 * 地面掉落物的**投影表**读写（`world_drops`；#802）
 *
 * ## 为什么是投影，不是权威
 *
 * 掉落的权威在实时进程的内存里（`DropService.ground`）：拾取是每秒都可能发生的操作，
 * 每条 pick 一次事务太贵，而落点 / 保护期 / 距离校验又都要读**同一份**内存状态。
 * 这张表只做两件事：
 *
 * 1. 让**另一个进程**（管理端 API）能回答「这张图现在地上有什么」；
 * 2. 让**重启**这一刻能知道「上一进程留下多少件要作废」（记数 + 清表）。
 *
 * 所以这里的写频率由 DropService 决定（100ms 批量一拍），没有乐观锁列，也没有
 * 「客户端上报」这回事 —— 读的一方永远只读。
 *
 * ## 为什么单独一个仓储
 *
 * 服务端的纪律是「SQL 收在仓储，业务不摸 DatabaseService」（`audit-server-boundaries`）。
 * 掉落虽然是实时域的内存状态，落到盘上的这两张表（`world_drops` / `drop_records`）仍要
 * 有唯一的读写口 —— #803 的终态流水、#805 的管理端列表都从这里进。
 */
@Injectable()
export class WorldDropRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 全部残留行（只取 id：启动日志「上一进程留下多少件」用） */
  listAllIds(): string[] {
    return this.db.all<{ drop_id: string }>("SELECT drop_id FROM world_drops").map((row) => row.drop_id);
  }

  /**
   * 全部残留行（完整行）
   *
   * 重启清场要拿它把每一件转成一条 `restart_lost` 流水（#803）—— 只删不记的话，
   * 「上一进程地上那些东西最后怎么了」就永远没人答得上来。行数上限是 `maxGroundPerMap × 图数`，
   * 一次全读没有压力。
   */
  listAll(): WorldDropRow[] {
    return this.db.all<WorldDropRow>("SELECT * FROM world_drops ORDER BY created_at ASC");
  }

  /** 一张图的全部行（管理端「当前地面」用；区是服务端参数，不是请求参数） */
  listByRoom(zoneId: number, mapId: string): WorldDropRow[] {
    return this.db.all<WorldDropRow>(
      "SELECT * FROM world_drops WHERE zone_id = ? AND map_id = ? ORDER BY created_at ASC",
      [zoneId, mapId],
    );
  }

  /** 一件掉落（按 dropId；`dropId` 本身就是全局唯一主键） */
  findById(dropId: string): WorldDropRow | undefined {
    return this.db.get<WorldDropRow>("SELECT * FROM world_drops WHERE drop_id = ?", [dropId]);
  }

  /**
   * 一页「当前地面」（管理端监控页，#805）
   *
   * 读的是**投影**：实时进程 100ms 批量刷一次，所以这里看到的落后最多一拍 ——
   * 接口文案里不承诺毫秒级精确，也别拿它做「是否已捡走」的判定（那是 `drop_records` 的事）。
   *
   * 末尾用 `drop_id` 兜底让分页稳定：按 `expire_at` 排序时同一毫秒的多件会并列，
   * 没有 tiebreaker 就会翻页重复 / 漏行。
   */
  listGround(options: DropGroundListOptions): WorldDropRow[] {
    const { clause, params } = this.groundWhere(options);
    return this.db.all<WorldDropRow>(
      `SELECT * FROM world_drops ${clause}
       ORDER BY ${resolveSort(DROP_GROUND_SORT, options.sort, options.order)}, drop_id ASC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 同一套条件下的总件数（分页用） */
  countGround(options: DropGroundListOptions): number {
    const { clause, params } = this.groundWhere(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM world_drops ${clause}`, params);
  }

  /**
   * 地面概况：按图分组的件数 + 保护中 + 1 分钟内将过期（#805 概况卡）
   *
   * 一次 `GROUP BY map_id` 拿全，调用方再横向求和 —— 三次独立 COUNT 会让三格数字
   * 落在不同的时间点上（投放 / 拾取正在发生），加起来对不上。
   *
   * 「将过期」用 `expire_at > now AND <= now + windowMs`：已过期的行理论上不在投影里
   * （扫描器 1s 一拍），但真有残留时不该把它算进「即将过期」。
   */
  summaryGround(options: DropGroundListOptions, now: number, windowMs: number): DropGroundSummaryRow[] {
    const { clause, params } = this.groundWhere(options);
    return this.db.all<DropGroundSummaryRow>(
      `SELECT map_id,
              COUNT(1) AS total,
              SUM(CASE WHEN protect_until > ? THEN 1 ELSE 0 END) AS protected_total,
              SUM(CASE WHEN expire_at > ? AND expire_at <= ? THEN 1 ELSE 0 END) AS expiring_total
       FROM world_drops ${clause}
       GROUP BY map_id
       ORDER BY map_id ASC`,
      [now, now, now + windowMs, ...params],
    );
  }

  /** 条件拼装（listGround / countGround / summaryGround 共用） */
  private groundWhere(options: DropGroundListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = ["zone_id = ?"];
    const params: SqlParam[] = [options.zoneId];
    if (options.mapId) {
      where.push("map_id = ?");
      params.push(options.mapId);
    }
    if (options.keyword) {
      // 表里没有物品名，只能按 id 模糊；通配符照例转义（玩家名 / id 里都可能有 `_`）
      where.push("good_id LIKE ? ESCAPE '\\'");
      params.push(`%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (options.ownerName) {
      where.push("owner_name LIKE ? ESCAPE '\\'");
      params.push(`%${options.ownerName.replace(/[\\%_]/g, "\\$&")}%`);
    }
    return { clause: `WHERE ${where.join(" AND ")}`, params };
  }

  /**
   * 写入 / 刷新一件掉落（批量拍的每一行各调一次；主键冲突只更新会变的那几列）
   *
   * 只更新 `x / y / count / expire_at / protect_until`：其余列（归属、来源、创建时刻）
   * 生成那一刻就定了，重写一遍没有意义 —— 也让「谁改了这一行」在 diff 里看得清。
   */
  upsert(row: WorldDropRow): void {
    this.db.run(
      `INSERT INTO world_drops (
        drop_id, zone_id, map_id, good_id, count, bound, x, y,
        owner_account_id, owner_role_id, owner_name, party_id,
        monster_key, monster_label, monster_instance_id, origin_role, origin_at,
        created_at, expire_at, protect_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(drop_id) DO UPDATE SET
        x = excluded.x, y = excluded.y, count = excluded.count,
        expire_at = excluded.expire_at, protect_until = excluded.protect_until`,
      [
        row.drop_id,
        row.zone_id,
        row.map_id,
        row.good_id,
        row.count,
        row.bound,
        row.x,
        row.y,
        row.owner_account_id,
        row.owner_role_id,
        row.owner_name,
        row.party_id,
        row.monster_key,
        row.monster_label,
        row.monster_instance_id,
        row.origin_role,
        row.origin_at,
        row.created_at,
        row.expire_at,
        row.protect_until,
      ],
    );
  }

  /** 删掉若干件（拾取 / 过期 / 挤掉；先删库再广播，重连的人才不会又看到它） */
  deleteByIds(dropIds: string[]): void {
    if (dropIds.length === 0) return;
    this.db.transaction(() => {
      for (const dropId of dropIds) this.db.run("DELETE FROM world_drops WHERE drop_id = ?", [dropId]);
    });
  }

  /**
   * 清空整张投影表（**只给重启清场用**）
   *
   * 返回删掉的行数：启动日志要能说出「上一进程留下几件已作废」，运维才解释得清
   * 「刚才地上的东西怎么没了」。
   */
  clearAll(): number {
    const ids = this.listAllIds();
    if (ids.length === 0) return 0;
    this.db.run("DELETE FROM world_drops");
    return ids.length;
  }
}
