import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { GuideSettingsRow } from "../rows";

/**
 * 新手引导步骤（#605）—— 单行表 `guide_settings`
 *
 * 与 `runtime_params` / `equipment_meta` 同一取向：**一行、没有增删**，seed 自
 * `shared/guide-seed.ts`（INSERT OR IGNORE 幂等，运营改过的整份步骤表不会被覆盖回去）。
 * 「加一步 / 删一步」是改那一列 JSON 数组，不是加行删行。
 */
@Injectable()
export class GuideSettingsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 单行（已存在则跳过） */
  seed(row: GuideSettingsRow): void {
    this.db.run("INSERT OR IGNORE INTO guide_settings (id, steps, updated_at) VALUES (1, ?, ?)", [row.steps, row.updated_at]);
  }

  get(): GuideSettingsRow | undefined {
    return this.db.get<GuideSettingsRow>("SELECT * FROM guide_settings WHERE id = 1");
  }

  update(row: GuideSettingsRow): { changes: number } {
    return this.db.execute("UPDATE guide_settings SET steps = ?, updated_at = ? WHERE id = 1", [row.steps, row.updated_at]);
  }
}
