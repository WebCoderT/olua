import { Injectable } from "@nestjs/common";
import { ROLE_LEVEL_CURVE_SEEDS, RoleLevelCurvePatch } from "../../common/constants/role-level-curve";
import { DatabaseService } from "../database.service";
import { RoleLevelCurveRow } from "../rows";

/**
 * 角色等级曲线数据访问（#786）
 *
 * 只有 24 行（4 条曲线 × 6 段），所以**没有分页**：`listAll()` 一次给全。
 * 也没有 create / remove 的对外语义 —— 段的数量与首尾由出厂数据定死，
 * 管理端只改「这段到哪级结束 / 起始值 / 每级增量」，不允许删段或插段
 * （少一段就有等级区间没定义，多一段就有区间重叠，两种都是「玩家升到某级没属性」）。
 */
@Injectable()
export class RoleLevelCurveRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 写入出厂段（已存在则跳过 —— 运营调过的段不会被重跑迁移覆盖回去） */
  seedRow(row: RoleLevelCurveRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO role_level_curves
         (curve, seq, from_level, to_level, start_value, per_level, accel, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.curve,
        row.seq,
        row.from_level,
        row.to_level,
        row.start_value,
        row.per_level,
        row.accel,
        row.updated_at,
      ],
    );
  }

  /** 全部段（按曲线 → 段序；启动装载与快照的唯一读法） */
  listAll(): RoleLevelCurveRow[] {
    return this.db.all<RoleLevelCurveRow>(
      "SELECT * FROM role_level_curves ORDER BY curve ASC, seq ASC",
    );
  }

  /** 某条曲线的段（升序；求值用） */
  listByCurve(curve: string): RoleLevelCurveRow[] {
    return this.db.all<RoleLevelCurveRow>(
      "SELECT * FROM role_level_curves WHERE curve = ? ORDER BY seq ASC",
      [curve],
    );
  }

  findByKey(curve: string, seq: number): RoleLevelCurveRow | undefined {
    return this.db.get<RoleLevelCurveRow>(
      "SELECT * FROM role_level_curves WHERE curve = ? AND seq = ?",
      [curve, seq],
    );
  }

  /**
   * 改一段（部分更新：只写传了的列）
   *
   * `from_level` 不给改：段的起点由上一段的终点决定，改它会把区间切成重叠或空隙。
   * 要「多切一段」属于改出厂数据的事，不走管理端。
   */
  update(curve: string, seq: number, patch: RoleLevelCurvePatch, updatedAt: number): void {
    const existing = this.findByKey(curve, seq);
    if (!existing) return;
    this.db.run(
      `UPDATE role_level_curves
          SET to_level = ?, start_value = ?, per_level = ?, accel = ?, updated_at = ?
        WHERE curve = ? AND seq = ?`,
      [
        patch.toLevel ?? existing.to_level,
        patch.startValue ?? existing.start_value,
        patch.perLevel ?? existing.per_level,
        patch.accel ?? existing.accel,
        updatedAt,
        curve,
        seq,
      ],
    );
  }

  /**
   * 只挪一段的起点（改上一段的 `to_level` 时联动用）
   *
   * 单独开一个方法而不是塞进 `update`：`from_level` 是**结构**（段与段之间的接缝），
   * 与 `start_value` 这类**内容**不是一回事 —— 混在一个 patch 里，
   * 以后想加「不许手改起点」的守卫就分不清是联动还是人手改的。
   */
  updateFromLevel(curve: string, seq: number, fromLevel: number, updatedAt: number): void {
    this.db.run("UPDATE role_level_curves SET from_level = ?, updated_at = ? WHERE curve = ? AND seq = ?", [
      fromLevel,
      updatedAt,
      curve,
      seq,
    ]);
  }

  /**
   * 未 `to_level` 的最后一段（升级上限变化后用来把末段拉满）
   *
   * `roleMaxLevel` 调大时末段仍指向上限，求值走「超出末段就外推」也能算 ——
   * 这里只用于「把末段 to_level 同步成新上限」，让管理端展示的数字对得上。
   */
  lastSegmentOf(curve: string): RoleLevelCurveRow | undefined {
    return this.db.get<RoleLevelCurveRow>(
      "SELECT * FROM role_level_curves WHERE curve = ? ORDER BY seq DESC LIMIT 1",
      [curve],
    );
  }

  /** 把出厂段补齐（空库自举后用；不覆盖已有行） */
  seedMissing(): number {
    let added = 0;
    const now = Date.now();
    for (const seed of ROLE_LEVEL_CURVE_SEEDS) {
      const before = this.findByKey(seed.curve, seed.seq);
      if (before) continue;
      this.seedRow({ ...seed, updated_at: now });
      added += 1;
    }
    return added;
  }
}
