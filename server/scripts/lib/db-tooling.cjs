#!/usr/bin/env node
/**
 * 备份 / 恢复脚本共用的「找库、找目录」逻辑
 *
 * 单独抽出来是因为两个脚本必须**对同一个库**下手：备份到 A、恢复到 B 是最容易犯
 * 也最难发现的错（恢复完发现数据没变，其实是往另一个文件拷了）。
 *
 * 路径一律相对 `server/` 解析，**不看当前工作目录** —— 于是 `make backup`（在仓库根跑）、
 * `cd server && npm run db:backup`、`node server/scripts/backup.cjs` 全都能用。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** server/ 目录（本文件在 server/scripts/lib/ 下） */
const SERVER_DIR = path.join(__dirname, "..", "..");

/** 默认数据文件（与 config/configuration.ts 的默认值同口径） */
const DEFAULT_DB_PATH = path.join("data", "olua.db");

/** 默认备份目录 */
const DEFAULT_BACKUP_DIR = path.join("backups");

/** 恢复前会保留一份「被换下来的库」，用来一眼认出它 */
const BEFORE_RESTORE_MARK = ".before-restore-";

/**
 * 读 `server/.env`（不存在就跳过）
 *
 * 用 Node 自带的 `loadEnvFile`（22+ 都有），不引 dotenv —— 备份脚本是运维在最需要它的时候
 * 才跑的东西，少一个依赖少一个坑。**已存在的环境变量优先**（`loadEnvFile` 不覆盖），
 * 所以临时指定 `DB_PATH=... npm run db:backup` 能盖过 `.env`。
 */
function loadServerEnv() {
  try {
    process.loadEnvFile(path.join(SERVER_DIR, ".env"));
  } catch {
    /* 没有 .env 就用默认值 */
  }
}

/**
 * 解析数据文件路径
 *
 * 优先级：命令行 `--db` → 环境变量 / `.env` 的 `DB_PATH` → 默认 `data/olua.db`。
 * 相对路径按 `server/` 解析（服务端自己也是相对 `process.cwd()`，而它总是从 server/ 启动）。
 */
function resolveDbPath(cliValue) {
  const raw = cliValue || process.env.DB_PATH || DEFAULT_DB_PATH;
  if (raw === ":memory:") {
    throw new Error("DB_PATH 是 :memory:（内存库），没有文件可备份 —— 这个部署形态下备份要靠别的办法");
  }
  return path.isAbsolute(raw) ? raw : path.resolve(SERVER_DIR, raw);
}

/** 解析备份目录（命令行 `--out` → BACKUP_DIR → server/backups） */
function resolveBackupDir(cliValue) {
  const raw = cliValue || process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(SERVER_DIR, raw);
}

/** 本地时间戳 `YYYYMMDD-HHmmss`（文件名里带它，所以字典序就是时间序，方便按名字保留最近 N 份） */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 备份文件名（`olua-20261009-153000.db`） */
function backupFileName(date = new Date()) {
  return `olua-${stamp(date)}.db`;
}

/** 单引号字符串转义（SQL 里表名/路径都这么写；标识符才用双引号） */
function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 把 SQLite 的 -wal / -shm 兄弟文件列出来（存在 = 服务可能正在跑，或上次没干净退出） */
function sidecarFiles(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`].filter((file) => fs.existsSync(file));
}

/** 人类可读的字节数 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
}

/**
 * 打开一个 SQLite 文件做校验（只读）
 *
 * 备份与恢复都要先证明「这个文件确实是我们那个库」：宁可在这里拒绝，
 * 也不要拿一个半截文件把生产库换掉。
 *
 * **注意只读连接的副作用**：WAL 库的 `-shm` / `-wal` 由连接自己维护，而只读连接
 * 建得出、删不掉（没有写权限）—— 于是「只读地看一眼」也会在数据文件旁边留下一对空文件。
 * 恢复脚本正是拿这对文件当「服务是不是还在跑」的信号，留着它就是误报。
 * 所以这里把我们**自己带出来的空文件**擦掉；非空的（真有未合并的提交）一律不碰。
 */
function inspect(dbPath, { label }) {
  const { DatabaseSync } = require("node:sqlite");
  if (!fs.existsSync(dbPath)) throw new Error(`${label}不存在：${dbPath}`);
  const existed = new Set(sidecarFiles(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const verdict = integrity ? Object.values(integrity)[0] : null;
    if (verdict !== "ok") throw new Error(`${label}完整性检查未通过：${String(verdict)}`);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all()
      .map((row) => row.name);
    // 顺手把行数也带走：备份完打印一份「备份里有多少数据」，比只报文件大小有用得多
    const counts = {};
    for (const table of tables) {
      counts[table] = Number(Object.values(db.prepare(`SELECT COUNT(1) AS total FROM "${table}"`).get())[0] ?? 0);
    }
    return { tables, counts, sizeBytes: fs.statSync(dbPath).size };
  } finally {
    db.close();
    for (const suffix of ["-wal", "-shm"]) {
      const file = `${dbPath}${suffix}`;
      if (existed.has(file) || !fs.existsSync(file)) continue;
      if (fs.statSync(file).size === 0) fs.rmSync(file, { force: true });
    }
  }
}

/**
 * 必须具备的表（缺一个就说明这个文件不是 olua 的库）
 *
 * 与 DatabaseService.migrate 建的表同口径：这里**故意写死**而不去数据库里动态枚举 ——
 * 「备份文件里该有什么」是一个预期，不是事实，动态枚举正好会把「少了表」这件事漏掉。
 */
const REQUIRED_TABLES = ["accounts", "admins", "roles", "audit_logs"];

/** 解析 `--key value` 形式的参数 */
function parseArgs(argv, spec) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._ = result._ ?? [];
      result._.push(token);
      continue;
    }
    const name = token.slice(2);
    const key = spec[name];
    if (!key) throw new Error(`未知参数 --${name}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

module.exports = {
  BEFORE_RESTORE_MARK,
  DEFAULT_BACKUP_DIR,
  SERVER_DIR,
  REQUIRED_TABLES,
  backupFileName,
  formatBytes,
  inspect,
  loadServerEnv,
  parseArgs,
  quoteSqlString,
  resolveBackupDir,
  resolveDbPath,
  sidecarFiles,
  stamp,
};
