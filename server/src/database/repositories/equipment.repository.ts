import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";
import { EquipmentMetaRow, EquipmentRow, EquipmentSlotRow } from "../rows";
import { EQUIPMENT_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/**
 * 可 seed / 更新的列（顺序即参数顺序）
 *
 * 手写 20 个占位符的写法在 #603 加显示字段时漏过列 —— 改成「列名一份 + 自动拼 SQL」，
 * 加字段只要在这个数组里补一行，`seedRow` / `update` / `backfillAppearance` 自动跟上。
 */
const EQUIPMENT_COLUMNS: (keyof EquipmentRow)[] = [
  "slot",
  "level",
  "sell_price",
  "label",
  "occupation",
  "sex",
  "description",
  "icon",
  "in_atlas",
  "out_atlas",
  "tags",
  "in_pos_x",
  "in_pos_y",
  "in_scale_x",
  "in_scale_y",
  "in_rotate",
  "out_scale",
  "out_positions",
  "max_hp",
  "hp_recover",
  "physical_attack_min",
  "physical_attack_max",
  "magic_attack_min",
  "magic_attack_max",
  "taoist_attack_min",
  "taoist_attack_max",
  "physical_defense_min",
  "physical_defense_max",
  "magic_defense_min",
  "magic_defense_max",
  "taoist_defense_min",
  "taoist_defense_max",
  "updated_at",
];

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
      `INSERT OR IGNORE INTO equipments (id, ${EQUIPMENT_COLUMNS.join(", ")})
       VALUES (?, ${EQUIPMENT_COLUMNS.map(() => "?").join(", ")})`,
      [row.id, ...EQUIPMENT_COLUMNS.map((column) => row[column])],
    );
  }

  update(row: EquipmentRow): { changes: number } {
    return this.db.execute(
      `UPDATE equipments SET ${EQUIPMENT_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
      [...EQUIPMENT_COLUMNS.map((column) => row[column]), row.id],
    );
  }

  /**
   * 老库补显示字段（#603 第九域）
   *
   * 存量库的行是「只有 id + 名称 + 数值」的形态，`seedRow` 的 `INSERT OR IGNORE` 会整行跳过 ——
   * 不补的话升级后客户端的图标 / 图集 / 几何全空，装备列表与角色外观直接不可用。
   *
   * **只碰显示列，不碰数值列**（等级 / 价格 / 八项属性可能已被运营改过，回填不该把它们抹回出厂值）；
   * 判据是 `icon = ''`（新库 seed 时已经写满，这里 0 行）。
   */
  backfillAppearance(row: EquipmentRow): { changes: number } {
    const columns: (keyof EquipmentRow)[] = [
      "occupation",
      "sex",
      "description",
      "icon",
      "in_atlas",
      "out_atlas",
      "tags",
      "in_pos_x",
      "in_pos_y",
      "in_scale_x",
      "in_scale_y",
      "in_rotate",
      "out_scale",
      "out_positions",
      "updated_at",
    ];
    return this.db.execute(
      `UPDATE equipments SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ? AND icon = ''`,
      [...columns.map((column) => row[column]), row.id],
    );
  }

  // —— 槽位表（#603 第九域）——

  /** seed 一个槽位（已存在则跳过，运营改过的名字/底图不会被配置更新覆盖） */
  seedSlot(row: EquipmentSlotRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO equipment_slots (key, label, image_src, position, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.key, row.label, row.image_src, row.position, row.sort_order, row.updated_at],
    );
  }

  /** 全量槽位（按 sort_order 升序 —— 顺序即角色弹窗排列与背包整理序） */
  listSlots(): EquipmentSlotRow[] {
    return this.db.all<EquipmentSlotRow>("SELECT * FROM equipment_slots ORDER BY sort_order ASC, key ASC");
  }

  findSlot(key: string): EquipmentSlotRow | undefined {
    return this.db.get<EquipmentSlotRow>("SELECT * FROM equipment_slots WHERE key = ?", [key]);
  }

  updateSlot(row: EquipmentSlotRow): { changes: number } {
    return this.db.execute(
      `UPDATE equipment_slots SET label = ?, image_src = ?, position = ?, sort_order = ?, updated_at = ? WHERE key = ?`,
      [row.label, row.image_src, row.position, row.sort_order, row.updated_at, row.key],
    );
  }

  // —— 规则表（#603 第九域，单行 id = 1）——

  /** 取规则行（表里没有行时返回 undefined —— 调用方决定兜什么） */
  getMeta(): EquipmentMetaRow | undefined {
    return this.db.get<EquipmentMetaRow>("SELECT * FROM equipment_meta WHERE id = 1");
  }

  updateMeta(row: EquipmentMetaRow): { changes: number } {
    return this.db.execute(
      `UPDATE equipment_meta SET prefix_rates = ?, suffix_rates = ?, prefix_labels = ?, suffix_labels = ?,
         prefix_colors = ?, suffix_colors = ?, updated_at = ? WHERE id = 1`,
      [row.prefix_rates, row.suffix_rates, row.prefix_labels, row.suffix_labels, row.prefix_colors, row.suffix_colors, row.updated_at],
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
