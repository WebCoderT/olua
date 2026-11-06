#!/usr/bin/env node
/**
 * 一次性脚本：把数据库与快照里的资源路径迁到新目录口径（#753）
 *
 * 与 `oneoff-migrate-resources.cjs`（磁盘搬迁）配套：磁盘改了名，**库里的路径字符串
 * 不会自己跟着变**。库里带资源路径的字段就那么 19 个（见 PATH_COLUMNS），
 * 另外 `equipment_appearance` 的 6 个 JSON 列里存的是**资源 key**（border-30123 / bg-16000），
 * `ui_effects.effect_key` 存的是光柱 key（light-1…light-6）。
 *
 * 两处一起改：
 *   1. `server/data/olua.db`（运行时真身，改前先 checkpoint WAL）；
 *   2. `server/data/config-sync.sql`（库的投影，随库提交，管理端与 e2e 读它）。
 * 两边用**同一套正则**，所以不会出现「库改了、快照没改」的半截状态。
 *
 * 用法：
 *   node tools/oneoff-migrate-resource-paths.cjs --db server/data/olua.db --sql server/data/config-sync.sql [--apply]
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const readArg = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? path.resolve(ROOT, args[index + 1]) : path.resolve(ROOT, fallback);
};
const DB_PATH = readArg("--db", "server/data/olua.db");
const SQL_PATH = readArg("--sql", "server/data/config-sync.sql");

/** 库里存资源路径的列（表.列）—— 来自 `select ... glob 'monster/*'` 之类的全库扫描 */
const PATH_COLUMNS = [
  ["titles", "animation"],
  ["souls", "animation"],
  ["equipments", "icon"],
  ["equipments", "in_atlas"],
  ["equipments", "out_atlas"],
  ["drugs", "icon"],
  ["items", "icon"],
  ["npcs", "src"],
  ["fashions", "icon"],
  ["fashions", "in_res"],
  ["fashions", "out_res"],
  ["skills", "icon"],
  ["skills", "effect"],
  ["statuses", "icon"],
  ["statuses", "effect"],
  ["equipment_slots", "image_src"],
  ["monster_presentation", "icon"],
  ["monster_presentation", "out"],
  ["audio_settings", "file_path"],
];

/** equipment_appearance 的 6 个 JSON 列（存的是 key，不是路径） */
const APPEARANCE_COLUMNS = ["borders", "backgrounds", "custom_borders", "custom_backgrounds", "border_items", "background_items"];

/** 药品图标：拼音缩写 → 药剂 id（与 drugs.id 对齐，空格换连字符） */
const DRUG_ICONS = {
  "item/jcy_1": "item/drug-hp-1",
  "item/jcy_2": "item/drug-hp-2",
  "item/jcy_3": "item/drug-hp-3",
  "item/jcy_4": "item/drug-hp-4",
  "item/jcy_5": "item/drug-hp-5",
  "item/mfy_1": "item/drug-mp-1",
  "item/mfy_2": "item/drug-mp-2",
  "item/mfy_3": "item/drug-mp-3",
  "item/tys": "item/drug-sun",
  "item/qxxy": "item/drug-hp-pct",
  "item/qxly": "item/drug-mp-pct",
};

