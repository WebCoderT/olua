#!/usr/bin/env node
/**
 * 导入配置快照（SQL → 库，整表替换）
 *
 *   node scripts/config-import.cjs                  # 用 data/config-sync.sql
 *   node scripts/config-import.cjs --dry-run        # 只看会做什么，不写库
 *   node scripts/config-import.cjs --file /tmp/x.sql
 *
 * ## 只动配置表
 *
 * 文件里每张配置表都是 `DELETE` + 逐行 `INSERT`，在**一个事务**里完成。账号、角色存档、
 * 审计日志、世界怪物实例一个字都不碰 —— 所以「同步配置」不会清掉你本地那些测试账号。
 *
 * ## 三道自保
 *
 * 1. **导入前留档**：先把当前配置导出到 `data/backups/config-before-import-<时间>.sql`。
 *    导错了直接 `--file` 指回那份就能还原（配置表整表替换，没有半截状态）。
 * 2. **导入前校验**（`config-sql.validate`）：格式标记、表清单完全一致、每张表恰好一条
 *    DELETE、不含运行时表 —— 缺一张就拒绝，否则那张会被清空。
 * 3. **导入后读回校验**：重新从库里生成一份快照，与文件逐字节比对。不一致就报错
 *    （说明有值被 SQLite 规范化了，或者导入没生效）。**这比「没抛异常就算成功」可靠**。
 *
 * ## 为什么要提醒重启服务端
 *
 * 配置不只存在库里：`RuntimeConfigService` / `CombatWeightsService` 这些在启动时把值
 * 装进进程内存（覆盖层），实时进程 3101 也是各自的副本。改库不会通知它们，所以导入后
 * 必须重启 —— 单进程本地开发重启 3100 即可，四容器部署要连 `server-realtime` 一起。
 */
"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");
const configSql = require("./lib/config-sql.cjs");
const { CONFIG_TABLES } = require("./lib/config-tables.cjs");

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { file: "file", db: "db", "dry-run": "dryRun" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  const file = configSql.resolveSqlPath(args.file);

  if (!fs.existsSync(file)) {
    throw new Error(`快照文件不存在：${file}\n  从仓库拉一份，或者在改配置的那台机器上跑 make config-export。`);
  }

  const text = fs.readFileSync(file, "utf8");
  const meta = configSql.parseMeta(text);
  configSql.validate(text, meta);

  // 证明目标确实是我们的库（不存在 / 损坏 / 拿错文件都在这拦下）
  tooling.inspect(dbPath, { label: "数据文件" });
  const before = countRows(dbPath);

  if (args.dryRun) {
    const planned = countInserts(text);
    console.log("dry run（不写库）");
    console.log(`  文件：${file}（${meta.tables.length} 张配置表）`);
    console.log(`  目标：${dbPath}`);
    report(before, planned);
    return;
  }

  // 留档：导错了还能回来
  const backup = configSql.backupPathForImport();
  const { sql: currentSql } = configSql.build(dbPath);
  configSql.writeAtomic(backup, currentSql);

  const db = new DatabaseSync(dbPath);
  try {
    // 服务端在跑时可能占到写锁，等一会儿比直接 SQLITE_BUSY 好用
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(text);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经被 SQLite 自己回滚掉，这里再抛原错误 */
    }
    throw error;
  } finally {
    db.close();
  }

  // 读回校验：库里现在的样子必须与文件逐字节等价
  const { sql: afterSql, stats } = configSql.build(dbPath);
  const diff = configSql.compare(afterSql, text);
  if (diff) {
    throw new Error(
      `导入后校验失败：${diff.section}（第 ${diff.firstLine} 行起）与文件不一致。\n` +
        `  可能原因：文件是旧版本工具导出的（格式变过），或者有值被 SQLite 规范化了。\n` +
        `  导入前的配置已留档：${backup}`,
    );
  }

  const after = countRows(dbPath);
  console.log("配置已导入");
  console.log(`  文件：${file}`);
  console.log(`  目标：${dbPath}`);
  console.log(`  占用：${stats.tables} 张配置表 / ${stats.rows} 行`);
  report(before, after);
  console.log(`  导入前的配置已留档：${backup}`);
  console.log("  提醒：服务端正在跑的话要重启一次（进程内存里的配置不会自动刷新）。");
}

/** 库里每张配置表的行数 */
function countRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = {};
    for (const table of CONFIG_TABLES) {
      counts[table] = Number(db.prepare(`SELECT COUNT(1) AS total FROM ${configSql.quoteIdent(table)}`).get().total ?? 0);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** 文件里每张配置表的 INSERT 条数（dry run 用；不做类型转换，只为预览） */
function countInserts(text) {
  const counts = {};
  for (const table of CONFIG_TABLES) counts[table] = 0;
  for (const match of text.matchAll(/^INSERT INTO "([^"]+)"/gm)) {
    if (counts[match[1]] !== undefined) counts[match[1]] += 1;
  }
  return counts;
}

/**
 * 打印「哪些表的行数会变」
 *
 * 只说行数变化，不装作知道「值有没有改」—— 改一个卖价行数不变，那种改动由导入后的
 * 逐字节校验负责兜底。
 */
function report(before, after) {
  const changed = CONFIG_TABLES.filter((table) => before[table] !== after[table]);
  if (changed.length === 0) {
    console.log("  行数：没有表发生增删（改值不会体现在行数上）");
    return;
  }
  const detail = changed.map((table) => `${table} ${before[table]} → ${after[table]}`).join("；");
  console.log(`  行数：${changed.length} 张表有增删 —— ${detail}`);
}

main();
