import { Injectable } from "@nestjs/common";
import { DatabaseService, SqlParam } from "../database.service";

/**
 * 配置版本链的数据访问（`config_version` / `config_revisions` 两张运行时表，#881 / #882）
 *
 * ===========================================================================
 * 为什么这两张表要单独一个仓储
 * ===========================================================================
 * 回滚要「把 38 张配置表整体换掉」，而**表名是数据不是常量**（清单在
 * `scripts/lib/config-tables.cjs`）——`DELETE FROM "?"` 在 SQLite 里不成立，只能在运行期
 * 拼字符串。按仓库的边界纪律，**SQL 只许出现在仓储里**，所以这层必须存在：
 * 业务侧（`ConfigVersionService` / `ConfigRevisionService`）只表达「落一层 / 取一层 /
 * 整表替换」，不拼任何一句 SQL。
 *
 * 反过来说：如果把这段 SQL 留在 service 里，`audit-server-boundaries` 会（正确地）
 * 判它「业务直连数据库」，而把仓储当成例外加白名单，等于让「SQL 收在仓储」这条不变量
 * 从此有洞。
 *
 * ## 为什么在这里做整表替换而不是逐行接口
 * 「先按列集合分组、同一组列只 prepare 一次」是纯粹的 SQL 形状问题（`toSqlValue` 也一起），
 * 放在业务里就是让调用方关心绑定细节。调用方只该问一句：这张表换成这批行，成了吗。
 */

/** 一层回滚历史的元信息（列表用；payload 不跟着走 —— 每层几 MB） */
export interface ConfigRevisionMetaRow {
  version: number;
  label: string;
  byte_size: number;
  table_count: number;
  row_count: number;
  created_by: string;
  created_at: number;
}

/** 带 payload 的一层（回滚时才取） */
export interface ConfigRevisionPayloadRow extends ConfigRevisionMetaRow {
  payload: string;
}

/** `config_version` 只有一行（`CHECK (id = 1)`），形状固定 */
export interface ConfigVersionRow {
  version: number;
  updated_at: number;
  updated_by: string;
}

@Injectable()
export class ConfigRevisionRepository {
  constructor(private readonly db: DatabaseService) {}

  //#region config_version

  /** 单行表首次访问时补上（老库升级上来时这张表可能还不存在行） */
  ensureVersionRow(): void {
    this.db.run("INSERT OR IGNORE INTO config_version (id, version, updated_at, updated_by) VALUES (1, 0, 0, '')");
  }

  currentVersion(): number {
    return this.db.count("SELECT version FROM config_version WHERE id = 1");
  }

  /** 自增并返回新值（`actor` 只记账号名，追账靠 `audit_logs`） */
  bumpVersion(username: string, now: number): number {
    this.db.run("UPDATE config_version SET version = version + 1, updated_at = ?, updated_by = ? WHERE id = 1", [
      now,
      username,
    ]);
    return this.currentVersion();
  }

  /**
   * 把版本垫到**至少** `version`（导入别人的快照后跟上对方的计数，#883）
   *
   * 只升不降：拿一份旧快照导入时版本号往回跳，会导致「客户端本地版本 ≠ 服务端」永远
   * 判断成「旧了」而反复重拉（客户端比的是不等，不是大小）。回退是 `restore` 的事，
   * 不靠版本号倒车。
   */
  raiseVersionTo(version: number, now: number): void {
    this.db.run("UPDATE config_version SET version = ?, updated_at = ? WHERE id = 1 AND version < ?", [
      version,
      now,
      version,
    ]);
  }

  //#endregion

  //#region config_revisions

  /** 最新一层的元信息（节流判断要用「上一层的操作人 + 时间」） */
  latestMeta(): Pick<ConfigRevisionMetaRow, "version" | "created_by" | "created_at"> | undefined {
    return this.db.get<Pick<ConfigRevisionMetaRow, "version" | "created_by" | "created_at">>(
      "SELECT version, created_by, created_at FROM config_revisions ORDER BY version DESC LIMIT 1",
    );
  }

  countRevisions(): number {
    return this.db.count("SELECT COUNT(1) AS total FROM config_revisions");
  }

  /** 按版本号倒序（最新在前）；不回 payload */
  listRevisions(limit: number): ConfigRevisionMetaRow[] {
    return this.db.all<ConfigRevisionMetaRow>(
      `SELECT version, label, byte_size, table_count, row_count, created_by, created_at
       FROM config_revisions ORDER BY version DESC LIMIT ?`,
      [limit],
    );
  }