/** 路径映射（顺序有意义：长前缀先命中） */
function mapPath(value) {
  if (typeof value !== "string" || !value) return value;
  const exact = DRUG_ICONS[value];
  if (exact) return exact;
  let out = value;
  out = out.replace(/^monster\/icon\/(\d+)_00000$/, "monster/icon/$1");
  out = out.replace(/^clothes\//, "equipment/clothes/");
  out = out.replace(/^weapons\//, "equipment/weapons/");
  out = out.replace(/^npc\/npc_(\d+)$/, "npc/$1");
  out = out.replace(/^titles\/sfx_(\d+)$/, "title/$1");
  out = out.replace(/^war-soul\/sfx_(\d+)$/, "soul/$1");
  out = out.replace(/^effect\/skill\/s_(\d+@\d+)$/, "effect/skill/$1");
  out = out.replace(/^effect\/status\/s_(\d+@\d+)$/, "effect/status/$1");
  out = out.replace(/^effect\/selected\/select_monster@0$/, "effect/select/monster@0");
  out = out.replace(/^slots\/(.+)$/, "ui/slot/$1");
  out = out.replace(/^sounds\/(.+)\.(wav|mp3)$/, (_, base, ext) => `audio/${base.replace(/_/g, "-")}.${ext}`);
  return out;
}

/** key 映射（border-N / bg-N / light-N） */
function mapKeyText(text) {
  return text
    .replace(/sfx_(\d+)_0/g, "border-$1")
    .replace(/sfx_(\d+)/g, "bg-$1");
}

const stats = new Map();
const bump = (label) => stats.set(label, (stats.get(label) ?? 0) + 1);

// ---------- 1. 数据库 ----------

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

const changes = [];
for (const [table, column] of PATH_COLUMNS) {
  const rows = db.prepare(`SELECT rowid AS rid, "${column}" AS value FROM "${table}"`).all();
  for (const row of rows) {
    const next = mapPath(row.value);
    if (next === row.value) continue;
    changes.push({ table, column, rid: row.rid, from: row.value, to: next });
    bump(`${table}.${column}`);
  }
}

for (const column of APPEARANCE_COLUMNS) {
  const rows = db.prepare(`SELECT id, "${column}" AS value FROM equipment_appearance`).all();
  for (const row of rows) {
    if (typeof row.value !== "string" || !row.value) continue;
    const next = mapKeyText(row.value);
    if (next === row.value) continue;
    changes.push({ table: "equipment_appearance", column, rid: row.id, from: "(json)", to: "(json)" });
    bump(`equipment_appearance.${column}`);
  }
}

{
  const rows = db.prepare(`SELECT rowid AS rid, effect_key AS value FROM ui_effects`).all();
  for (const row of rows) {
    const next = String(row.value ?? "").replace(/^light_(\d+)$/, "light-$1");
    if (next === row.value) continue;
    changes.push({ table: "ui_effects", column: "effect_key", rid: row.rid, from: row.value, to: next });
    bump("ui_effects.effect_key");
  }
}

console.log(`数据库：${DB_PATH}`);
console.log(`  待更新 ${changes.length} 处`);
for (const [label, count] of [...stats.entries()].sort()) console.log(`    ${label}: ${count}`);

// ---------- 2. 快照 SQL ----------

const sqlText = fs.readFileSync(SQL_PATH, "utf8");
/** 对 SQL 文本做同样的替换（只在引号内出现的路径 / key，锚定在引号或 JSON 引号上） */
function migrateSql(text) {
  let out = text;
  out = out.replace(/(['"])monster\/icon\/(\d+)_00000\1/g, "$1monster/icon/$2$1");
  out = out.replace(/(['"])clothes\//g, "$1equipment/clothes/");
  out = out.replace(/(['"])weapons\//g, "$1equipment/weapons/");
  out = out.replace(/(['"])npc\/npc_(\d+)\1/g, "$1npc/$2$1");
  out = out.replace(/(['"])titles\/sfx_(\d+)\1/g, "$1title/$2$1");
  out = out.replace(/(['"])war-soul\/sfx_(\d+)\1/g, "$1soul/$2$1");
  out = out.replace(/(['"])effect\/skill\/s_(\d+@\d+)\1/g, "$1effect/skill/$2$1");
  out = out.replace(/(['"])effect\/status\/s_(\d+@\d+)\1/g, "$1effect/status/$2$1");
  out = out.replace(/(['"])effect\/selected\/select_monster@0\1/g, "$1effect/select/monster@0$1");
  out = out.replace(/(['"])slots\//g, "$1ui/slot/");
  out = out.replace(/(['"])sounds\/([a-z0-9_]+)\.(wav|mp3)\1/g, (_, q, base, ext) => `${q}audio/${base.replace(/_/g, "-")}.${ext}${q}`);
  for (const [from, to] of Object.entries(DRUG_ICONS)) {
    out = out.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);
  }
  // 外观 key（JSON 列里的 "key":"sfx_30123_0"）与光柱 key
  out = out.replace(/"(sfx_\d+_0)"/g, (_, key) => `"${key.replace(/sfx_(\d+)_0/, "border-$1")}"`);
  out = out.replace(/"sfx_(\d+)"/g, '"bg-$1"');
  out = out.replace(/'light_(\d+)'/g, "'light-$1'");
  return out;
}

const nextSql = migrateSql(sqlText);
const sqlChangedLines = sqlText.split("\n").filter((line, index) => line !== nextSql.split("\n")[index]).length;
console.log(`快照：${SQL_PATH}`);
console.log(`  变更行数 ${sqlChangedLines}/{sqlText.split("\n").length}`);

if (!apply) {
  console.log("\n差异样例：");
  for (const item of changes.slice(0, 8)) console.log(`  ${item.table}.${item.column}#${item.rid}: ${item.from} → ${item.to}`);
  console.log("\n干跑结束（未落盘）。加 --apply 执行。");
  process.exit(0);
}

// ---------- 3. 落盘 ----------

const update = new Map();
for (const item of changes) {
  if (item.from === "(json)") continue;
  const key = `${item.table}|${item.column}`;
  if (!update.has(key)) update.set(key, db.prepare(`UPDATE "${item.table}" SET "${item.column}" = ? WHERE rowid = ?`));
  update.get(key).run(item.to, item.rid);
}

// JSON 列整段重算出新值（key 替换不改变结构，只换字面量）
for (const item of changes.filter((entry) => entry.from === "(json)")) {
  const current = db.prepare(`SELECT "${item.column}" AS value FROM equipment_appearance WHERE id = ?`).get(item.rid).value;
  db.prepare(`UPDATE equipment_appearance SET "${item.column}" = ? WHERE id = ?`).run(mapKeyText(current), item.rid);
}

fs.writeFileSync(SQL_PATH, nextSql, "utf8");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`\n✔ 已写库 ${changes.length} 处、已更新快照`);
