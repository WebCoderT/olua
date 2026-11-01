import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { UiEffectRow } from "../rows";

/**
 * 界面特效配置（`ui_effects` 表，#594）
 *
 * 与地图玩法配置同一取向：**行只能来自启动 seed**（按 `UI_EFFECT_DEFAULTS` 补缺，
 * `INSERT OR IGNORE` 幂等），运营能改的是**内容**（摆位 / 缩放 / 旋转 / 时长 / 开关），
 * 不能增删行 —— 一个 key 存在的前提是客户端有这个特效的消费代码，
 * 后台凭空造一行只会得到一个永远不生效的开关。
 *
 * 所以这里只有 `seedRow` 一条插入路径，和一条 `update` 改内容。
 */
@Injectable()
export class UiEffectRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已有同 key 的行则跳过 —— 运营改过的值不会被重启盖回来） */
  seedRow(row: UiEffectRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO ui_effects (effect_key, offset_x, offset_y, scale_x, scale_y, rotate, duration_ms, enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.effect_key, row.offset_x, row.offset_y, row.scale_x, row.scale_y, row.rotate, row.duration_ms, row.enabled, row.updated_by, row.updated_at],
    );
  }

  /** 全部行，按 key 字典序（页面顺序稳定；key 就那么几个，不值得再按别的排） */
  listAll(): UiEffectRow[] {
    return this.db.all<UiEffectRow>("SELECT * FROM ui_effects ORDER BY effect_key ASC");
  }

  getByKey(effectKey: string): UiEffectRow | null {
    return this.db.get<UiEffectRow>("SELECT * FROM ui_effects WHERE effect_key = ?", [effectKey]) ?? null;
  }

  /** 改内容（不做部分更新：一个特效的参数是联动的一组状态，分字段更新会留下上一次的其它字段） */
  update(row: UiEffectRow): void {
    this.db.run(
      `UPDATE ui_effects SET offset_x = ?, offset_y = ?, scale_x = ?, scale_y = ?, rotate = ?, duration_ms = ?, enabled = ?, updated_by = ?, updated_at = ?
       WHERE effect_key = ?`,
      [row.offset_x, row.offset_y, row.scale_x, row.scale_y, row.rotate, row.duration_ms, row.enabled, row.updated_by, row.updated_at, row.effect_key],
    );
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM ui_effects");
  }
}