  findRevision(version: number): ConfigRevisionPayloadRow | undefined {
    return this.db.get<ConfigRevisionPayloadRow>(
      `SELECT version, label, payload, byte_size, table_count, row_count, created_by, created_at
       FROM config_revisions WHERE version = ?`,
      [version],
    );
  }

  insertRevision(row: ConfigRevisionPayloadRow): void {
    this.db.run(
      `INSERT INTO config_revisions (version, label, payload, byte_size, table_count, row_count, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.version,
        row.label,
        row.payload,
        row.byte_size,
        row.table_count,
        row.row_count,
        row.created_by,
        row.created_at,
      ],
    );
  }

  deleteRevision(version: number): void {
    this.db.run("DELETE FROM config_revisions WHERE version = ?", [version]);
  }

  /** 删最老的 `count` 层（保留策略用；**先删再插**，不靠「满了写失败」表达） */
  deleteOldest(count: number): void {
    if (count <= 0) return;
    this.db.run(
      "DELETE FROM config_revisions WHERE version IN (SELECT version FROM config_revisions ORDER BY version ASC LIMIT ?)",
      [count],
    );
  }

  //#endregion

  //#region 配置表（表名动态，SQL 只能在这里拼）

  /** 事务（回滚的 38 张表必须在一个事务里换完） */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  /**
   * 把外键检查推到 COMMIT
   *
   * 配置表之间有引用（掉落条目 → 物品 / 装备），逐表 `DELETE` + `INSERT` 的中途状态
   * 本来是不合法的 —— 单行改动看不出来，整表替换必踩。**必须在事务内执行**。
   */
  deferForeignKeys(): void {
    this.db.run("PRAGMA defer_foreign_keys = ON");
  }

  /** 表结构里的列名（表不存在 → 空数组，调用方据此跳过） */
  tableColumns(table: string): string[] {
    return this.db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((column) => column.name);
  }

  /** 建表语句（判断 WITHOUT ROWID 用） */
  tableSql(table: string): string {
    return this.db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])?.sql ?? "";
  }

  /**
   * 整表读出来（payload 的来源）
   *
   * 有 rowid 的表按 `rowid` 排序：同一份数据两次 dump 必须得到同一串 JSON，
   * 否则 diff 会把「顺序不同」当成「内容不同」（也会让缓存与比对失效）。
   */
  tableRows(table: string): Record<string, unknown>[] {
    const withoutRowid = /without\s+rowid/i.test(this.tableSql(table));
    return this.db.all<Record<string, unknown>>(`SELECT * FROM "${table}"${withoutRowid ? "" : " ORDER BY rowid"}`);
  }

  /**
   * 整表替换成 `rows`（调用方保证在事务里）
   *
   * 三条自保：
   * 1. 列取「payload 里的列 ∩ 当前表结构」——老 payload 少列时那些列走表默认值（不是塞 NULL）；
   * 2. 按列集合分组、每组只拼一次 INSERT（13k 行 × 拼串是实打实的开销）；
   * 3. 值统一过 `toSqlValue`（JSON 往返后数组 / 对象会变成普通对象，配置表里没有 BLOB 列）。
   *
   * @returns 实际插入的行数（`payload` 里全是不认识的列的行会被跳过，不计入）
   */
  replaceTable(table: string, rows: Record<string, unknown>[]): number {
    const known = new Set(this.tableColumns(table));
    if (known.size === 0) return 0;
    this.db.run(`DELETE FROM "${table}"`);
    const statements = new Map<string, string>();
    let inserted = 0;
    for (const row of rows) {
      const columns = Object.keys(row).filter((column) => known.has(column));
      if (columns.length === 0) continue;
      const slot = columns.join(",");
      let sql = statements.get(slot);
      if (!sql) {
        sql = `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`;
        statements.set(slot, sql);
      }
      this.db.run(
        sql,
        columns.map((column) => toSqlValue(row[column])),
      );
      inserted += 1;
    }
    return inserted;
  }

  //#endregion
}

/**
 * JS 值 → 可绑定的 SQLite 值
 *
 * 配置表里没有 BLOB：对象 / 数组一律序列化成字符串（JSON 列本来就那么存），
 * 布尔转 0 / 1。`undefined` 与 `null` 同义（那一列没值）。
 */
function toSqlValue(value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}
