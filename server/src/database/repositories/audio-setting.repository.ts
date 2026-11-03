import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { AudioSettingRow } from "../rows";

/**
 * 音效配置（`audio_settings` 表，#680）
 *
 * 与特效配置（`ui_effects`）同一取向：**行只能来自启动 seed**（按 `AUDIO_DEFAULTS` 补缺，
 * `INSERT OR IGNORE` 幂等），运营能改的是**内容**（文件路径 / 音量 / 循环 / 开关），不能增删行 ——
 * 一个 key 存在的前提是客户端有播它的代码，后台凭空造一行只会得到一个永远不响的开关。
 *
 * 所以这里只有 `seedRow` 一条插入路径，和一条 `update` 改内容。
 */
@Injectable()
export class AudioSettingRepository {
  constructor(private readonly db: DatabaseService) {}

  /** seed 一行（已有同 key 的行则跳过 —— 运营改过的值不会被重启盖回来） */
  seedRow(row: AudioSettingRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO audio_settings (audio_key, file_path, volume, loop, enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.audio_key, row.file_path, row.volume, row.loop, row.enabled, row.updated_by, row.updated_at],
    );
  }

  /**
   * 全部行，按 **seed 顺序**（= `AUDIO_KEYS` 的登记顺序：登录背景音在前）
   *
   * 不用 `ORDER BY audio_key`：字典序会把 `login_bgm` 和 `login_click` 排成「bgm 在前」纯属巧合，
   * 以后加一个 `battle_hit` 就会插到最前面。行只来自 seed，`rowid` 就是登记顺序。
   */
  listAll(): AudioSettingRow[] {
    return this.db.all<AudioSettingRow>("SELECT * FROM audio_settings ORDER BY rowid ASC");
  }

  getByKey(audioKey: string): AudioSettingRow | null {
    return this.db.get<AudioSettingRow>("SELECT * FROM audio_settings WHERE audio_key = ?", [audioKey]) ?? null;
  }

  /** 改内容（整份覆盖：一个音效项的参数是联动的一组状态，分字段更新会留下上一次的其它字段） */
  update(row: AudioSettingRow): void {
    this.db.run(
      `UPDATE audio_settings SET file_path = ?, volume = ?, loop = ?, enabled = ?, updated_by = ?, updated_at = ?
       WHERE audio_key = ?`,
      [row.file_path, row.volume, row.loop, row.enabled, row.updated_by, row.updated_at, row.audio_key],
    );
  }

  countAll(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM audio_settings");
  }
}
