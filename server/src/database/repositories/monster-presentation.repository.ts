import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { MonsterBehaviorRow, MonsterPresentationRow } from "../rows";

/**
 * 怪物表现 / 资源（`monster_presentation` 表，#655）
 *
 * 一行 = 一只怪的图集路径 + 基准帧几何 + AI 视觉参数。原来的书写处是生成物
 * `monster-presentation.generated.ts`（`client/tools/gen-monster-config.cjs` 从图集
 * 实测 trim）。现在生成器**直接写库**，运行时只读这张表 —— 代码里不再有第三份副本。
 *
 * ⚠️ **两类列、两个写者**（#751）：
 * - **几何**（`icon` / `out` / `out_offset_*` / `content_*`）= 素材事实 → 只有生成器写
 *   （`gen-monster-config.cjs` 直接对这几列 `UPDATE`，不走仓储）；
 * - **行为**（`aggressive` / `detect_range` / `move_speed` / `speed_rate`）= 运营旋钮 →
 *   `updateBehavior` 写，管理端 PATCH /admin/monsters/:id 是唯一入口。
 *
 * 生成器一行都不能碰行为列 —— 它一跑就会把运营调过的值抹回去（`gen-monster-config.cjs`
 * 里对应的 `UPDATE` 已经摘掉了 `aggressive`，改回去前先想清楚这条）。
 *
 * 这里**没有整行 upsert**（#751 之前有一个，11 列全覆盖、零调用者）：那种写法
 * 「插一行 = 顺手把运营调的行为参数写回出厂」，是留给下一个人的坑。
 */
@Injectable()
export class MonsterPresentationRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 写行为参数（管理端的唯一写口）
   *
   * 只碰四列行为 + `updated_at`；几何列整句 SQL 都不出现，所以「管理端改速度顺手把
   * 图集偏移写坏」这种事故在结构上不可能发生。调用方负责把缺省字段补成库里的现值
   * （部分更新语义在 service，不在 SQL）。
   */
  updateBehavior(row: MonsterBehaviorRow): { changes: number } {
    return this.db.execute(
      `UPDATE monster_presentation
         SET aggressive = ?, detect_range = ?, move_speed = ?, speed_rate = ?, updated_at = ?
       WHERE id = ?`,
      [row.aggressive, row.detect_range, row.move_speed, row.speed_rate, row.updated_at, row.id],
    );
  }

  /**
   * 全部行，按 **id 数值**升序（与客户端图集命名一致）
   *
   * `id` 是 TEXT，`ORDER BY id` 会把 "10" 排在 "2" 前面 —— 快照里顺序一变，
   * 客户端 diff 就整份重下，所以排序在 SQL 里定一次。
   */
  listAll(): MonsterPresentationRow[] {
    return this.db.all<MonsterPresentationRow>(
      "SELECT * FROM monster_presentation ORDER BY CAST(id AS INTEGER) ASC, id ASC",
    );
  }

  /**
   * 一次取一页怪物的表现行（管理端列表要按 key 批量补参数）
   *
   * 与 `MonsterDropRepository.listByKeys` 同一手法：一次 IN 查完再让调用方建 Map 对齐。
   * 空数组直接返回（`IN ()` 在 SQLite 里是语法错误）。
   */
  listByKeys(ids: string[]): MonsterPresentationRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.all<MonsterPresentationRow>(
      `SELECT * FROM monster_presentation WHERE id IN (${placeholders})`,
      ids,
    );
  }

  getById(id: string): MonsterPresentationRow | null {
    return this.db.get<MonsterPresentationRow>("SELECT * FROM monster_presentation WHERE id = ?", [id]) ?? null;
  }

  count(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM monster_presentation");
  }
}
