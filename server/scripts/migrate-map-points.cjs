#!/usr/bin/env node
/**
 * 一次性迁移：把 TMX 里的 NPC 点位与复活点灌进库（#672）
 *
 *   node server/scripts/migrate-map-points.cjs             # 读默认库，写 map_npcs + maps.revive_*
 *   node server/scripts/migrate-map-points.cjs --dry-run   # 只报告会写什么
 *   node server/scripts/migrate-map-points.cjs --db /tmp/x.db
 *
 * ## 为什么需要它
 *
 * #672 之前，NPC 点位与复活点写在客户端资源里（TMX 的 `npc` 对象组，`class=npc` + 属性 `id`
 * 关联 `npcs` 表），服务端一个字节都没有。搬到后台之后，**出厂值必须从哪儿来一次**——
 * 否则升级上来的库进游戏就一个 NPC 都没有、也没复活点。
 *
 * 数据源现成：`maps.content` 列本来就存着 TMX 的对象组（导入工具写的，Tiled 原始坐标），
 * 所以这个脚本**只读库、不碰 TMX 文件**。
 *
 * ## 幂等
 *
 * - NPC：`INSERT OR IGNORE`，靠 `(map_id, npc_id)` 唯一索引 —— 已经有的行不会被覆盖，
 *   运营在后台挪过的位置不会被「重跑一次迁移」拽回 TMX 的位置。
 * - 复活点：只写 `revive_cx IS NULL` 的图。同理，清空过的复活点不会被重新灌回来。
 *
 * ## 灌完就跟 TMX 没关系了
 *
 * `tools/import-map-resources.cjs` 重跑只会刷 `content` 列（资源对照），**不写** `map_npcs`、
 * 也不写 `revive_*` —— 所以「改 TMX → 重跑工具」不会悄悄改掉运营配好的点位。
 * 出厂值本身随 `make config-export` 进 `data/config-sync.sql`（`map_npcs` 在配置表白名单里）。
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

/** Tiled 对象类（与客户端 `tiledObjectClasses` 同口径；这里只认这两个） */
const KLASS_NPC = "npc";
const KLASS_REVIVE = "revive";
/** NPC 的编号属性名（Tiled 自定义属性，指向 `npcs.id`） */
const PROPERTY_NPC_ID = "id";

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", "dry-run": "dryRun" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT map_id, content, revive_cx, revive_cy FROM maps ORDER BY CAST(map_id AS INTEGER)").all();
    const plan = rows.map((row) => planOf(row));
    const npcTotal = plan.reduce((total, item) => total + item.npcs.length, 0);
    const reviveTotal = plan.filter((item) => item.revive).length;

    console.log(args.dryRun ? "dry run（不写库）" : "迁移地图点位（NPC / 复活点）");
    console.log(`  数据文件：${dbPath}`);
    console.log(`  地图 ${rows.length} 张 · 待写 NPC 点位 ${npcTotal} 个 · 待写复活点 ${reviveTotal} 个`);
    for (const item of plan) {
      if (item.npcs.length === 0 && !item.revive) continue;
      const npcs = item.npcs.map((npc) => `${npc.npcId}(${npc.cx}, ${npc.cy})`).join(" ");
      console.log(`  地图 ${item.mapId}：${npcs || "—"}${item.revive ? ` · 复活点 (${item.revive.cx}, ${item.revive.cy})` : ""}`);
    }
    if (args.dryRun) {
      console.log("  下一步：去掉 --dry-run 真写一次，然后 make config-export 把出厂值写进 config-sync.sql");
      return;
    }

    const insert = db.prepare(
      "INSERT OR IGNORE INTO map_npcs (map_id, npc_id, cx, cy, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const setRevive = db.prepare(
      "UPDATE maps SET revive_cx = ?, revive_cy = ? WHERE map_id = ? AND revive_cx IS NULL AND revive_cy IS NULL",
    );
    let inserted = 0;
    let revived = 0;
    db.exec("BEGIN");
    try {
      for (const item of plan) {
        for (const npc of item.npcs) {
          inserted += insert.run(item.mapId, npc.npcId, npc.cx, npc.cy, 0).changes;
        }
        if (item.revive) {
          revived += setRevive.run(item.revive.cx, item.revive.cy, item.mapId).changes;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log("");
    console.log(`  实际写入：NPC 点位 ${inserted} 行 · 复活点 ${revived} 张图`);
    if (inserted < npcTotal || revived < reviveTotal) {
      console.log(`  （差额是「已经有了」的行 —— 重复跑不会覆盖运营改过的位置）`);
    }
    console.log("  下一步：make config-export → 提交 server/data/config-sync.sql");
  } finally {
    db.close();
  }
}

/**
 * 一张图的迁移计划
 *
 * 坐标换算只有一条式子：世界 `cy = -tiled y`（#566 之后没有半图偏移）。`content` 里的
 * `x/y` 是 Tiled 口径（左上角、y 向下），所以 `cx = x`、`cy = -y`。
 */
function planOf(row) {
  const content = parseContent(row.content);
  const objects = content.groups.flatMap((group) => (Array.isArray(group.objects) ? group.objects : []));
  const npcs = [];
  let revive = null;
  for (const object of objects) {
    if (!object || typeof object.x !== "number" || typeof object.y !== "number") continue;
    // 复活点：只认 class=revive（早期地图用对象名标，同一个判据）
    if (object.klass === KLASS_REVIVE || object.name === KLASS_REVIVE) {
      if (!revive) revive = pointOf(object);
      continue;
    }
    if (object.klass !== KLASS_NPC) continue;
    const npcId = String((object.properties && object.properties[PROPERTY_NPC_ID]) || "").trim();
    // 没有 id 属性的 npc 对象是坏数据（客户端当年也只是打一条 warn 跳过），这里不猜
    if (!npcId) continue;
    npcs.push({ npcId, ...pointOf(object) });
  }
  // 已有 revive 值的图不排计划（幂等：运营改过的位置不能被重跑拽回 TMX）
  const hasRevive = row.revive_cx !== null || row.revive_cy !== null;
  return { mapId: row.map_id, npcs, revive: hasRevive ? null : revive };
}

/** Tiled 点 → 世界点（`cy` 为负） */
function pointOf(object) {
  return { cx: round2(object.x), cy: round2(-object.y) };
}

/** 内容列可能是空串 / 坏 JSON / 半截结构 —— 一律当「没有对象」处理，不中断整次迁移 */
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
