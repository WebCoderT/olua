#!/usr/bin/env node
/**
 * 数据备份（SQLite）
 *
 *   node scripts/backup.cjs [--out <目录>] [--keep <份数>] [--db <数据文件>]
 *   npm run db:backup              # 等价，读 server/.env 的 DB_PATH
 *
 * ## 为什么不是「拷文件」
 * 库是 **WAL 模式**（见 DatabaseService.onModuleInit）：最近一批提交可能还在 `-wal` 里，
 * 单独拷主文件会**丢最后几次写入**，而且拷出来的东西看起来完全正常 —— 这是最坏的一种错。
 * 所以走 `VACUUM INTO`：由 SQLite 自己产出一致性快照，且输出是**已整理的单文件**
 * （不需要连带 `-wal` / `-shm`），服务正在跑的时候也能备份。
 *
 * 备份完会**校验产出物**（`PRAGMA integrity_check` + 必备表），宁可当场报错，
 * 也不要留下一份「不知道能不能用」的文件。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

const DEFAULT_KEEP = 7;

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { out: "out", keep: "keep", db: "db" });
  if (args.keep === true) throw new Error("--keep 需要一个数字（要保留的备份份数）");

  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  const outDir = tooling.resolveBackupDir(args.out);
  const keep = args.keep === undefined ? DEFAULT_KEEP : Number(args.keep);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--keep 必须是 ≥1 的整数，收到 ${args.keep}`);

  // 先证明源文件确实是我们那个库（不存在 / 损坏 / 拿错文件，都在这一步拦下）
  const source = tooling.inspect(dbPath, { label: "数据文件" });

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, tooling.backupFileName());
  if (fs.existsSync(target)) throw new Error(`同名备份已存在：${target}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // 路径是**值**，用单引号字符串；VACUUM INTO 不允许目标已存在，所以上面先查过
    db.exec(`VACUUM INTO ${tooling.quoteSqlString(target)}`);
  } finally {
    db.close();
  }

  const produced = tooling.inspect(target, { label: "备份文件" });
  const removed = prune(outDir, keep);

  console.log("数据备份完成");
  console.log(`  源文件：${dbPath}`);
  console.log(`        ${tooling.formatBytes(source.sizeBytes)} · ${tableSummary(source.counts)}`);
  console.log(`  备份到：${target}`);
  console.log(`        ${tooling.formatBytes(produced.sizeBytes)} · ${tableSummary(produced.counts)}`);
  console.log(`  保留最近 ${keep} 份，本次清理 ${removed} 份`);
}

/** 只保留最近 `keep` 份（文件名里带时间戳，字典序即时间序，不必去读文件时间） */
function prune(outDir, keep) {
  const files = fs
    .readdirSync(outDir)
    .filter((name) => /^olua-\d{8}-\d{6}\.db$/.test(name))
    .sort()
    .map((name) => path.join(outDir, name));
  const stale = keep >= files.length ? [] : files.slice(0, files.length - keep);
  for (const file of stale) fs.rmSync(file, { force: true });
  return stale.length;
}

/** `accounts 3 / roles 5 / …` */
function tableSummary(counts) {
  const parts = Object.entries(counts).map(([table, rows]) => `${table} ${rows}`);
  return parts.length ? parts.join(" / ") : "（没有表）";
}

try {
  main();
} catch (error) {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
