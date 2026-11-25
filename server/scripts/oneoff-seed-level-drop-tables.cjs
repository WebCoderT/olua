#!/usr/bin/env node
/**
 * 一次性补数据：全等级区间掉落表 + 全怪接线（#1277）
 *
 *   cd server && node scripts/oneoff-seed-level-drop-tables.cjs              # 干跑：只打印要写什么
 *   cd server && node scripts/oneoff-seed-level-drop-tables.cjs --apply      # 真写库
 *   node scripts/oneoff-seed-level-drop-tables.cjs --db /path/to/olua.db     # 换一个库（默认 DB_PATH / data/olua.db）
 *
 * 部署机上：
 *   docker exec olua-server node scripts/oneoff-seed-level-drop-tables.cjs --apply
 *
 * ## 这刀写什么
 *
 * 用户 2026-11-26 新增 `elite_1_10` 掉落表（picks [10,10]，先配了 cloth_1 一条并接到怪物 1），
 * 拍板按这个模式把**所有武器衣服按等级区间**放进掉落表，**包括其他所有物品**：
 *
 * - 7 张表（每 10 级一档）：elite_1_10 / elite_11_20 / elite_21_30 / elite_31_40 /
 *   elite_41_50 / elite_51_60 / elite_61_70（怪物最高 69 级，最后一档兜高段）；
 * - 每张表内容：该档装备（equipments.level ∈ 档）+ 该档药品（drugs.level）+ 该档材料
 *   （items.level）；货币（money_items）与升级卷轴（level_scrolls）没有 level 字段，
 *   **每张表全放**（用户 2026-11-26 拍板）；
 * - 全平铺：weight=1、chance=1、count=[1,1]，掉什么全靠 picks 随机；
 * - picks 全部 [10,10]（跟 elite_1_10）；
 * - 220 只怪 monster_drops 全部改为 source='table'、绑到各自等级对应区间的表，
 *   现有行内 entries 被替换；bind_drops 原样保留。
 *
 * ## 幂等
 *
 * 表内容按库里的 goods **重算**（不是补缺）：算出的 entries 与库值逐字节一致就不写，
 * 重跑零 diff。装备 / 药品 / 材料后续在管理端加新货，重跑本脚本会自动进表。
 *
 * ## 快照可见性
 *
 * `--apply` 成功后 `config_version` +1（同 oneoff-seed-monster-speed-rates 口径）。
 *
 * ## 不碰什么
 *
 * monsters / monster_presentation / 出厂四张表（common / elite / boss / default）等
 * 其余内容一概不动；monster_drops 的 bind_drops 列原样保留。
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const { resolveDbPath } = require("./lib/db-tooling.cjs");

/** 等级档（每 10 级一档，#1277 拍板） */
const BANDS = [
  [1, 10],
  [11, 20],
  [21, 30],
  [31, 40],
  [41, 50],
  [51, 60],
  [61, 70],
];

/** 表 id：elite_<min>_<max>（跟用户手建的 elite_1_10 同名式） */
const tableIdOf = ([min, max]) => `elite_${min}_${max}`;

/** level → 档下标（超过最后一档并入最后一档，不外溢） */
function bandIndexOf(level) {
  const i = Math.min(BANDS.length - 1, Math.floor((Math.max(1, level) - 1) / 10));
  return i;
}

/** 条目（全平铺：weight=1、chance=1、count=[1,1]） */
const entryOf = (goodId) => ({ goodId, weight: 1, chance: 1, count: [1, 1] });

