import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { MonsterRow } from "../rows";
import { MONSTER_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 怪物列表查询条件 */
export interface MonsterListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  /** 定位筛选：normal / elite / boss */
  tier?: string;
  sort?: string;
  order?: string;
}

/**
 * 怪物基础数据访问（#258）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**没有 insert / remove 的对外语义** ——
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除
 * （怪物 key 被地图刷怪点 / 掉落表 / 技能引用，id 清单固定）。
 *
 * 除管理端读写外，**世界权威（播种）与战斗结算也直读本表** —— 改数值即时生效，
 * 不经任何内存缓存（两进程共享同一个 SQLite 文件，读到的总是最新已提交值）。
 */
@Injectable()
export class MonsterRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: MonsterRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO monsters
        (id, label, tier, level, max_hp,
         physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.label,
        row.tier,
        row.level,
        row.max_hp,
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

  update(row: MonsterRow): { changes: number } {
    return this.db.execute(
      `UPDATE monsters SET
         label = ?, level = ?, max_hp = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.level,
        row.max_hp,
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

  findByKey(id: string): MonsterRow | undefined {
    return this.db.get<MonsterRow>("SELECT * FROM monsters WHERE id = ?", [id]);
  }

  /** 分页检索（默认按等级升序 —— 练级动线从低到高） */
  list(options: MonsterListOptions): MonsterRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<MonsterRow>(
      `SELECT * FROM monsters ${clause}
       ORDER BY ${resolveSort(MONSTER_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: MonsterListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM monsters ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: MonsterListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (options.tier) {
      where.push("tier = ?");
      params.push(options.tier);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
