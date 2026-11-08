import { Injectable } from "@nestjs/common";
import { LEVEL_SCROLL_ID_PATTERN } from "../../common/constants/level-scrolls";
import { DatabaseService, SqlParam } from "../database.service";
import { LevelScrollRow } from "../rows";
import { LEVEL_SCROLL_SORT } from "../sort-specs";
import { resolveSort } from "../sort.util";

/** 升级卷轴列表查询条件 */
export interface LevelScrollListOptions {
  page: number;
  size: number;
  /** 关键字：模糊匹配 id / 名称 / 描述 */
  keyword?: string;
  sort?: string;
  order?: string;
}

/**
 * 升级卷轴数据访问（#787）
 *
 * 与货币道具同一取向：**有** create / update / remove —— 「分多少段等级」是运营自己的事
 * （等级上限调大之后要跟着开新卷），而且卷轴不被掉落表按 id 固定引用。
 *
 * 删除**不碰玩家存档**：背包里还留着已删 id 的格子只是「认不出的道具」，
 * 客户端与结算都安静跳过（与装备 / 货币道具同一条口径）。
 */
@Injectable()
export class LevelScrollRepository {
  constructor(private readonly db: DatabaseService) {}

  findByKey(id: string): LevelScrollRow | undefined {
    return this.db.get<LevelScrollRow>("SELECT * FROM level_scrolls WHERE id = ?", [id]);
  }

  /**
   * 全部行（配置快照用；顺序 = 等级下限升序）
   *
   * 客户端背包整理 / 图鉴按这个顺序陈列 —— 卷轴天生有序（Lv1 → Lv7），
   * 不要让它们按 id 字符串排（`level_scroll_10` 会插到 `level_scroll_2` 前面）。
   */
  listAll(): LevelScrollRow[] {
    return this.db.all<LevelScrollRow>(
      "SELECT * FROM level_scrolls ORDER BY min_level ASC, max_level ASC, id ASC",
    );
  }

  /** 某一页（管理端列表） */
  list(options: LevelScrollListOptions): LevelScrollRow[] {
    const { clause, params } = this.where(options);
    return this.db.all<LevelScrollRow>(
      `SELECT * FROM level_scrolls ${clause}
       ORDER BY ${resolveSort(LEVEL_SCROLL_SORT, options.sort, options.order)}, min_level ASC, id ASC
       LIMIT ? OFFSET ?`,
      [...params, options.size, (options.page - 1) * options.size],
    );
  }

  /** 与 list 同一套条件的总数 */
  count(options: LevelScrollListOptions): number {
    const { clause, params } = this.where(options);
    return this.db.count(`SELECT COUNT(1) AS total FROM level_scrolls ${clause}`, params);
  }

  insert(row: LevelScrollRow): void {
    this.db.run(
      `INSERT INTO level_scrolls
         (id, label, description, icon, min_level, max_level, max_stack, sell_price, bind_on_drop, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.label,
        row.description,
        row.icon,
        row.min_level,
        row.max_level,
        row.max_stack,
        row.sell_price,
        row.bind_on_drop,
        row.updated_at,
      ],
    );
  }

  update(row: LevelScrollRow): { changes: number } {
    return this.db.execute(
      `UPDATE level_scrolls SET
         label = ?, description = ?, icon = ?, min_level = ?, max_level = ?,
         max_stack = ?, sell_price = ?, bind_on_drop = ?, updated_at = ?
       WHERE id = ?`,
      [
        row.label,
        row.description,
        row.icon,
        row.min_level,
        row.max_level,
        row.max_stack,
        row.sell_price,
        row.bind_on_drop,
        row.updated_at,
        row.id,
      ],
    );
  }

  remove(id: string): { changes: number } {
    return this.db.execute("DELETE FROM level_scrolls WHERE id = ?", [id]);
  }

  /** 条件拼装（list / count 共用，避免两处写岔） */
  private where(options: LevelScrollListOptions): { clause: string; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.keyword) {
      // LIKE 的通配符要转义（与其他配置表同一手法）
      const like = `%${options.keyword.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }
}

/** id 是否合法（服务端与 DTO 共用这一份判定，别在两处各写一条正则） */
export function isValidLevelScrollId(id: string): boolean {
  return LEVEL_SCROLL_ID_PATTERN.test(id);
}
