import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { EquipmentRow } from "../rows";
import { EQUIPMENT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 装备基础件列表查询条件 */
export interface EquipmentListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id 与名称 */
  keyword?: string;
  /** 按部位筛（EQUIPMENT_TYPE 的枚举值，如 `cloth`） */
  slot?: string;
  /** 等级段下限（含） */
  minLevel?: number;
  /** 等级段上限（含） */
  maxLevel?: number;
  sort?: string;
  order?: string;
}

/**
 * 装备基础件数据访问（#252）
 *
 * 与称号 / 战魂 / 军衔同一取向：**没有 insert / remove 的对外语义** —— 行只能来自启动 seed
 * （`seedRow`，INSERT OR IGNORE 幂等），后台接口不提供创建与删除。
 * id / 部位结构固定（变体生成规则在客户端配置，属代码不是运营数据），运营只改数值。
 */
@Injectable()
export class EquipmentRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过 —— 运营改过的值不会被配置更新覆盖回去） */
  seedRow(row: EquipmentRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO equipments
        (id, slot, level, sell_price, label,
         max_hp, hp_recover, physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.slot,
        row.level,
        row.sell_price,
        row.label,
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

  update(row: EquipmentRow): { changes: number } {
    return this.db.execute(
      `UPDATE equipments SET
         level = ?, sell_price = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        row.level,
        row.sell_price,
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

  findByKey(id: string): EquipmentRow | undefined {
    return this.db.get<EquipmentRow>("SELECT * FROM equipments WHERE id = ?", [id]);
  }

  /** 分页检索（默认按等级升序 —— 等级是装备定强的主轴） */
  list(options: EquipmentListOptions): EquipmentRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<EquipmentRow>(
      `SELECT * FROM equipments ${clause}
       ORDER BY ${resolveSort(EQUIPMENT_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 分页检索总数（与 list 用同一套条件） */
  count(options: EquipmentListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM equipments ${clause}`, params);
  }

  /** 条件拼装（list / count 共用，避免两处条件写岔） */
  private where(options: EquipmentListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与称号 / 战魂 / 军衔同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (options.slot) {
      where.push("slot = ?");
      params.push(options.slot);
    }
    if (options.minLevel !== undefined) {
      where.push("level >= ?");
      params.push(options.minLevel);
    }
    if (options.maxLevel !== undefined) {
      where.push("level <= ?");
      params.push(options.maxLevel);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
