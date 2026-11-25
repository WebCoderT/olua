#!/usr/bin/env node
/**
 * 把指定配置表的段从当前库拼接进 `data/config-sync.sql`（不整份导出）
 *
 *   cd server && node scripts/sync-config-sql-sections.cjs                       # 默认：#1215 的五张表
 *   cd server && node scripts/sync-config-sql-sections.cjs --tables maps,npcs    # 指定表
 *   node scripts/sync-config-sql-sections.cjs --tables monster_presentation --columns speed_rate
 *   node scripts/sync-config-sql-sections.cjs --check                            # 只比对不写
 *
 * ## 为什么不用 make config-export
 *
 * 整份导出会把当前库里**所有**配置表的现状（含运营还没提交的 WIP，例如 maps 的改名）
 * 一起写进快照——那不是本刀该提交的东西。本脚本只替换指定的表段，其余段落原样保留；
 * 头部的行数统计与 counts 行按拼接后的文件重算，保证快照自洽。
 *
 * ## `--columns`：列级精确刀（#1257）
 *
 * 整段拼接是**列级不分**的：库里该表所有列的现值都会进文件。#1254 实踩——同步
 * `monster_presentation` 时把运营手调未导出的 `move_speed`（2→80）一起带了进去，
 * 靠下游测试抓红才没合进去。两道防：
 *
 * 1. `--columns a,b,c`：按主键对行，**只把指定列的值替换成库值**，其余列保留文件原值
 *    —— 列级 WIP 想带也带不进来。行集有增删（结构性变化）直接报错，引导走整段同步。
 * 2. **按列差异报告**（两种模式都打印）：每列「库 ≠ 文件」的行数与去向一目了然，
 *    默认模式下哪些列的库值将被整段携带、`--columns` 下哪些 WIP 被保留，输出里看得见。
 *
 * ## 与 config-check 的关系
 *
 * 本脚本跑完，指定表段与库一致（`--columns` 下只有指定列一致）；其余段落若仍有运营
 * WIP，`make config-check` 依旧会报落后——那部分要等运营自己 `make config-export`，
 * 本脚本不代劳。
 */
"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");
const configSql = require("./lib/config-sql.cjs");

/** #1215 动过的五张表（默认值；别的刀请用 --tables 覆盖） */
const DEFAULT_TABLES = ["monsters", "map_spawn_areas", "npcs", "map_npcs", "quests"];

const MARKER_RE = /^-- ===== (\w+)（(\d+) 行）=====$/;
const INSERT_RE = /^INSERT INTO "([^"]+)" \(([^)]+)\) VALUES \((.*)\);$/;

/** 把一段 SQL 按表段切开：table -> [marker 行 .. 下一 marker 前] */
function splitSections(lines) {
  const sections = new Map();
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const match = MARKER_RE.exec(line);
    if (match) {
      if (current) sections.set(current, buffer);
      current = match[1];
      buffer = [line];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) sections.set(current, buffer);
  return sections;
}

/** JS 值 → SQL 字面量（与 config-sql.literal 同口径；那边没导出，这里复制一份小实现） */
function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`遇到非有限数字（${value}），无法写成 SQL 字面量`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return tooling.quoteSqlString(String(value));
}

