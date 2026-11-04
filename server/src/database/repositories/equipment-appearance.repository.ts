import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { EquipmentAppearanceRow } from "../rows";

/**
 * 装备外观（#695）—— 单行表 `equipment_appearance`
 *
 * 与 `guide_settings` / `runtime_params` 同一取向：**一行、没有增删**，
 * 出厂值由服务在启动时按常量 seed（`INSERT OR IGNORE` 幂等；api 与 realtime
 * 两个进程各跑一次也无副作用，运营改过的整份配置不会被重启盖回来）。
 * 四组映射各一列 JSON，「换一个组合的边框」是改那一列里的一个元素，不是加行删行。
 */
@Injectable()
export class EquipmentAppearanceRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 单行（已存在则跳过） */
  seed(row: EquipmentAppearanceRow): void {
    this.db.run(
      "INSERT OR IGNORE INTO equipment_appearance (id, borders, backgrounds, custom_borders, custom_backgrounds, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
      [row.borders, row.backgrounds, row.custom_borders, row.custom_backgrounds, row.updated_at],
    );
  }

  get(): EquipmentAppearanceRow | undefined {
    return this.db.get<EquipmentAppearanceRow>("SELECT * FROM equipment_appearance WHERE id = 1");
  }

  update(row: EquipmentAppearanceRow): { changes: number } {
    return this.db.execute(
      "UPDATE equipment_appearance SET borders = ?, backgrounds = ?, custom_borders = ?, custom_backgrounds = ?, updated_at = ? WHERE id = 1",
      [row.borders, row.backgrounds, row.custom_borders, row.custom_backgrounds, row.updated_at],
    );
  }
}
