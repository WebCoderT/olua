import { Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * 出厂数据 = `server/data/config-sync.sql`（#655 之后**唯一**的书写处）
 *
 * ===========================================================================
 * 为什么是 SQL 文件，而不是 TS 里的 seed 常量
 * ===========================================================================
 * 以前出厂数据是 `server/src/shared/*-seed.ts` + `*.generated.ts` 一堆 TS 常量：
 * 服务端启动时 `INSERT OR IGNORE` 灌库，**库里和代码里各有一份**。两份的后果是
 * 「哪个才是权威」永远说不清 —— 运营在管理端改完，重启又被种子盖回来的 bug 修过几次，
 * 就是这套双份数据的必然产物。
 *
 * #655 之后口径只剩一条：**库里是权威，`config-sync.sql` 是出厂快照**。
 * 空库启动时把快照整份灌进去（一次性），之后所有读都走库、所有改都走管理端，
 * 代码里不再有任何一份「数值副本」。换机器 / 新同事加入 = 拉仓库，启动即得同一套数据。
 *
 * ## 什么时候灌
 *
 * 只在**空库**上灌，判据是 `config_meta.bootstrap_at` 没有行 **且** `skills` 表为空。
 * 两条缺一不可：
 * - 有 marker → 之前处理过（灌过或「已有数据、跳过」），永不再灌；
 * - 没 marker 但库里有数据 → 存量库升级，只补 marker，**绝不整表替换**
 *   （那会把运营改过的东西冲掉，而且没有任何提示）。
 *
 * ## 为什么不是 `make config-import`
 *
 * `config-import` 是「整表替换」的同步工具，人工执行、会先备份。这里是**首启自举**：
 * 目标是「空目录 `make dev` 就能跑起来」，所以静默、幂等、不碰任何运行时表。
 * 两份都读同一个文件，所以口径天然一致 —— 快照里有什么，新库起来就有什么。
 */

/** 出厂快照的默认位置（`server/dist/database` → `server/data/config-sync.sql`） */
const DEFAULT_SNAPSHOT = join(__dirname, "..", "..", "data", "config-sync.sql");

/** 允许临时换一份快照（e2e / 特殊部署用） */
const SNAPSHOT_ENV = "CONFIG_SNAPSHOT_PATH";

/** marker：这张表是运行时表（不进快照），只记「自举有没有处理过」 */
const MARKER_TABLE = "config_meta";
const MARKER_KEY = "bootstrap_at";

/** 判空用的哨兵表：这张表有行就说明「这个库早就跑过」 */
const SENTINEL_TABLE = "skills";

export interface BootstrapResult {
  /** imported = 灌了快照；existing = 库里有数据，跳过；already = 之前处理过；missing = 快照文件不在 */
  status: "imported" | "existing" | "already" | "missing";
  /** 灌了多少行（从快照的 `-- counts:` 行汇总） */
  rows: number;
}

/**
 * 空库自举：把出厂快照灌进库
 *
 * 顺序上必须在建表之后、各 service 的 `onModuleInit` 之前 —— `DatabaseService` 是
 * 全局模块的第一个，正好满足。
 */
export function bootstrapConfigSnapshot(db: DatabaseSync, logger: Logger): BootstrapResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT ''
     );`,
  );

  const marked = db.prepare(`SELECT value FROM ${MARKER_TABLE} WHERE key = ?`).get(MARKER_KEY) as
    | { value: string }
    | undefined;
  if (marked) return { status: "already", rows: 0 };

  const existing = Number(
    (db.prepare(`SELECT COUNT(1) AS total FROM ${SENTINEL_TABLE}`).get() as { total: number }).total,
  );
  if (existing > 0) {
    // 存量库：库里的就是运营调过的真实数据，一个字都不动
    writeMarker(db, "skipped:existing");
    return { status: "existing", rows: 0 };
  }

  const file = process.env[SNAPSHOT_ENV] ?? DEFAULT_SNAPSHOT;
  if (!existsSync(file)) {
    // 不写 marker：下次启动还会再试（文件可能只是还没同步过来）
    logger.error(
      `出厂快照不存在：${file} —— 空库无法自举。` +
        `从仓库拉一份 server/data/config-sync.sql，或用 ${SNAPSHOT_ENV} 指定路径。`,
    );
    return { status: "missing", rows: 0 };
  }

  const text = readFileSync(file, "utf8");
  const rows = countRows(text);
  db.exec(text);
  // 快照里关掉了外键（自己按顺序插入），这里必须打开回来 —— 否则后面删账号不级联
  db.exec("PRAGMA foreign_keys = ON;");
  // 跟上文件头里的配置版本（#883）：不跟的话新库从 0 开始，别人导你导出的文件时
  // 版本闸会判成「库更新」而拒绝。空库场景，直接取值即可
  const version = countVersion(text);
  if (version > 0) {
    db.prepare("UPDATE config_version SET version = ?, updated_at = ? WHERE id = 1").run(version, Date.now());
  }
  writeMarker(db, `imported:${rows}`);
  logger.log(`出厂数据已从 config-sync.sql 灌入：${rows} 行 / ${countTables(text)} 张配置表 / 第 ${version} 版`);
  return { status: "imported", rows };
}

/** 从快照头部的 `-- counts: a=1,b=2` 行汇总行数（只用于日志，坏了给 0） */
function countRows(text: string): number {
  const line = text.split("\n", 12).find((item) => item.startsWith("-- counts: "));
  if (!line) return 0;
  return line
    .slice("-- counts: ".length)
    .split(",")
    .reduce((sum, pair) => {
      const value = Number(pair.split("=")[1]);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
}

/** 表张数（同一条 `-- tables:` 行） */
function countTables(text: string): number {
  const line = text.split("\n", 12).find((item) => item.startsWith("-- tables: "));
  return line ? line.slice("-- tables: ".length).split(",").length : 0;
}

/**
 * 文件头里的配置版本（`-- config-version: 42`，#883）
 *
 * 缺这一行（旧文件）就当 0：不写版本号比写一个假版本号安全 ——
 * 假的高版本会让导入闸永远误判「库更新」。
 */
function countVersion(text: string): number {
  const prefix = "-- config-version: ";
  const line = text.split("\n", 12).find((item) => item.startsWith(prefix));
  const value = line ? Number(line.slice(prefix.length).trim()) : 0;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function writeMarker(db: DatabaseSync, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO ${MARKER_TABLE} (key, value) VALUES (?, ?)`).run(MARKER_KEY, value);
}
