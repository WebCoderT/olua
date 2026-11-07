import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { EquipmentVariantRow } from "../rows";
import { EQUIPMENT_VARIANT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 装备变体列表查询条件 */
export interface EquipmentVariantListOptions {
  page: number;
  size: number;
  /** 只列某个基础件的变体（装备页里点开一件基础件时用） */
  baseId?: string;
  /** 关键字：模糊匹配变体 id / 完整名称 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 装备变体表数据访问（#655）
 *
 * 每件基础件展开 15 行（5 前缀 × 3 后缀），行数随基础件浮动。以前是「基础件属性 × 倍率」在运行时现算，
 * 现在每行都是独立配置：管理端能逐条改属性 / 卖价 / 穿戴等级，服务端与客户端都只读它。
 *
 * 行的**增删**允许四种来源：迁移脚本（一次性展开）、「基础件新建时连带展开其全部变体」
 * （`seedRow` 幂等，档数取 `equipment_meta`，出厂 5 × 3）、管理端「重新生成全部装备变体」端点的
 * 整表重建（`replaceAll`，#697 —— 重建按当前前后缀倍率整批重算，是唯一会**清空**既有行的路径），
 * 以及「删除装备时连带删掉这件基础件的全部变体」（`removeOfBase`，#773）。管理端仍不提供
 * 删除单个变体的入口 —— 那样背包里已存在的 id 会变成孤儿。
 */
@Injectable()
export class EquipmentVariantRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 写入一行（已存在则跳过 —— 重跑迁移不覆盖运营改过的值） */
  seedRow(row: EquipmentVariantRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO equipment_variants
        (id, base_id, prefix, suffix, label, level, sell_price,
         max_hp, hp_recover,
         physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
         taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
         magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.base_id,
        row.prefix,
        row.suffix,
        row.label,
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
      ],
    );
  }

  /**
   * 整表重建（#697「重新生成全部装备变体」专用）：一个事务里先清空再整批写入
   *
   * 与 `seedRow` 的 INSERT OR IGNORE 相反 —— 重建的语义就是「按当前前后缀倍率把
   * 属性重算一遍」，已存在的行也要覆盖。「卖价保留原值」由调用方在内存里先算好
   * （row.sell_price 带着来），这里只负责原子的清空 + 写入。
   */
  replaceAll(rows: EquipmentVariantRow[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM equipment_variants");
      for (const row of rows) {
        this.db.run(
          `INSERT INTO equipment_variants
            (id, base_id, prefix, suffix, label, level, sell_price,
             max_hp, hp_recover,
             physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
             taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
             magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.base_id,
            row.prefix,
            row.suffix,
            row.label,
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
          ],
        );
      }
    });
  }

  update(row: EquipmentVariantRow): { changes: number } {
    return this.db.execute(
      `UPDATE equipment_variants SET
         label = ?, level = ?, sell_price = ?,
         max_hp = ?, hp_recover = ?,
         physical_attack_min = ?, physical_attack_max = ?, magic_attack_min = ?, magic_attack_max = ?,
         taoist_attack_min = ?, taoist_attack_max = ?, physical_defense_min = ?, physical_defense_max = ?,
         magic_defense_min = ?, magic_defense_max = ?, taoist_defense_min = ?, taoist_defense_max = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        row.label,
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

  findById(id: string): EquipmentVariantRow | undefined {
    return this.db.get<EquipmentVariantRow>("SELECT * FROM equipment_variants WHERE id = ?", [id]);
  }

  /** 全量（启动装载覆盖层 / 快照用；全量，按 base + 前后缀序消费） */
  listAll(): EquipmentVariantRow[] {
    return this.db.all<EquipmentVariantRow>(
      "SELECT * FROM equipment_variants ORDER BY base_id ASC, prefix ASC, suffix ASC",
    );
  }

  /** 某基础件的全部变体（基础件改名 / 改等级后连带同步用） */
  listOfBase(baseId: string): EquipmentVariantRow[] {
    return this.db.all<EquipmentVariantRow>(
      "SELECT * FROM equipment_variants WHERE base_id = ? ORDER BY prefix ASC, suffix ASC",
      [baseId],
    );
  }

  /**
   * 删掉某基础件的全部变体（#773 删除装备时连带）
   *
   * 与 `replaceAll` 的整表重建不同：这里只动一件基础件的行 —— 删装备是「这件不存在了」，
   * 不是「按新倍率重算全表」。返回删掉的行数，供接口回包盘点。
   */
  removeOfBase(baseId: string): number {
    return this.db.execute("DELETE FROM equipment_variants WHERE base_id = ?", [baseId]).changes;
  }

  list(options: EquipmentVariantListOptions): EquipmentVariantRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<EquipmentVariantRow>(
      `SELECT * FROM equipment_variants ${clause}
       ORDER BY ${resolveSort(EQUIPMENT_VARIANT_SORT, options.sort, options.order)}
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  count(options: EquipmentVariantListOptions = { page: 1, size: 0 }): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM equipment_variants ${clause}`, params);
  }

  private where(options: EquipmentVariantListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.baseId) {
      where.push("base_id = ?");
      params.push(options.baseId);
    }
    if (options.keyword) {
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}
