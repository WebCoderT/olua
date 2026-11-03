import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { CombatWeightRow } from "../rows";

/**
 * 战斗力权重（#605）—— `combat_weights` 表（属性名 → 倍率，一个属性一行）
 *
 * 与 `growth_scalars` 同一取向：**行的集合由 seed 决定，后台只改值**。
 * 出厂值在 `config-sync.sql`，`INSERT OR IGNORE` 幂等 —— 运营调过的倍率
 * 不会被下一次启动覆盖回去，新增一个权重属性也只是多一行 seed。
 */
@Injectable()
export class CombatWeightsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已存在则跳过） */
  seed(row: CombatWeightRow): void {
    this.db.run("INSERT OR IGNORE INTO combat_weights (key, weight, updated_at) VALUES (?, ?, ?)", [
      row.key,
      row.weight,
      row.updated_at,
    ]);
  }

  listAll(): CombatWeightRow[] {
    return this.db.all<CombatWeightRow>("SELECT * FROM combat_weights");
  }

  /** 改一个属性的倍率（行不存在时补一行，保证「管理端写入即生效」不受 seed 时机影响） */
  update(row: CombatWeightRow): { changes: number } {
    return this.db.execute(
      `INSERT INTO combat_weights (key, weight, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
      [row.key, row.weight, row.updated_at],
    );
  }
}
