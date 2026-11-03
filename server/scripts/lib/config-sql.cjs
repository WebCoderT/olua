#!/usr/bin/env node
/**
 * 配置快照的生成 / 校验（导出与导入共用）
 *
 * ===========================================================================
 * 为什么是「整表替换」而不是 upsert
 * ===========================================================================
 * upsert 只能「加或改」，**表达不了删除**。配置里删掉一条（管理端多数表不开放删除，
 * 但掉落表、任务、成就可以删）之后，upsert 会让对方库里那行永远留着 —— 两边看起来
 * 都在，只有一边是运营改过的样子。所以每张表都是 `DELETE FROM` + 逐行 `INSERT`：
 * 文件即快照，导入即「变成文件那样」。
 *
 * 这样做的前提是**文件必须是全量的**。所以 `parseMeta` / `validate` 会检查：
 * 文件头声明的表清单、实际出现的 DELETE 段、INSERT 的表名，三者都必须与
 * `config-tables.cjs` 的白名单**完全一致**。少一张就拒绝导入 —— 否则「DELETE 完
 * 没有 INSERT」会把它清空，而清空一张配置表在界面上只表现为「这一页空了」。
 *
 * ===========================================================================
 * 为什么一行一条 INSERT
 * ===========================================================================
 * 多值合并（`VALUES (...), (...)`）体积小，但 git diff 会把整块算成一处变更 ——
 * 改一行掉落会显示「这一千行都变了」。一行一条语句时，改一行就是 diff 里的一行，
 * review 时能直接看出「他把这个怪的掉率从 0.1 改成 0.15」。
 *
 * 代价是文件大一些（掉落表 19749 行 → 约 4MB），文本压缩后可以接受。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./db-tooling.cjs");
const {
  CONFIG_TABLES,
  FORMAT_TAG,
  RUNTIME_TABLES,
  TABLES_LINE_PREFIX,
  assertAllClassified,
} = require("./config-tables.cjs");

/** 默认产物（相对 server/） */
const DEFAULT_FILE = path.join("data", "config-sync.sql");

/** 导入前自动留档的目录（相对 server/） */
const BACKUP_DIR = path.join("data", "backups");

/** 标识符加双引号（表名 / 列名；值一律用 tooling.quoteSqlString） */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * JS 值 → SQL 字面量
 *
 * `node:sqlite` 回来的类型只有这几种：number / bigint / string / null / Uint8Array。
 * **不做隐式转换**：不认识就抛，宁可导出失败也不要写出一个看起来正常、导入后变形的值。
 */
function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`遇到非有限数字（${value}），无法写成 SQL 字面量`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "string") return tooling.quoteSqlString(value);
  throw new Error(`遇到不支持的值类型：${typeof value}`);
}

/** 库里所有用户表（排除 sqlite_sequence 这类系统表） */
function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all()
    .map((row) => row.name);
}

/**
 * 排序子句
 *
 * **必须显式排序**：否则 SQLite 返回顺序取决于查询计划与页布局，同一份数据两次导出
 * 可能不同 → `make config-check` 天天误报「有改动」。rowid 顺序对普通表就是插入序，
 * 最稳；WITHOUT ROWID 的表退回主键序。
 */
function orderClause(columns, createSql) {
  if (!/without\s+rowid/i.test(createSql)) return " ORDER BY rowid";
  const pk = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => quoteIdent(column.name));
  return pk.length > 0 ? ` ORDER BY ${pk.join(", ")}` : "";
}

/**
 * 从数据文件生成快照 SQL
 *
 * `options.tables` 只给测试用（注入小规模清单）；生产路径不传，走全量 `CONFIG_TABLES`。
 *
 * @param {string} dbPath 数据文件（只读打开；服务在跑也能导）
 * @param {{tables?: readonly string[]}} [options]
 * @returns {{sql: string, stats: {tables: number, rows: number}}}
 */
