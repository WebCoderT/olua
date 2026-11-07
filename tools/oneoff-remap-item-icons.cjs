#!/usr/bin/env node
/**
 * 一次性脚本：把 `item/` 根目录搬走的图标在**库里**的引用一并改到新位置（#777）
 *
 * 与 `oneoff-regroup-item-assets.cjs`（磁盘搬迁）配套。磁盘搬完，库里的路径字符串
 * 不会自己跟着变 —— 不改的话装备格、材料格、药品格全是空白，而且没有任何报错
 * （`resources.load` 的失败只是一条 console.error）。
 *
 * 两处一起改，用同一套映射，避免「库改了、快照没改」的半截状态：
 *   1. `server/data/olua.db`（运行时真身）
 *   2. `server/data/config-sync.sql`（库的投影，随库提交，e2e 与别人 pull 后都吃它）
 *
 * 映射只有两条规则：
 *   - `item/<9 个装备编号>` → `equipment/<部位>/<编号>`（与磁盘搬迁表同源）
 *   - `item/drug-` → `item/consumable/drugs/drug-`
 *
 * 用法：
 *   node tools/oneoff-remap-item-icons.cjs            # 干跑：列出会改的单元格
 *   node tools/oneoff-remap-item-icons.cjs --apply
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const apply = process.argv.includes("--apply");
const DB_PATH = path.join(ROOT, "server", "data", "olua.db");
const SQL_PATH = path.join(ROOT, "server", "data", "config-sync.sql");

/**
 * 与磁盘搬迁表**同源**：编号 → equipment 下的部位目录（第 5 位类型位，逐个看图确认）
 *
 * 比搬迁表多一条 `2030410 → shoes`：那张图在 #777 之前就已经被手动放进了
 * `equipment/shoes/`，磁盘不用搬，但**库里还有 `item/2030410` 的引用**
 * （新手鞋子 + 材料「粗布」），不改就是一条指向不存在文件的死链。
 */
const EQUIPMENT_ICONS = {
  2010210: "rings",
  2020210: "rings",
  2030210: "rings",
  2010310: "necklaces",
  2020310: "necklaces",
  2030310: "necklaces",
  2030410: "shoes",
  2030610: "wristbands",
  2030702: "helmets",
  2030810: "belts",
};

/** 带资源路径的列（#753 的 PATH_COLUMNS 里与 item 相关的三处；其余表不引用 item/） */
const PATH_COLUMNS = [
  ["equipments", "icon"],
  ["items", "icon"],
  ["drugs", "icon"],
];

/** 单条路径的映射（不是 item/ 开头的原样返回） */
function remap(value) {
  if (typeof value !== "string" || !value.startsWith("item/")) return value;
  if (value.startsWith("item/drug-")) return value.replace("item/", "item/consumable/drugs/");
  const serial = value.slice("item/".length);
  const dir = EQUIPMENT_ICONS[serial];
  return dir ? `equipment/${dir}/${serial}` : value;
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: !apply });
  const changes = [];
  for (const [table, column] of PATH_COLUMNS) {
    const rows = db.prepare(`SELECT id, ${column} AS value FROM ${table}`).all();
    for (const row of rows) {
      const next = remap(row.value);
      if (next === row.value) continue;
      changes.push({ table, column, id: row.id, from: row.value, to: next });
    }
  }

  console.log(`计划改 ${changes.length} 个单元格：`);
  for (const c of changes) console.log(`  ${c.table}.${c.column} [${c.id}] ${c.from} → ${c.to}`);
  if (changes.length === 0) return;
  if (!apply) {
    console.log("\n干跑结束。加 --apply 落盘（库 + config-sync.sql 一起改）。");
    return;
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("BEGIN");
  try {
    for (const c of changes) {
      db.prepare(`UPDATE ${c.table} SET ${c.column} = ? WHERE id = ?`).run(c.to, c.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.close();

  // 快照：逐行替换（整条 INSERT 语句里出现即换，两个前缀互不重叠，顺序无所谓）
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  let out = sql;
  for (const c of changes) out = out.split(c.from).join(c.to);
  fs.writeFileSync(SQL_PATH, out);
  console.log(`\n完成：库 ${changes.length} 处，config-sync.sql 同步替换。`);
}

main();
