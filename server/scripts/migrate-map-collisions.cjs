#!/usr/bin/env node
/**
 * 一次性迁移：把 TMX 里的碰撞矩形灌进 `map_collisions`（#676）
 *
 *   node server/scripts/migrate-map-collisions.cjs             # 读默认库，写 map_collisions
 *   node server/scripts/migrate-map-collisions.cjs --dry-run   # 只报告会写什么
 *   node server/scripts/migrate-map-collisions.cjs --db /tmp/x.db
 *
 * ## 为什么需要它
 *
 * #676 之前，碰撞盒只活在客户端资源的 TMX `collision` 对象组里（客户端两处读：生成静态碰撞体、
 * 自动战斗的静态障碍），服务端一个字节都没有。搬到后台之后，**出厂值必须从哪儿来一次** ——
 * 否则升级上来的库每张图都没有围墙，玩家能直接走出地图。
 *
 * 数据源现成：`maps.content` 列本来就存着 TMX 的对象组（导入工具写的，Tiled 原始坐标），
 * 所以这个脚本**只读库、不碰 TMX 文件**。顺序很重要：
 *
 *   1. 先跑本脚本（content 里还有 collision 组）
 *   2. 再 `node tools/strip-map-objects.cjs` 把 TMX 里的对象组整组删掉
 *   3. `node tools/import-map-resources.cjs` 让 content 变成「只剩图层」
 *   4. `make config-export` 把出厂值写进 `server/data/config-sync.sql`
 *
 * 先删 TMX 再迁移也不是不行 —— 但 content 得先刷过一遍才准，多一步就多一个搞错的机会。
 *
 * ## 幂等
 *
 * 判据是「**这张图有没有搬过**」而不是某个唯一键：碰撞盒没有天然唯一键（两个位置尺寸
 * 完全一样的盒子在原数据里是可能存在的），`INSERT OR IGNORE` 会每次重跑都插一份重复。
 * 表里这张图已经有行 → 跳过。运营之后手动删掉几个不会被重跑灌回来。
 *
 * 代价：把一张图的碰撞盒**全部**删光后重跑，那些盒子会回来。可接受 —— 它们与 TMX 原始数据一致。
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", "dry-run": "dryRun" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  const db = new DatabaseSync(dbPath);
  try {
    // 表由服务端启动时建（`database.service.ts` 的 createAll）。脚本不自带 DDL：
    // 建表语句只能有一处，否则「库里结构与代码不一致」这类问题会从工具里长出来。
    if (!hasTable(db, "map_collisions")) {
      console.error("库里没有 map_collisions 表 —— 先用新版本服务端启动一次（它会建表），再跑本脚本。");
      process.exitCode = 1;
      return;
    }
    const rows = db.prepare("SELECT map_id, content FROM maps ORDER BY CAST(map_id AS INTEGER)").all();
    const existing = new Set(
      db
        .prepare("SELECT map_id, COUNT(1) AS total FROM map_collisions GROUP BY map_id")
        .all()
        .filter((row) => Number(row.total) > 0)
        .map((row) => row.map_id),
    );

    const plan = rows.map((row) => ({ mapId: row.map_id, boxes: existing.has(row.map_id) ? [] : boxesOf(row.content) }));
    const total = plan.reduce((sum, item) => sum + item.boxes.length, 0);
    const skipped = rows.filter((row) => existing.has(row.map_id)).length;

    console.log(args.dryRun ? "dry run（不写库）" : "迁移地图碰撞盒");
    console.log(`  数据文件：${dbPath}`);
    console.log(`  地图 ${rows.length} 张 · 待写碰撞盒 ${total} 个${skipped > 0 ? ` · 已有数据跳过 ${skipped} 张` : ""}`);
    for (const item of plan) {
      if (item.boxes.length === 0) continue;
      // 只报「几个 + 头三个」，一张图两百个盒子全打出来没人看
      const sample = item.boxes.slice(0, 3).map((box) => `${box.w}×${box.h}@(${box.cx}, ${box.cy})`).join(" ");
      console.log(`  地图 ${item.mapId}：${item.boxes.length} 个 · ${sample}${item.boxes.length > 3 ? " …" : ""}`);
    }

    if (args.dryRun) {
      console.log("  下一步：去掉 --dry-run 真写一次，再删 TMX 里的对象组（tools/strip-map-objects.cjs）");
      return;
    }

    const insert = db.prepare(
      "INSERT INTO map_collisions (map_id, cx, cy, w, h, updated_at) VALUES (?, ?, ?, ?, ?, 0)",
    );
    let inserted = 0;
    db.exec("BEGIN");
    try {
      for (const item of plan) {
        for (const box of item.boxes) {
          inserted += insert.run(item.mapId, box.cx, box.cy, box.w, box.h).changes;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log("");
    console.log(`  实际写入：碰撞盒 ${inserted} 行`);
    console.log("  下一步：node tools/strip-map-objects.cjs → node tools/import-map-resources.cjs → make config-export");
  } finally {
    db.close();
  }
}

/** 表在不在（`sqlite_master` 是唯一可信的判据，别用 try/catch 兜） */
function hasTable(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * 一张图 content 里的碰撞矩形
 *
 * 坐标换算只有一条式子：世界 `cy = -(tiled y + h/2)`（中心），`cx = x + w/2`。
 * 只认 `collision` 组，并且跳过没有面积的元素（点 / 多边形构不成阻挡，客户端当年也跳过）。
 */
function boxesOf(text) {
  const content = parseContent(text);
  const group = content.groups.find((item) => item && item.name === "collision");
  if (!group || !Array.isArray(group.objects)) return [];
  const boxes = [];
  for (const object of group.objects) {
    if (!object || typeof object.x !== "number" || typeof object.y !== "number") continue;
    const w = Number(object.width) || 0;
    const h = Number(object.height) || 0;
    if (w <= 0 || h <= 0) continue;
    boxes.push({ cx: round2(object.x + w / 2), cy: round2(-(object.y + h / 2)), w: round2(w), h: round2(h) });
  }
  return boxes;
}

/** 内容列可能是空串 / 坏 JSON / 半截结构 —— 一律当「没有对象组」处理，不中断整次迁移 */
function parseContent(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return { groups: Array.isArray(parsed.groups) ? parsed.groups : [] };
  } catch {
    return { groups: [] };
  }
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

main();
