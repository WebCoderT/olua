import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { RuntimeParamsRow } from "../rows";

/**
 * 客户端运行时参数（#605 / #655）—— 单行表 `runtime_params`
 *
 * 与 `mall_settings` / `equipment_meta` 同一取向：**一行、没有增删**，出厂值随
 * `config-sync.sql` 首启灌入，后台只能改内容。五组各存一列 JSON，缺键由 service 回落默认。
 * 严格说 `movement`（#811）是**服务端独占**、不进客户端快照，只是搭同一张单行表的车。
 */
@Injectable()
export class RuntimeParamsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 单行（已存在则跳过） */
  seed(row: RuntimeParamsRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO runtime_params (id, drop_params, auto_battle, guild_rules, monster_ai, movement, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      [row.drop_params, row.auto_battle, row.guild_rules, row.monster_ai, row.movement, row.updated_at],
    );
  }

  get(): RuntimeParamsRow | undefined {
    return this.db.get<RuntimeParamsRow>("SELECT * FROM runtime_params WHERE id = 1");
  }

  update(row: RuntimeParamsRow): { changes: number } {
    return this.db.execute(
      `UPDATE runtime_params SET drop_params = ?, auto_battle = ?, guild_rules = ?, monster_ai = ?, movement = ?, updated_at = ? WHERE id = 1`,
      [row.drop_params, row.auto_battle, row.guild_rules, row.monster_ai, row.movement, row.updated_at],
    );
  }
}
