#!/usr/bin/env node
/**
 * 导出配置快照（库 → SQL，覆盖写）
 *
 *   node scripts/config-export.cjs                 # 写 data/config-sync.sql
 *   node scripts/config-export.cjs --out /tmp/x.sql
 *   node scripts/config-export.cjs --check         # 只比对，不写（落后时退出码 1）
 *
 * 用法场景：管理端改完配置 → `make config-export` → 提交 `data/config-sync.sql` →
 * 别人 `git pull` 后 `make config-import`。运行时数据（账号 / 存档 / 审计）不在文件里。
 *
 * 导出是**只读**的：用只读连接打开，服务端在跑也能导（WAL 保证读到已提交的一致状态）。
 * 不用 `VACUUM INTO` 也不用停服 —— 那个是为了拿「整个库的单文件副本」，这里只要部分表。
 */
"use strict";

const fs = require("node:fs");
const tooling = require("./lib/db-tooling.cjs");
const configSql = require("./lib/config-sql.cjs");

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { out: "out", db: "db", check: "check" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  const target = configSql.resolveSqlPath(args.out);

  // 先证明源文件是我们那个库（不存在 / 损坏 / 拿错文件都在这拦下）
  tooling.inspect(dbPath, { label: "数据文件" });
  const { sql, stats } = configSql.build(dbPath);

  if (args.check) {
    check(target, sql, stats);
    return;
  }

  configSql.writeAtomic(target, sql);
  console.log("配置快照已导出");
  console.log(`  源文件：${dbPath}`);
  console.log(`  写入：  ${target}`);
  console.log(`  内容：  ${stats.tables} 张配置表 / ${stats.rows} 行 / ${tooling.formatBytes(Buffer.byteLength(sql))} / 第 ${stats.version} 版`);
  console.log("  下一步：git add 这个文件并提交；别人 pull 后跑 make config-import");
}

/** `--check`：报告「仓库里那份是否落后于当前库」，落后则退出码 1（给 make / CI 用） */
function check(target, sql, stats) {
  if (!fs.existsSync(target)) {
    console.error(`配置快照还没导出过：${target}`);
    console.error("  先跑一次 make config-export，把基线提交上去。");
    process.exitCode = 1;
    return;
  }

  const existing = fs.readFileSync(target, "utf8");
  const diff = configSql.compare(sql, existing);
  if (!diff) {
    console.log(`配置快照是最新的（${stats.tables} 张表 / ${stats.rows} 行）`);
    return;
  }

  console.error(`配置快照已落后于当前库：${diff.section}（第 ${diff.firstLine} 行起）`);
  console.error(`  当前库 ${stats.tables} 张表 / ${stats.rows} 行；文件 ${diff.actualLines} 行、库里生成 ${diff.expectedLines} 行`);
  console.error("  改完配置忘了导出？跑 make config-export 覆盖它。");
  process.exitCode = 1;
}

main();