/** 按顶层逗号切 VALUES 段（引号内的逗号 / 括号不切；'' 转义识别） */
function splitTopLevel(segment) {
  const parts = [];
  let inString = false;
  let depth = 0;
  let current = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (segment[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** 解析一行 INSERT：返回 { table, columns, values }；非 INSERT 行返回 null */
function parseInsertLine(line) {
  const match = INSERT_RE.exec(line);
  if (!match) return null;
  const columns = match[2].split(",").map((name) => name.trim().replace(/^"|"$/g, ""));
  const values = splitTopLevel(match[3]);
  if (columns.length !== values.length) {
    throw new Error(`INSERT 行列数与值数不一致（${columns.length} vs ${values.length}）：${line.slice(0, 80)}…`);
  }
  return { table: match[1], columns, values };
}

/**
 * 按列差异报告：对比「文件段」与「库段」的同主键行，逐列统计不同的行数
 *
 * @param pkName 主键列名（PRAGMA 探测，主键不一定排第一列）
 * @returns Map<列名, { diff: number, total: number, sample: string }>（只含有差异的列）
 */
function diffByColumn(fileLines, dbLines, pkName) {
  const fileRows = fileLines.map(parseInsertLine).filter(Boolean);
  const dbRows = dbLines.map(parseInsertLine).filter(Boolean);
  const diffs = new Map();
  if (!pkName || fileRows.length === 0 || dbRows.length === 0) return diffs;
  const fileByPk = new Map(fileRows.map((row) => [row.values[row.columns.indexOf(pkName)], row]));
  for (const column of fileRows[0].columns) {
    let diff = 0;
    let sample = "";
    for (const row of dbRows) {
      const pk = row.values[row.columns.indexOf(pkName)];
      const fileRow = fileByPk.get(pk);
      if (!fileRow) continue;
      const dbValue = row.values[row.columns.indexOf(column)];
      const fileValue = fileRow.values[fileRow.columns.indexOf(column)];
      if (dbValue !== fileValue) {
        diff += 1;
        if (!sample) sample = `${pk}: 文件 ${fileValue} → 库 ${dbValue}`;
      }
    }
    if (diff > 0) diffs.set(column, { diff, total: fileRows.length, sample });
  }
  return diffs;
}

/** 打印按列差异报告（carry = true 表示整段同步、库值全带；列级刀下目标列替换、其余列保留） */
function printDiffReport(table, fileLines, dbLines, pkName, carry, targetColumns) {
  const diffs = diffByColumn(fileLines, dbLines, pkName);
  if (diffs.size === 0) {
    console.log(`  [${table}] 库与文件逐列一致。`);
    return;
  }
  for (const [column, { diff, total, sample }] of diffs) {
    const disposition = carry
      ? "整段携带 → 文件"
      : targetColumns && targetColumns.includes(column)
        ? "目标列：替换为库值"
        : "保留文件原值，不携带";
    console.log(`  [${table}] ${column}: ${diff}/${total} 行不同（${disposition}）`);
    if (sample) console.log(`      例：${sample}`);
  }
}

/** 探测表的主键列（按 pk 序返回列名；主键不一定排第一列，不能按位置猜） */
function primaryKeyColumns(db, table) {
  const columnInfo = db.prepare(`PRAGMA table_info(${configSql.quoteIdent(table)})`).all();
  const pkColumns = columnInfo
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  if (pkColumns.length === 0) throw new Error(`表 ${table} 没有主键，列级刀 / 逐列对比无法对行`);
  return pkColumns;
}

/**
 * 列级精确刀：基于文件段逐行改指定列的值（主键对行），其余列原样保留
 *
 * 行集必须与库一致（增删属结构性变化，引导走整段同步）——否则「文件少了的行」既不能
 * 补（那等于带进库的新行）也不能删（删除是运营决策），宁可拒绝。
 */
function spliceColumns(table, fileLines, dbLines, targetColumns, db) {
  const fileRows = fileLines.map(parseInsertLine);
  const dbRows = dbLines.map(parseInsertLine).filter(Boolean);
  const insertIdxs = [];
  for (let i = 0; i < fileLines.length; i += 1) {
    if (INSERT_RE.test(fileLines[i])) insertIdxs.push(i);
  }
  if (insertIdxs.length === 0) throw new Error(`表 ${table} 的文件段里没有 INSERT 行`);

  const columnNameSet = new Set(
    db.prepare(`PRAGMA table_info(${configSql.quoteIdent(table)})`).all().map((column) => column.name),
  );
  const pkColumns = primaryKeyColumns(db, table);
  for (const column of targetColumns) {
    if (!columnNameSet.has(column)) throw new Error(`表 ${table} 没有列 ${column}（--columns 拼错？）`);
  }

  const pkOf = (row) => pkColumns.map((name) => row.values[row.columns.indexOf(name)]).join("\u0001");
  const dbByPk = new Map(dbRows.map((row) => [pkOf(row), row]));
  const pkName = pkColumns[0];

  const next = [...fileLines];
  let replacedRows = 0;
  for (const idx of insertIdxs) {
    const parsed = parseInsertLine(next[idx]);
    if (!parsed) continue;
    const pk = parsed.values[parsed.columns.indexOf(pkName)];
    const dbRow = dbByPk.get(pk);
    if (!dbRow) {
      throw new Error(
        `表 ${table} 的行 ${pk} 在库里不存在（文件与库的行集不一致）。结构性增删请走整段同步（不带 --columns）或先 make config-export。`,
      );
    }
    const newValues = [...parsed.values];
    let touched = false;
    for (const column of targetColumns) {
      const valueIdx = parsed.columns.indexOf(column);
      const dbValue = dbRow.values[dbRow.columns.indexOf(column)];
      if (newValues[valueIdx] !== dbValue) {
        newValues[valueIdx] = dbValue;
        touched = true;
      }
    }
    if (touched) {
      replacedRows += 1;
      next[idx] = `INSERT INTO ${configSql.quoteIdent(table)} (${parsed.columns.map((name) => configSql.quoteIdent(name)).join(", ")}) VALUES (${newValues.join(", ")});`;
    }
  }
  // 库里多出来的行在列级刀下同样拒绝（与上面缺行同一条错误路径的对称面）
  const filePkSet = new Set(fileRows.filter(Boolean).map(pkOf));
  for (const row of dbRows) {
    if (!filePkSet.has(pkOf(row))) {
      throw new Error(
        `表 ${table} 的库里有文件没有的行 ${row.values[row.columns.indexOf(pkName)]}。结构性增删请走整段同步（不带 --columns）。`,
      );
    }
  }
  return { lines: next, replacedRows };
}

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), {
    db: "db",
    out: "out",
    check: "check",
    tables: "tables",
    columns: "columns",
  });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  const tables = (args.tables ? String(args.tables).split(",") : DEFAULT_TABLES).map((name) => name.trim());
  const columnFilter = args.columns
    ? String(args.columns).split(",").map((name) => name.trim()).filter(Boolean)
    : null;
  const target = configSql.resolveSqlPath(args.out);
  if (!fs.existsSync(target)) throw new Error(`快照不存在：${target}（先 make config-export 生成一份基底）`);
  const existing = fs.readFileSync(target, "utf8");

  const { sql } = configSql.build(dbPath);
  const fromDb = splitSections(sql.split("\n"));
  for (const table of tables) {
    if (!fromDb.has(table)) throw new Error(`生成的快照里没有表 ${table} 的段`);
  }

  const lines = existing.split("\n");
  const sections = splitSections(lines);
  for (const table of tables) {
    if (!sections.has(table)) throw new Error(`快照里没有表 ${table} 的段（先 make config-export 生成基底）`);
  }

  // 按列差异报告（两种模式都打印）：本刀会动哪些列、哪些列的库值被携带或保留，先说清楚再动手
  const db = new DatabaseSync(dbPath, { readOnly: true });
  console.log(`差异报告（${columnFilter ? `列级刀：${columnFilter.join(", ")}` : "整段同步"}）：`);
  for (const table of tables) {
    const [pkName] = primaryKeyColumns(db, table);
    printDiffReport(table, sections.get(table), fromDb.get(table), pkName, !columnFilter, columnFilter);
  }

  // 头部 counts 行同步：指定表替换成库内行数，其余键保留原值
  const countsLine = lines.find((line) => line.startsWith("-- counts:"));
  if (!countsLine) throw new Error("快照头部没有 counts 行");
  const pairs = countsLine.slice("-- counts:".length).split(",").map((entry) => {
    const [name, count] = entry.split("=");
    return [name.trim(), Number(count)];
  });
  for (const table of tables) {
    const marker = fromDb.get(table)[0];
    const match = MARKER_RE.exec(marker);
    if (!match) throw new Error(`表 ${table} 的段标记解析失败：${marker}`);
    pairs.find(([name]) => name === table)[1] = Number(match[2]);
  }
  const totalRows = pairs.reduce((sum, [, count]) => sum + count, 0);

  // 逐段替换（从后往前替换避免行号漂移）
  const changed = [];
  try {
    for (const table of [...tables].reverse()) {
      const start = lines.findIndex((line) => MARKER_RE.exec(line)?.[1] === table);
      if (start < 0) throw new Error(`快照里没有表 ${table} 的段`);
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) {
        if (MARKER_RE.exec(lines[i])) {
          end = i;
          break;
        }
      }
      let next;
      let note = "";
      if (columnFilter) {
        const spliced = spliceColumns(table, sections.get(table), fromDb.get(table), columnFilter, db);
        next = spliced.lines;
        note = `（列级刀：${spliced.replacedRows} 行替换了 ${columnFilter.join("/")}）`;
      } else {
        next = fromDb.get(table);
      }
      if (lines.slice(start, end).join("\n") !== next.join("\n")) {
        lines.splice(start, end - start, ...next);
        changed.push(`${table}${note}`);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  db.close();
  if (changed.length === 0) {
    console.log("指定表段已与库一致，无需改动。");
    return;
  }

  // 头部两行统计（列级刀行数不变，重算也无害——值与原值一致）
  const totalLineIdx = lines.findIndex((line) => /^-- 表 \d+ 张 \/ 行 \d+ 条$/.test(line));
  if (totalLineIdx >= 0) lines[totalLineIdx] = `-- 表 ${pairs.length} 张 / 行 ${totalRows} 条`;
  const countsIdx = lines.findIndex((line) => line.startsWith("-- counts:"));
  if (countsIdx >= 0) lines[countsIdx] = `-- counts: ${pairs.map(([name, count]) => `${name}=${count}`).join(",")}`;

  if (args.check) {
    console.log(`落后表段：${changed.map((entry) => entry.split("（")[0]).join(", ")}（--check 只比对，不写）`);
    process.exitCode = 1;
    return;
  }

  configSql.writeAtomic(target, lines.join("\n"));
  console.log(`已拼接 ${changed.length} 个表段：${changed.join(", ")}`);
  console.log(`  写入：${target}`);
  console.log(`  头部统计：表 ${pairs.length} 张 / 行 ${totalRows} 条`);
  console.log("其余段落（含运营 WIP）未动；整份校验仍归 make config-check。");
}

main();
