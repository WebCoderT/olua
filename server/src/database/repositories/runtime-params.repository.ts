import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RuntimeParamsRow } from "../rows";

/**
 * 客户端运行时参数（#605 / #655）—— 单行表 `runtime_params`
 *
 * 与 `mall_settings` / `equipment_meta` 同一取向：**一行、没有增删**，出厂值随
 * `config-sync.sql` 首启灌入，后台只能改内容。四组各存一列 JSON，缺键由 service 回落默认。
 */
@Injectable()
export class RuntimeParamsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 单行（已存在则跳过） */
  seed(row: RuntimeParamsRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO runtime_params (id, drop_params, auto_battle, guild_rules, monster_ai, updated_at) VALUES (1, ?, ?, ?, ?, ?)`,
      [row.drop_params, row.auto_battle, row.guild_rules, row.monster_ai, row.updated_at],
    );
  }

  get(): RuntimeParamsRow | undefined {
    return this.db.get<RuntimeParamsRow>("SELECT * FROM runtime_params WHERE id = 1");
  }

  update(row: RuntimeParamsRow): { changes: number } {
    return this.db.execute(
      `UPDATE runtime_params SET drop_params = ?, auto_battle = ?, guild_rules = ?, monster_ai = ?, updated_at = ? WHERE id = 1`,
      [row.drop_params, row.auto_battle, row.guild_rules, row.monster_ai, row.updated_at],
    );
  }
}
