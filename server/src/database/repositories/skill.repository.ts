import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { SkillRow } from "../rows";
import { SKILL_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 技能列表查询条件 */
export interface SkillListOptions {
  page: number;
  size: number;
  /** 归属筛选：role | monster（不传 = 两边都要） */
  owner?: string;
  /** 关键字：模糊匹配 id / 名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 技能数据访问（#367）
 *
 * 与称号 / 装备 / 怪物同一取向：**没有 insert / remove 的对外语义** —— 行只能来自启动 seed
 * （`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除（角色技能 id 被技能栏 /
 * 快捷键 / 角色存档引用，清单固定）。怪物技能的增删由 #12 主体那一刀另加方法，
 * 不在这条通用路径上开洞。
 */
@Injectable()
export class SkillRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: SkillRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO skills
         (id, owner, label, icon, category, target_type, action, effect, effect_on_self,
          cooldown, mp_cost, distance, level_req, description, damage_coefficients,
          status_id, cast_lock_ms, require_target, can_auto, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.owner,
        row.label,
        row.icon,
        row.category,
        row.target_type,
        row.action,
        row.effect,
        row.effect_on_self,
        row.cooldown,
        row.mp_cost,
        row.distance,
        row.level_req,
        row.description,
        row.damage_coefficients,
        row.status_id,
        row.cast_lock_ms,
        row.require_target,
        row.can_auto,
        row.updated_at,
      ],
    );
  }

  update(row: SkillRow): { changes: number } {
    return this.db.execute(
      `UPDATE skills SET
         label = ?, icon = ?, category = ?, target_type = ?, action = ?, effect = ?, effect_on_self = ?,
         cooldown = ?, mp_cost = ?, distance = ?, level_req = ?, description = ?, damage_coefficients = ?,
         status_id = ?, cast_lock_ms = ?, require_target = ?, can_auto = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.icon,
        row.category,
        row.target_type,
        row.action,
        row.effect,
        row.effect_on_self,
        row.cooldown,
        row.mp_cost,
        row.distance,
        row.level_req,
        row.description,
        row.damage_coefficients,
        row.status_id,
        row.cast_lock_ms,
        row.require_target,
        row.can_auto,
        row.updated_at,
        row.id,
      ],
    );
  }

  findByKey(id: string): SkillRow | undefined {
    return this.db.get<SkillRow>("SELECT * FROM skills WHERE id = ?", [id]);
  }

  /** 分页检索（默认按 id 数值序 —— 与后台的展示动线一致） */
  list(options: SkillListOptions): SkillRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<SkillRow>(
      `SELECT * FROM skills ${clause}
       ORDER BY ${resolveSort(SKILL_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: SkillListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM skills ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: SkillListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.owner) {
      where.push("owner = ?");
      params.push(options.owner);
    }
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
