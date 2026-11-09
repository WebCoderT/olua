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
 * 技能表的列 → 取值（**加字段只改这一张表**）
 *
 * 这个仓储有三条写语句（seed / insert / update），以前每加一列要同时改三处 SQL ——
 * #603 第十一域加 `occupation` 与 `push_distance` 时正好踩上这个坑的边界，
 * 索性收成一份声明：列名与取值同源，三条语句都由它拼出来，漏一处的可能性归零。
 */
const SKILL_COLUMNS: Array<[string, (row: SkillRow) => SqlParam]> = [
  ["id", (row) => row.id],
  ["owner", (row) => row.owner],
  ["label", (row) => row.label],
  ["icon", (row) => row.icon],
  ["category", (row) => row.category],
  ["target_type", (row) => row.target_type],
  ["action", (row) => row.action],
  ["effect", (row) => row.effect],
  ["effect_on_self", (row) => row.effect_on_self],
  ["cooldown", (row) => row.cooldown],
  ["mp_cost", (row) => row.mp_cost],
  ["distance", (row) => row.distance],
  ["level_req", (row) => row.level_req],
  ["description", (row) => row.description],
  ["damage_coefficients", (row) => row.damage_coefficients],
  ["status_id", (row) => row.status_id],
  ["cast_lock_ms", (row) => row.cast_lock_ms],
  ["require_target", (row) => row.require_target],
  ["can_auto", (row) => row.can_auto],
  ["occupation", (row) => row.occupation],
  ["push_distance", (row) => row.push_distance],
  // 撞飞概率（#826）：漏登记同样是「PATCH 200 但库没变」
  ["push_chance", (row) => row.push_chance],
  // 暴击 / 破防（#826）：漏登记这两行不会报错 —— `update()` 只写清单里的列，
  // 表现是「管理端 PATCH 成功返回，结算侧一分没变」
  ["crit_rate", (row) => row.crit_rate],
  ["crit_damage", (row) => row.crit_damage],
  ["def_ignore", (row) => row.def_ignore],
  ["updated_at", (row) => row.updated_at],
];

const SKILL_COLUMN_NAMES = SKILL_COLUMNS.map(([name]) => name);
const SKILL_PLACEHOLDERS = SKILL_COLUMNS.map(() => "?").join(", ");
const skillValues = (row: SkillRow): SqlParam[] => SKILL_COLUMNS.map(([, pick]) => pick(row));
/** UPDATE 的列（除主键）+ 末尾的 WHERE 参数 */
const SKILL_UPDATE_SET = SKILL_COLUMN_NAMES.filter((name) => name !== "id")
  .map((name) => `${name} = ?`)
  .join(", ");

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
    this.db.run(`INSERT OR IGNORE INTO skills (${SKILL_COLUMN_NAMES.join(", ")}) VALUES (${SKILL_PLACEHOLDERS})`, skillValues(row));
  }

  /** 新增一行（#372：只给怪物技能用；重复 id 由调用方先查重，这里不吞异常） */
  insert(row: SkillRow): void {
    this.db.run(`INSERT INTO skills (${SKILL_COLUMN_NAMES.join(", ")}) VALUES (${SKILL_PLACEHOLDERS})`, skillValues(row));
  }

  /** 删除一行（#372：只给怪物技能用；被挂载引用时由调用方拒绝） */
  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM skills WHERE id = ?", [id]);
  }

  update(row: SkillRow): { changes: number } {
    const values = SKILL_COLUMNS.filter(([name]) => name !== "id").map(([, pick]) => pick(row));
    return this.db.execute(`UPDATE skills SET ${SKILL_UPDATE_SET} WHERE id = ?`, [...values, row.id]);
  }

  findByKey(id: string): SkillRow | undefined {
    return this.db.get<SkillRow>("SELECT * FROM skills WHERE id = ?", [id]);
  }

  /** 全量（服务端 AI 的缓存来源：#372 起怪物技能也从 `skills` 表读，表很小一次读全） */
  listAll(): SkillRow[] {
    return this.db.all<SkillRow>("SELECT * FROM skills ORDER BY id ASC");
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
