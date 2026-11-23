#!/usr/bin/env node
/**
 * 一次性补数据：给存量库的 62 张地图配上进入等级（#1208）
 *
 *   cd server && node scripts/oneoff-set-map-levels.cjs              # 干跑：只打印「会改哪几行」
 *   cd server && node scripts/oneoff-set-map-levels.cjs --apply      # 真写库
 *   node scripts/oneoff-set-map-levels.cjs --db /path/to/olua.db      # 换一个库（默认 DB_PATH / data/olua.db）
 *
 * 部署机上（运行时镜像里没有 ts-node）：
 *   docker exec olua-server node scripts/oneoff-set-map-levels.cjs --apply
 *
 * ## 为什么需要脚本，而不是手改 SQL
 *
 * 等级的分档表只有一份：`src/common/constants/map-config.ts` 的 `MAP_DEFAULTS`（出厂种子）。
 * 这里**不抄一份图号→等级的表**，而是读它的编译产物、与库里现状逐行比 —— 以后运营调完再跑一次，
 * 脚本就是在「把库拉回出厂口径」；抄一份就变成第二套真相，改一处漏一处。
 * 代价是要先有 `dist`（`npm run build`；镜像里自带）。
 *
 * ## 幂等
 *
 * 只写 `level` 与来源（`updated_by` / `updated_at`），其它列（名称 / 类型 / 几何 / 复活点）不碰。
 * 值已经等于出厂值的行直接跳过 —— 所以重跑只会在第一次打印差异，之后一律「无需改动」。
 *
 * ## 什么时候该跑
 *
 * `config-sync.sql` 只在**空库首启**时整份灌入；升级上来的库（本地 dev / 部署机）不会自动
 * 获得新等级。运营也可以逐张在管理端点，62 张太费手，所以给这一条命令。
 */
"use strict";

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

/** 写进 `maps.updated_by`，出问题时一眼看出这几行是谁改的 */
const SOURCE = "oneoff-map-levels";

/** 出厂种子（编译产物；`npm run build` 之后才有） */
function loadDefaults() {
  const target = path.join(__dirname, "..", "dist", "common", "constants", "map-config.js");
  try {
    return require(target).MAP_DEFAULTS;
  } catch (error) {
    console.error(`读不到 ${target} —— 先 npm run build 再跑本脚本（镜像里本来就有编译产物）。`);
    console.error(error.message);
    process.exit(1);
  }
}

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", "dry-run": "dryRun", apply: "apply" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  // 默认干跑：这个脚本会改 60 多行运营数据，误执行一次就得逐张核对
  const apply = args.apply === true;
  const defaults = loadDefaults();

  const db = new DatabaseSync(dbPath);
  try {
    // 本地 dev / 部署机上服务端可能正握着写锁：等它放锁，别把「有人在跑」当成脚本坏了
    db.exec("PRAGMA busy_timeout = 10000");
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maps'").get();
    if (!table) {
      console.error("库里没有 maps 表 —— 先用新版本服务端启动一次（它会建表），再跑本脚本。");
      process.exitCode = 1;
      return;
    }

    const rows = db.prepare("SELECT map_id, label, type, level FROM maps").all();
    const current = new Map(rows.map((row) => [row.map_id, row]));

    const diffs = [];
    for (const entry of defaults) {
      const row = current.get(entry.id);
      if (!row) {
        // 库里有这张图的行被删了：补行是 `tools/import-map-resources.cjs` 的活，这里只提醒
        console.warn(`  跳过 图 ${entry.id}：库里没有这一行（先跑 tools/import-map-resources.cjs 补行）`);
        continue;
      }
      if (Number(row.level) !== entry.level) {
        diffs.push({ id: entry.id, label: row.label, type: row.type, from: Number(row.level), to: entry.level });
      }
    }

    const extras = rows.filter((row) => !defaults.some((entry) => entry.id === row.map_id));
    if (extras.length > 0) {
      console.warn(`  库里有 ${extras.length} 张图不在 MAP_DEFAULTS（${extras.map((row) => row.map_id).join(", ")}）—— 本脚本不管它们`);
    }

    if (diffs.length === 0) {
      console.log(`无需改动：${defaults.length} 张图的等级已与出厂值一致。`);
      return;
    }

    console.log(`等级要改 ${diffs.length} 行：`);
    for (const diff of diffs) {
      const tag = diff.type === "0" ? "安全" : "野外";
      console.log(`  图 ${diff.id.padStart(2)} ${diff.label}（${tag}）：${diff.from} → ${diff.to}`);
    }

    if (!apply) {
      console.log("\n干跑结束（没有写库）。确认无误后加 --apply 真写。");
      return;
    }

    const statement = db.prepare("UPDATE maps SET level = ?, updated_by = ?, updated_at = ? WHERE map_id = ?");
    const now = Date.now();
    db.exec("BEGIN");
    try {
      for (const diff of diffs) statement.run(diff.to, SOURCE, now, diff.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`\n已写入 ${diffs.length} 行（updated_by = ${SOURCE}）。下一步：make config-export 同步出厂快照。`);
  } finally {
    db.close();
  }
}

main();
