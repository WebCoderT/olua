#!/usr/bin/env node
/**
 * 数据恢复（SQLite）
 *
 *   node scripts/restore.cjs <备份文件> [--db <数据文件>] [--force]
 *   npm run db:restore -- backups/olua-20261009-153000.db
 *
 * 五步，每一步都是为了「恢复错了还能退回来」：
 * 1. **先校验备份**：完整性检查 + 必备表。拿一个坏文件把好库换掉，是这条路上唯一不可逆的事故；
 * 2. **检查 `-wal` / `-shm`**：它们存在说明服务可能正在跑（或上次没干净退出）。
 *    运行中恢复会被服务随后写回覆盖，所以默认**拒绝**；确认服务已停可以 `--force`；
 * 3. **现在的库改名留一份** `<库>.before-restore-<时间戳>`（不删）；
 * 4. **删掉属于旧库的 `-wal` / `-shm`**：主文件都换了，还留着旧 WAL 会让 SQLite
 *    按它去回放 → 直接损坏新库。这一步顺序不能反（先删再换也是一样的道理，只要在拷贝前完成）；
 * 5. **拷贝 + 复验**：先写成 `<库>.restoring` 再 `rename` 到位 —— 同目录改名是原子的，
 *    进程中途挂掉也不会在正式路径上留下半个文件。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const tooling = require("./lib/db-tooling.cjs");

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", force: "force" });
  const backupFile = (args._ ?? [])[0];
  if (!backupFile) throw new Error("用法：node scripts/restore.cjs <备份文件> [--db <数据文件>] [--force]");
  if ((args._ ?? []).length > 1) throw new Error(`只接受一个备份文件，多给了：${args._.slice(1).join(", ")}`);

  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  const backupPath = path.isAbsolute(backupFile) ? backupFile : path.resolve(process.cwd(), backupFile);

  // ① 校验备份
  const backup = tooling.inspect(backupPath, { label: "备份文件" });
  const missing = tooling.REQUIRED_TABLES.filter((table) => !backup.tables.includes(table));
  if (missing.length) throw new Error(`备份文件缺少必需的表：${missing.join(", ")} —— 这不像是一个 olua 数据库`);

  // ② 服务可能在跑？
  const sidecars = tooling.sidecarFiles(dbPath);
  if (sidecars.length && !args.force) {
    throw new Error(
      `数据文件旁边还有 ${sidecars.map((file) => path.basename(file)).join(" / ")} —— ` +
        "服务很可能正在运行（或上次没干净退出）。运行中恢复会被服务随后写回覆盖，" +
        "请先停服再试；确认已经停了可以加 --force",
    );
  }

  // ③ 留一份被换下来的库（不删；路径打印出来，恢复错了直接改回去）
  const previous = fs.existsSync(dbPath) ? `${dbPath}${tooling.BEFORE_RESTORE_MARK}${tooling.stamp()}` : null;
  const before = previous ? tooling.inspect(dbPath, { label: "当前数据文件" }) : null;
  if (previous) fs.renameSync(dbPath, previous);

  // ④ 旧 WAL 属于刚被换下来的那个库，必须清掉（否则新库会按它回放）
  for (const file of tooling.sidecarFiles(dbPath)) fs.rmSync(file, { force: true });

  // ⑤ 同目录内「先写临时文件再原子改名」，中途挂掉不会在正式路径留下半个文件
  const staging = `${dbPath}.restoring`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(backupPath, staging);
  fs.renameSync(staging, dbPath);
  const restored = tooling.inspect(dbPath, { label: "恢复后的数据文件" });

  console.log("数据恢复完成");
  console.log(`  备份文件：${backupPath}`);
  console.log(`          ${tooling.formatBytes(backup.sizeBytes)} · ${tableSummary(backup.counts)}`);
  if (previous && before) {
    console.log(`  原数据已留档：${previous}`);
    console.log(`          ${tooling.formatBytes(before.sizeBytes)} · ${tableSummary(before.counts)}`);
  } else {
    console.log("  原数据文件不存在（这次是新建），没有留档");
  }
  console.log(`  当前数据：${dbPath}`);
  console.log(`          ${tooling.formatBytes(restored.sizeBytes)} · ${tableSummary(restored.counts)}`);
  console.log("  提示：服务下次启动时会照常打开它；`-wal` 会在首次写入后重新生成");
}

/** `accounts 3 / roles 5 / …` */
function tableSummary(counts) {
  const parts = Object.entries(counts).map(([table, rows]) => `${table} ${rows}`);
  return parts.length ? parts.join(" / ") : "（没有表）";
}

try {
  main();
} catch (error) {
  console.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
