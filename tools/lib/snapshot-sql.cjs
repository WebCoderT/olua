#!/usr/bin/env node
/**
 * 读配置快照（`server/data/config-sync.sql`）里的行
 *
 * ===========================================================================
 * 为什么审计要读快照，而不是读库
 * ===========================================================================
 * #655 起数据只剩一处权威 —— 数据库。但审计要在**任何机器**上跑（CI 上没有 `.db`），
 * 所以静态守卫读的是仓库里那份 `make config-export` 生成的快照：它是库的逐行投影，
 * 且随 PR 一起 review。**要「按当前库」判断的场合不走这里**，那是 `make config-check`
 * 的活（它连库、重新导出一遍再逐字节比）。
 *
 * ===========================================================================
 * 为什么可以按行解析
 * ===========================================================================
 * 导出格式是自己定的（`server/scripts/lib/config-sql.cjs`）：一行一条 INSERT，
 * 带**显式列清单** —— `INSERT INTO "t" ("a", "b") VALUES (1, 'x');`。于是：
 * - 不用关心物理列顺序（追加过列的老库和新库导出的是同一个形状）；
 * - 只要处理三种字面量：数字、单引号字符串（内部 `''` 转义）、NULL。
 *
 * 唯一要小心的是「值里带逗号」：JSON 列（地图 content / 掉落表）里全是逗号，
 * 所以拆分必须跳过引号内的内容 —— `splitValues()` 就是干这个的。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");

/** 仓库里那份快照的位置 */
const SNAPSHOT_FILE = path.join(REPO, "server", "data", "config-sync.sql");

/** 读整份快照文本（不存在返回 null，由调用方决定是报红还是跳过） */
function readSnapshotText(file = SNAPSHOT_FILE) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * 拆一行 SQL 值
 *
 * @param {string} text `VALUES (` 与 `);` 之间的内容
 * @returns {Array<number|string|null>}
 */
function splitValues(text) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      // 连续两个单引号 = 值里的一个单引号字符，不改变引号状态
      if (quoted && text[index + 1] === "'") {
        current += "'";
        index += 1;
        continue;
      }
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(coerce(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") values.push(coerce(current.trim()));
  return values;
}

/** SQL 字面量 → JS 值（只处理本仓库导出会写出的三种） */
function coerce(raw) {
  if (raw === "NULL") return null;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}

/** `sell_price` → `sellPrice` */
function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/**
 * 某张表的全部行，**列名转 camelCase、JSON 列解开**
 *
 * `readRows` 给「按列名原文取值」的静态审计用（它只关心几个具体列）；
 * 这个给「要拿去和接口 / DTO 对照」的场合用（e2e、客户端单测沙箱）—— DTO 就是
 * camelCase 出去的，两边写同一个字段名，读的人不用来回对照。
 *
 * JSON 列（掉落 `entries` / 引导 `steps` / 地图 `content`）在库里是 TEXT，快照里
 * 也就是一段带引号的 JSON —— 以 `[` / `{` 开头的字符串按 JSON 解开。**只认这个前缀**：
 * `'0002'` 这种 NPC id 必须是字符串（转成 2 就再也查不到了）。
 *
 * @param {string} text 快照全文
 * @param {string} table 表名
 * @returns {Array<Record<string, unknown>>}
 */
function readRowsCamel(text, table) {
  return readRows(text, table).map((row) => {
    const result = {};
    for (const [name, value] of Object.entries(row)) {
      if (typeof value === "string" && (value[0] === "[" || value[0] === "{")) {
        try {
          result[camel(name)] = JSON.parse(value);
          continue;
        } catch {
          // 不是 JSON 就原样留着（描述文案偶尔以 [ 开头也不会被吃掉）
        }
      }
      result[camel(name)] = value;
    }
    return result;
  });
}

/**
 * 某张表的全部行
 *
 * @param {string} text 快照全文
 * @param {string} table 表名
 * @returns {Array<Record<string, number|string|null>>} 每行一个「列名 → 值」对象
 */
function readRows(text, table) {
  const prefix = `INSERT INTO "${table}" (`;
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const columnsEnd = line.indexOf(") VALUES (", prefix.length);
    if (columnsEnd < 0) continue;
    const columns = line
      .slice(prefix.length, columnsEnd)
      .split(", ")
      .map((name) => name.replace(/"/g, ""));
    const values = splitValues(line.slice(columnsEnd + ") VALUES (".length, line.lastIndexOf(");")));
    if (values.length !== columns.length) {
      throw new Error(`快照里 ${table} 有一行的值个数与列数不符（${values.length} vs ${columns.length}）：${line.slice(0, 120)}`);
    }
    const row = {};
    columns.forEach((name, index) => {
      row[name] = values[index];
    });
    rows.push(row);
  }
  return rows;
}

module.exports = { REPO, SNAPSHOT_FILE, readRows, readRowsCamel, readSnapshotText, splitValues };
