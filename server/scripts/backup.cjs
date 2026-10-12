#!/usr/bin/env node
/**
 * 数据备份（SQLite）
 *
 *   node scripts/backup.cjs [--out <目录>] [--keep <份数>] [--days <天数>] [--db <数据文件>]
 *   npm run db:backup              # 等价，读 server/.env 的 DB_PATH
 *
 * 两个保留参数都是 `0` = 不管这一维（与其它地方的「0 = 不限制」同口径），
 * 它们是**两道独立的闸**：份数防刷爆磁盘，天数防「备份一直在失败、目录里躺着一份
 * 三个月前的老备份却被当成最新成果」。
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

/** 默认保留天数（0 = 不按时间清理：老脚本的行为只有份数这一道闸） */
const DEFAULT_DAYS = 0;

/** 一天的毫秒数（`--days` 换算用；与其它地方的保留天数同口径） */
const DAY_MS = 24 * 60 * 60 * 1000;

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { out: "out", keep: "keep", days: "days", db: "db" });
  if (args.keep === true) throw new Error("--keep 需要一个整数（要保留的备份份数；0 = 不按份数清理）");
  if (args.days === true) throw new Error("--days 需要一个整数（保留最近多少天；0 = 不按时间清理）");

  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  const outDir = tooling.resolveBackupDir(args.out);
  const keep = readCount(args.keep, DEFAULT_KEEP, "--keep");
  const days = readCount(args.days, DEFAULT_DAYS, "--days");

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
  const removed = prune(outDir, keep, days);

  console.log("数据备份完成");
  console.log(`  源文件：${dbPath}`);
  console.log(`        ${tooling.formatBytes(source.sizeBytes)} · ${tableSummary(source.counts)}`);
  console.log(`  备份到：${target}`);
  console.log(`        ${tooling.formatBytes(produced.sizeBytes)} · ${tableSummary(produced.counts)}`);
  console.log(`  保留策略：${keep > 0 ? `最近 ${keep} 份` : "不限份数"} · ${days > 0 ? `最近 ${days} 天` : "不限天数"}`);
  console.log(`  本次清理 ${removed} 份`);
}

/** 读一个「0 = 不管这一维」的计数参数（负 / 非数字一律报错，不静默当成 0） */
function readCount(raw, fallback, flag) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${flag} 必须是 ≥0 的整数，收到 ${raw}`);
  }
  return value;
}

/**
 * 按两道闸淘汰旧备份，返回清理掉多少份
 *
 * 这段清理是在**本次产出成功之后**才被调起的（`inspect` 已经验过新文件的完整性），
 * 所以「清理」永远发生在「手里已经握着一份新备份」之后 —— 这是「别把唯一的备份删掉」
 * 的唯一保障，不要把它挪到产出之前。
 *
 * 两道闸各自的候选取并集，但最终都拿**最近 keep 份**兜底：就算 `--days` 配得很小，
 * 也不会出现「目录被清空」这种比不清理还糟的结果。
 *
 * 时间看文件名里的戳（`olua-YYYYMMDD-HHmmss.db`）而不是 mtime —— 拷贝会改掉 mtime，
 * scp / 打包再解开之后，老文件的修改时间会变成「复制的时刻」。
 */
function prune(outDir, keep, days, now = Date.now()) {
  const files = fs
    .readdirSync(outDir)
    .map((name) => ({ name, at: backupStamp(name) }))
    .filter((item) => item.at !== null)
    .sort((left, right) => left.at - right.at)
    .map((item) => item.name);
  const cutoff = days > 0 ? now - days * DAY_MS : null;

  const byTime = cutoff === null ? [] : files.filter((name) => backupStamp(name) < cutoff);
  const byCount = keep <= 0 ? [] : files.slice(0, Math.max(0, files.length - keep));
  // `keep` 那道闸要保护最近 keep 份 —— 按时间该清的那些也不能把保护圈内的捎走。
  // 始终用 Set：keep<=0 时保护圈为空，但 `.has` 必须在两种情形都成立。
  const protectedNames = new Set(keep <= 0 ? [] : files.slice(Math.max(0, files.length - keep)));
  const stale = [...new Set([...byTime, ...byCount])].filter((name) => !protectedNames.has(name));

  for (const name of stale) fs.rmSync(path.join(outDir, name), { force: true });
  return stale.length;
}

/** 文件名里的毫秒时间戳；不是我们认得的备份文件返回 null */
function backupStamp(name) {
  const matched = /^olua-(\d{8})-(\d{6})\.db$/.exec(name);
  if (!matched) return null;
  const [, day, time] = matched;
  const at = new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  ).getTime();
  return Number.isNaN(at) ? null : at;
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