function build(dbPath, options = {}) {
  const configTables = options.tables ?? CONFIG_TABLES;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const actualTables = listTables(db);
    // 先做分类校验：有未归类的表就直接炸，不要「导一半」
    const { config } = assertAllClassified(actualTables, { config: configTables });

    const sections = [];
    let totalRows = 0;
    const rowCounts = [];

    for (const table of config) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
      if (columns.length === 0) throw new Error(`表 ${table} 没有列信息（PRAGMA table_info 返回空）`);
      const createSql =
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? "";
      const select = `SELECT ${columns.map((column) => quoteIdent(column.name)).join(", ")} FROM ${quoteIdent(table)}${orderClause(columns, createSql)}`;
      const rows = db.prepare(select).all();

      const lines = [`-- ===== ${table}（${rows.length} 行）=====`, `DELETE FROM ${quoteIdent(table)};`];
      const columnNames = columns.map((column) => column.name);
      // 列名必须显式写出来：**表的物理列顺序不是契约**。存量库是用 `ALTER TABLE ADD COLUMN`
      // 一路长出来的（新列追加在末尾），而新建库按 `CREATE TABLE` 里写的顺序建 —— 两边一旦
      // 不同，位置式 `INSERT INTO t VALUES (…)` 就会把值塞进别的列（`souls.upgrade_order`
      // 撞唯一索引就是这么炸的，见 #655）。写列名之后，追加列 / 调顺序都不再影响导入。
      const columnList = columnNames.map((name) => quoteIdent(name)).join(", ");
      for (const row of rows) {
        lines.push(
          `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${columnNames.map((name) => literal(row[name])).join(", ")});`,
        );
      }
      lines.push("");
      sections.push(lines.join("\n"));
      totalRows += rows.length;
      rowCounts.push(`${table}=${rows.length}`);
    }

    const header = [
      "-- olua 配置快照（由 `make config-export` 从本地库生成，不要手改）",
      "--",
      "-- 只含配置表：账号 / 角色存档 / 审计日志 / 世界怪物实例不在这个文件里。",
      "-- 导入：make config-import（整表替换；账号与角色存档不受影响）",
      `-- 表 ${config.length} 张 / 行 ${totalRows} 条`,
      FORMAT_TAG,
      TABLES_LINE_PREFIX + config.join(","),
      `-- counts: ${rowCounts.join(",")}`,
      "",
      "PRAGMA foreign_keys = OFF;",
      "BEGIN;",
      "",
    ].join("\n");

    const sql = `${header}${sections.join("\n")}COMMIT;\n`;
    return { sql, stats: { tables: config.length, rows: totalRows } };
  } finally {
    db.close();
  }
}

