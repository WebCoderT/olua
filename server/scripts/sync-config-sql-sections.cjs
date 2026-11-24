#!/usr/bin/env node
/**
 * 把指定配置表的段从当前库拼接进 `data/config-sync.sql`（不整份导出）
 *
 *   cd server && node scripts/sync-config-sql-sections.cjs                       # 默认：#1215 的五张表
 *   cd server && node scripts/sync-config-sql-sections.cjs --tables maps,npcs    # 指定表
 *   node scripts/sync-config-sql-sections.cjs --check                            # 只比对不写
 *
 * ## 为什么不用 make config-export
 *
 * 整份导出会把当前库里**所有**配置表的现状（含运营还没提交的 WIP，例如 maps 的改名）
 * 一起写进快照——那不是本刀该提交的东西。本脚本只替换指定的表段，其余段落原样保留；
 * 头部的行数统计与 counts 行按拼接后的文件重算，保证快照自洽。
 *
 * ## 与 config-check 的关系
 *
 * 本脚本跑完，指定表段与库一致；其余段落若仍有运营 WIP，`make config-check` 依旧会报
 * 落后——那部分要等运营自己 `make config-export`，本脚本不代劳。
 */
"use strict";

const fs = require("node:fs");
const tooling = require("./lib/db-tooling.cjs");
const configSql = require("./lib/config-sql.cjs");

/** #1215 动过的五张表（默认值；别的刀请用 --tables 覆盖） */
const DEFAULT_TABLES = ["monsters", "map_spawn_areas", "npcs", "map_npcs", "quests"];

const MARKER_RE = /^-- ===== (\w+)（(\d+) 行）=====$/;

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

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), {
    db: "db",
    out: "out",
    check: "check",
    tables: "tables",
  });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  const tables = (args.tables ? String(args.tables).split(",") : DEFAULT_TABLES).map((name) => name.trim());
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
    const next = fromDb.get(table);
    if (lines.slice(start, end).join("\n") !== next.join("\n")) {
      lines.splice(start, end - start, ...next);
      changed.push(table);
    }
  }
  if (changed.length === 0) {
    console.log("指定表段已与库一致，无需改动。");
    return;
  }

  // 头部两行统计
  const totalLineIdx = lines.findIndex((line) => /^-- 表 \d+ 张 \/ 行 \d+ 条$/.test(line));
  if (totalLineIdx >= 0) lines[totalLineIdx] = `-- 表 ${pairs.length} 张 / 行 ${totalRows} 条`;
  const countsIdx = lines.findIndex((line) => line.startsWith("-- counts:"));
  if (countsIdx >= 0) lines[countsIdx] = `-- counts: ${pairs.map(([name, count]) => `${name}=${count}`).join(",")}`;

  if (args.check) {
    console.log(`落后表段：${changed.join(", ")}（--check 只比对，不写）`);
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
