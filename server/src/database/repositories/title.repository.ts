import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { TitleRow } from "../rows";
import { TITLE_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 称号列表查询条件 */
export interface TitleListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配名称与描述 */
  keyword?: string;
  /** 获得渠道筛选（upgrade / grant / unavailable） */
  acquireChannel?: string;
  sort?: string;
  order?: string;
}

/**
 * 称号配置数据访问
 *
 * **没有 insert / remove 的对外语义**：行只能来自启动 seed（`seedRow`，INSERT OR IGNORE
 * 幂等），后台接口不提供创建与删除 —— 等级序列是固定的，改内容不改行数。
 */
@Injectable()
export class TitleRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: TitleRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO titles
        (level, label, description, animation, animation_frame_rate, bind_gold, acquire_channel,
         max_hp, hp_recover, physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.level,
        row.label,
        row.description,
        row.animation,
        row.animation_frame_rate,
        row.bind_gold,
        row.acquire_channel,
        row.max_hp,
        row.hp_recover,
        row.physical_attack_min,
        row.physical_attack_max,
        row.magic_attack_min,
        row.magic_attack_max,
        row.taoist_attack_min,
        row.taoist_attack_max,
        row.physical_defense_min,
        row.physical_defense_max,
        row.magic_defense_min,
        row.magic_defense_max,
        row.taoist_defense_min,
        row.taoist_defense_max,
        row.updated_at,
      ],
    );
  }

  update(row: TitleRow): { changes: number } {
    return this.db.execute(
      `UPDATE titles SET
         label = ?, description = ?, animation = ?, animation_frame_rate = ?, bind_gold = ?, acquire_channel = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE level = ?`,
      [
        row.label,
        row.description,
        row.animation,
        row.animation_frame_rate,
        row.bind_gold,
        row.acquire_channel,
        row.max_hp,
        row.hp_recover,
        row.physical_attack_min,
        row.physical_attack_max,
        row.magic_attack_min,
        row.magic_attack_max,
        row.taoist_attack_min,
        row.taoist_attack_max,
        row.physical_defense_min,
        row.physical_defense_max,
        row.magic_defense_min,
        row.magic_defense_max,
        row.taoist_defense_min,
        row.taoist_defense_max,
        row.updated_at,
        row.level,
      ],
    );
  }

  findByLevel(level: number): TitleRow | undefined {
    return this.db.get<TitleRow>("SELECT * FROM titles WHERE level = ?", [level]);
  }

  /** 分页检索（默认按等级升序 —— 称号列表本来就是一张「升级价目表」） */
  list(options: TitleListOptions): TitleRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<TitleRow>(
      `SELECT * FROM titles ${clause}
       ORDER BY ${resolveSort(TITLE_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: TitleListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM titles ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: TitleListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义，否则名称里的 `_`（下划线是单字符通配）会被当成占位符
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (options.acquireChannel) {
      where.push("acquire_channel = ?");
      params.push(options.acquireChannel);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
