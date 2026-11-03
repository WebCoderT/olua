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
   * 不用 `ORDER BY audio_key`：字典序会把 `login_bgm` 和 `ui_click` 排成「bgm 在前」纯属巧合，
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

  /**
   * 删掉不在清单里的行（返回删了几条）
   *
   * 为什么需要：key 改名（`login_click` → `ui_click`，#685）之后，老库里的旧行不会被
   * `INSERT OR IGNORE` 覆盖，也不会自己消失 —— 管理端会多出一个「叫 login_click 的音效项」，
   * 客户端根本不认这个 key（点了没有声音，也没有任何报错）。
   *
   * 删它是安全的：**行只来自 seed**（没有新建接口），表里出现清单外的 key 只可能是
   * 我们改过清单（改名 / 下线），不可能是运营自己加的。
   */
  deleteOrphans(keys: readonly string[]): number {
    if (keys.length === 0) return 0;
    const holes = keys.map(() => "?").join(", ");
    return this.db.execute(`DELETE FROM audio_settings WHERE audio_key NOT IN (${holes})`, [...keys]).changes;
  }
}