function main() {
  const apply = process.argv.includes("--apply");
  const dbIndex = process.argv.indexOf("--db");
  const dbPath = resolveDbPath(dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined);
  const db = new DatabaseSync(dbPath);

  try {
    const now = Date.now();

    // ---- 从库里的 goods 重算 7 张表的 entries ----
    const equipments = db.prepare("SELECT id, level FROM equipments").all();
    const drugs = db.prepare("SELECT id, level FROM drugs").all();
    const materials = db.prepare("SELECT id, level FROM items").all();
    const money = db.prepare("SELECT id FROM money_items ORDER BY id").all();
    const scrolls = db.prepare("SELECT id FROM level_scrolls ORDER BY id").all();

    const byBand = BANDS.map(() => ({ equip: [], drug: [], item: [] }));
    for (const row of equipments) byBand[bandIndexOf(row.level)].equip.push(row.id);
    for (const row of drugs) byBand[bandIndexOf(row.level)].drug.push(row.id);
    for (const row of materials) byBand[bandIndexOf(row.level)].item.push(row.id);
    for (const band of byBand) {
      band.equip.sort((a, b) => a.localeCompare(b, "en"));
      band.drug.sort((a, b) => a.localeCompare(b, "en"));
      band.item.sort((a, b) => a.localeCompare(b, "en"));
    }

    const entriesOf = (i) =>
      JSON.stringify([
        ...byBand[i].equip.map(entryOf),
        ...byBand[i].drug.map(entryOf),
        ...byBand[i].item.map(entryOf),
        ...money.map((row) => entryOf(row.id)),
        ...scrolls.map((row) => entryOf(row.id)),
      ]);

    // ---- drop_tables：重算 7 张，逐字节一致就不写 ----
    const tableDiffs = [];
    const existingTables = new Map(
      db.prepare("SELECT id, picks, entries FROM drop_tables").all().map((row) => [row.id, row]),
    );
    for (let i = 0; i < BANDS.length; i++) {
      const id = tableIdOf(BANDS[i]);
      const entries = entriesOf(i);
      const current = existingTables.get(id);
      if (!current) tableDiffs.push({ id, kind: "insert", entries });
      else if (current.picks !== "[10,10]" || current.entries !== entries)
        tableDiffs.push({ id, kind: "update", entries });
    }

    console.log(`等级档 × 表内容（装备 / 药品 / 材料 + 货币 ${money.length} + 卷轴 ${scrolls.length} 全放）：`);
    for (let i = 0; i < BANDS.length; i++) {
      const b = byBand[i];
      const total = b.equip.length + b.drug.length + b.item.length + money.length + scrolls.length;
      console.log(
        `  ${tableIdOf(BANDS[i])}: 装备 ${b.equip.length} + 药品 ${b.drug.length} + 材料 ${b.item.length} + 货币 ${money.length} + 卷轴 ${scrolls.length} = ${total} 条`,
      );
    }
    console.log(
      `drop_tables：待写 ${tableDiffs.length} 行（${tableDiffs.map((d) => `${d.id}(${d.kind})`).join(", ") || "无"}）`,
    );

    // ---- monster_drops：220 只怪按等级全接 source='table' ----
    const monsters = db.prepare("SELECT id, level FROM monsters").all();
    const monsterBand = new Map(monsters.map((m) => [m.id, tableIdOf(BANDS[bandIndexOf(m.level)])]));
    const dropRows = db.prepare("SELECT monster_key, source, table_id, picks, entries, bind_drops FROM monster_drops").all();
    const dropDiffs = [];
    for (const row of dropRows) {
      const tableId = monsterBand.get(row.monster_key);
      if (!tableId) {
        console.warn(`  monster_drops.monster_key=${row.monster_key} 在 monsters 表里没有对应行，跳过`);
        continue;
      }
      if (row.source !== "table" || row.table_id !== tableId || row.picks !== "[10,10]" || row.entries !== null) {
        dropDiffs.push({
          key: row.monster_key,
          before: `${row.source}/${row.table_id ?? "-"}/${row.picks ?? "-"}`,
          after: `table/${tableId}/[10,10]`,
        });
      }
    }
    const bandCount = {};
    for (const tableId of monsterBand.values()) bandCount[tableId] = (bandCount[tableId] || 0) + 1;
    console.log(
      `monster_drops：共 ${dropRows.length} 行，待改 ${dropDiffs.length} 行（各档接线：${Object.keys(bandCount)
        .sort()
        .map((id) => `${id}×${bandCount[id]}`)
        .join(", ")}）`,
    );
    for (const diff of dropDiffs.slice(0, 10)) console.log(`  怪 ${diff.key}: ${diff.before} → ${diff.after}`);
    if (dropDiffs.length > 10) console.log(`  …（其余 ${dropDiffs.length - 10} 行同理）`);

    if (tableDiffs.length === 0 && dropDiffs.length === 0) {
      console.log("没有缺口，无需写库。");
      return;
    }
    if (!apply) {
      console.log(`\n干跑结束。加 --apply 真写库（写完自动 config_version +1）。`);
      return;
    }

    // ---- 真写：单事务，坏一半就整体回滚 ----
    const upsertTable = db.prepare(
      "INSERT INTO drop_tables (id, picks, entries, updated_at) VALUES (?, '[10,10]', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET picks = '[10,10]', entries = excluded.entries, updated_at = excluded.updated_at",
    );
    const updateDrop = db.prepare(
      "UPDATE monster_drops SET source = 'table', table_id = ?, picks = '[10,10]', entries = NULL WHERE monster_key = ?",
    );
    db.exec("BEGIN");
    try {
      for (const diff of tableDiffs) upsertTable.run(diff.id, diff.entries, now);
      for (const diff of dropDiffs) updateDrop.run(diff.after.split("/")[1], diff.key);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    console.log(`\n已写入：drop_tables ${tableDiffs.length} 行、monster_drops ${dropDiffs.length} 行。`);

    // 推配置版本（直接改库绕过管理端写接口的版本拦截器）
    db.exec("INSERT OR IGNORE INTO config_version (id, version, updated_at, updated_by) VALUES (1, 0, 0, '')");
    const version = db
      .prepare("UPDATE config_version SET version = version + 1, updated_at = ?, updated_by = 'oneoff-level-drop-tables' WHERE id = 1 RETURNING version")
      .get(now).version;
    console.log(`config_version → ${version}（运行中的服务端会在下一次客户端请求时重建快照，无需重启）。`);

    console.log("下一步：node scripts/sync-config-sql-sections.cjs --tables drop_tables,monster_drops 把两段同步进 config-sync.sql。");
  } finally {
    db.close();
  }
}

main();