/** 读文件头里的格式标记与表清单 */
function parseMeta(text) {
  const lines = text.split("\n");
  const tag = lines.some((line) => line.trim() === FORMAT_TAG) ? FORMAT_TAG : null;
  const tablesLine = lines.find((line) => line.startsWith(TABLES_LINE_PREFIX));
  const tables = tablesLine
    ? tablesLine
        .slice(TABLES_LINE_PREFIX.length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  return { tag, tables };
}

/** 两份清单是否完全相同（不看顺序，但看数量 —— 少了多了都是问题） */
function sameTableSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * 校验一份快照 SQL 能不能安全导入
 *
 * 三道关，任何一道不过都不写库：
 * 1. 是本工具生成的（格式标记）；
 * 2. 表清单与白名单完全一致（防止旧文件少一张表 → 那张被清空）；
 * 3. 每张配置表**恰好一条** DELETE（少 = 没清旧行，多 = 文件被拼过），
 *    且没有任何 INSERT 指向运行时表（防止有人把账号数据塞进来）。
 *
 * `tables` 只给测试用；生产路径不传，走全量 `CONFIG_TABLES`。
 */
function validate(text, meta, tables = CONFIG_TABLES) {
  if (meta.tag !== FORMAT_TAG) {
    throw new Error(`这不是 olua 配置快照：文件里找不到 "${FORMAT_TAG}"。导入只认 make config-export 的产物。`);
  }
  if (meta.tables.length === 0) {
    throw new Error(`文件头缺少表清单（${TABLES_LINE_PREFIX}…），无法判断它是不是全量的。`);
  }
  if (!sameTableSet(meta.tables, tables)) {
    const declared = new Set(meta.tables);
    const expected = new Set(tables);
    const missing = tables.filter((name) => !declared.has(name));
    const extra = meta.tables.filter((name) => !expected.has(name));
    throw new Error(
      `文件的表清单与当前脚本不一致：${[
        missing.length > 0 ? `缺 ${missing.join(", ")}` : "",
        extra.length > 0 ? `多 ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("；")}\n  说明这份文件是旧版本导出的（中间加过配置表），重新导出一份。`,
    );
  }

  const deletes = [...text.matchAll(/^DELETE FROM "([^"]+)";$/gm)].map((match) => match[1]);
  const deleteCounts = new Map();
  for (const table of deletes) deleteCounts.set(table, (deleteCounts.get(table) ?? 0) + 1);
  const badDelete = tables.filter((table) => deleteCounts.get(table) !== 1);
  if (badDelete.length > 0) {
    throw new Error(
      `这些表的 DELETE 段数量不对（要求恰好 1 条）：${badDelete
        .map((table) => `${table}=${deleteCounts.get(table) ?? 0}`)
        .join(", ")}\n  文件可能被手工拼过，或者截断了 —— 重新导出一份。`,
    );
  }

  // 运行时表永远是全量检查（不受 tables 参数影响）：它是安全边界，不能跟着测试一起缩小
  const runtime = new Set(RUNTIME_TABLES);
  const touched = [...text.matchAll(/(?:^|\n)(?:INSERT INTO|DELETE FROM) "([^"]+)"/g)].map((match) => match[1]);
  const leaked = [...new Set(touched.filter((table) => runtime.has(table)))];
  if (leaked.length > 0) {
    throw new Error(`文件里出现了运行时表（${leaked.join(", ")}）—— 账号 / 存档 / 审计不能跟着配置走，拒绝导入。`);
  }

  const unknown = [...new Set(touched.filter((table) => !tables.includes(table)))];
  if (unknown.length > 0) {
    throw new Error(`文件里出现了未登记的表：${unknown.join(", ")}。先把它归到 config-tables.cjs 的某个清单里。`);
  }
}

/**
 * 比对「当前库生成的结果」与「仓库里那份文件」
 *
 * @returns {null | {firstLine: number, section: string, expectedLines: number, actualLines: number}}
 */
function compare(expectedSql, actualText) {
  if (expectedSql === actualText) return null;
  const expected = expectedSql.split("\n");
  const actual = actualText.split("\n");

  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index += 1;

  // 往上找最近的节标题，报「哪张表不一样」比报行号有用
  let section = "文件头";
  for (let cursor = Math.min(index, expected.length - 1); cursor >= 0; cursor -= 1) {
    const match = /^-- ===== (\S+?)（/.exec(expected[cursor]);
    if (match) {
      section = match[1];
      break;
    }
  }

  return { firstLine: index + 1, section, expectedLines: expected.length, actualLines: actual.length };
}

/** 先写临时文件再 rename：中途失败不会留下半截文件被误提交 */
function writeAtomic(target, sql) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, sql, "utf8");
  fs.renameSync(temp, target);
}

/** 解析 SQL 文件路径（命令行 → 默认 data/config-sync.sql，相对 server/） */
function resolveSqlPath(cliValue) {
  const raw = cliValue || DEFAULT_FILE;
  return path.isAbsolute(raw) ? raw : path.resolve(tooling.SERVER_DIR, raw);
}

/** 导入前的留档路径（`data/backups/config-before-import-20261103-154500.sql`） */
function backupPathForImport(date = new Date()) {
  return path.resolve(tooling.SERVER_DIR, BACKUP_DIR, `config-before-import-${tooling.stamp(date)}.sql`);
}

module.exports = {
  BACKUP_DIR,
  DEFAULT_FILE,
  backupPathForImport,
  build,
  compare,
  listTables,
  parseMeta,
  quoteIdent,
  resolveSqlPath,
  validate,
  writeAtomic,
};
