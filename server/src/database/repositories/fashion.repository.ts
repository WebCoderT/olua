import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { FashionRow } from "../rows";
import { FASHION_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 时装列表查询条件 */
export interface FashionListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  /** 获得渠道筛选：upgrade / grant / unavailable */
  channel?: string;
  sort?: string;
  order?: string;
}

/**
 * 时装配置数据访问（#257）
 *
 * 与称号 / 怪物 / NPC 同一取向：**没有 insert / remove 的对外语义** ——
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除
 * （时装 id 被客户端配置与未来的穿戴 / 衣柜链路引用，id 清单固定）。
 */
@Injectable()
export class FashionRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: FashionRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO fashions
        (id, label, description, icon, in_res, out_res, sell_price, acquire_channel,
         max_hp, hp_recover,
         physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.label,
        row.description,
        row.icon,
        row.in_res,
        row.out_res,
        row.sell_price,
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

  update(row: FashionRow): { changes: number } {
    return this.db.execute(
      `UPDATE fashions SET
         label = ?, description = ?, sell_price = ?, acquire_channel = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.description,
        row.sell_price,
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
        row.id,
      ],
    );
  }

  findByKey(id: string): FashionRow | undefined {
    return this.db.get<FashionRow>("SELECT * FROM fashions WHERE id = ?", [id]);
  }

  /** 分页检索（默认按 id 升序 —— 配置文件声明顺序，即素材编号顺序） */
  list(options: FashionListOptions): FashionRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<FashionRow>(
      `SELECT * FROM fashions ${clause}
       ORDER BY ${resolveSort(FASHION_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: FashionListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM fashions ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: FashionListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (options.channel) {
      where.push("acquire_channel = ?");
      params.push(options.channel);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
