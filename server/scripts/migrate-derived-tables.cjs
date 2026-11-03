#!/usr/bin/env node
/**
 * 把「曲线算出来的派生数据」一次性展开成**表里的行**（#655）
 *
 *   node scripts/migrate-derived-tables.cjs            # 写库
 *   node scripts/migrate-derived-tables.cjs --dry      # 只算，打印统计不写
 *   node scripts/migrate-derived-tables.cjs --db data/x.db
 *
 * ===========================================================================
 * 这是一次性迁移工具，不是「日常重建脚本」
 * ===========================================================================
 * 以前这两组数据是**运行时现算**的（`growth-seed.sampleGrowth` 采曲线、
 * `runtime-overrides.rateOf` 乘前后缀倍率）。本次改造后它们变成普通的库表：
 *
 * - `role_levels`      60 行 = 每级的最终裸属性 + 升级经验（原 level_exps 合并进来）
 * - `equipment_variants` 555 行 = 37 基础件 × 5 前缀 × 3 后缀（属性 / 卖价 / 穿戴等级）
 *
 * 跑一次把旧值搬过去，之后**只由管理端逐行改**。想调平衡就改行，不要再引回曲线 ——
 * 那正是这次要拆掉的东西。所以本脚本是迁移工具：跑过之后不要再跑（它有 `INSERT OR IGNORE`
 * 幂等保护，重跑不会覆盖运营改过的值，但也不该成为流程的一环）。
 *
 * ## 取值口径：库优先、seed 兜底
 * - 升级经验：优先 `level_exps.exp`（运营可能已在管理端改过），没有行才用曲线推导值；
 * - 装备基础件：优先 `equipments` 表当前行（运营可能改过属性 / 等级 / 名称）；
 * - 前后缀倍率 / 文案 / 回收价曲线：优先 `equipment_meta` 当前行，缺行回落 seed。
 *
 * 这样「迁移」不会把运营已经调好的数值悄悄改回出厂值。
 */
"use strict";

const tooling = require("./lib/db-tooling.cjs");
const { DatabaseSync } = require("node:sqlite");

// 种子文件是 TS（与运行时共用同一份定义，不能复制成 JS —— 那就出现第二份出厂值）
require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs", target: "es2021" } });

const growth = require("../src/shared/growth-seed.ts");
const equipment = require("../src/shared/equipment-seed.ts");
const { expandEquipmentVariants } = require("../src/shared/equipment-variant-expand.ts");

/** 角色等级的八项属性列（顺序与 INSERT 一致；顺便当「新增属性时忘了加列」的编译期提醒） */
const ATTRIBUTE_COLUMNS = [
  "max_hp",
  "max_mp",
  "hp_recover",
  "physical_attack_min",
  "physical_attack_max",
  "magic_attack_min",
  "magic_attack_max",
  "taoist_attack_min",
  "taoist_attack_max",
  "physical_defense_min",
  "physical_defense_max",
  "magic_defense_min",
  "magic_defense_max",
  "taoist_defense_min",
  "taoist_defense_max",
];

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", dry: "dry" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });

  const db = new DatabaseSync(dbPath);
  try {
    assertTables(db);
    const roleStats = migrateRoleLevels(db, Boolean(args.dry));
    const equipStats = migrateEquipmentVariants(db, Boolean(args.dry));
    report(dbPath, roleStats, equipStats, Boolean(args.dry));
  } finally {
    db.close();
  }
}

/**
 * 新表必须已经存在（由服务端启动时的建表语句创建）
 *
 * 不在脚本里建表的理由：列定义只能有一份。脚本自己再写一遍 `CREATE TABLE`，
 * 将来加一列就会出现「启动建的」与「脚本建的」两个形状，而报错只会在某个 SQL 上。
 */
function assertTables(db) {
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  const missing = ["role_levels", "equipment_variants"].filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(
      `库里还没有这些表：${missing.join(", ")}\n` +
        "  先启动一次服务端（或跑 make dev-server）让建表语句执行，再回来跑本脚本。",
    );
  }
}

/** 角色等级：60 行 = 曲线的最终值 + 库里已有的升级经验 */
function migrateRoleLevels(db, dryRun) {
  const existingExps = new Map();
  for (const row of db.prepare("SELECT level, exp FROM level_exps").all()) {
    existingExps.set(Number(row.level), Number(row.exp));
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO role_levels
       (level, exp, ${ATTRIBUTE_COLUMNS.join(", ")}, updated_at)
     VALUES (?, ?, ${ATTRIBUTE_COLUMNS.map(() => "?").join(", ")}, 0)`,
  );

  let inserted = 0;
  let kept = 0;
  for (const [levelKey, attributes] of Object.entries(growth.ROLE_LEVEL_ATTRIBUTES)) {
    const level = Number(levelKey);
    // 属性区间是 [下限, 上限] 两列；其余是单值列 —— 展开时不要漏任何一项
    const values = [
      attributes.maxHp,
      attributes.maxMp,
      attributes.hpRecover,
      attributes.physicalAttack[0],
      attributes.physicalAttack[1],
      attributes.magicAttack[0],
      attributes.magicAttack[1],
      attributes.taoistAttack[0],
      attributes.taoistAttack[1],
      attributes.physicalDefense[0],
      attributes.physicalDefense[1],
      attributes.magicDefense[0],
      attributes.magicDefense[1],
      attributes.taoistDefense[0],
      attributes.taoistDefense[1],
    ];
    // 经验优先用库里那一行：运营在管理端改过 60 个等级的经验，迁移不能把它改回曲线值
    const exp = existingExps.get(level) ?? attributes.exp;
    if (dryRun) {
      inserted += 1;
      continue;
    }
    const result = insert.run(level, Math.max(1, Math.round(exp)), ...values);
    if (result.changes > 0) inserted += 1;
    else kept += 1;
  }
  return { inserted, kept, total: Object.keys(growth.ROLE_LEVEL_ATTRIBUTES).length };
}

/** 装备变体：37 基础件 × 15 前后缀 = 555 行，属性与卖价按基础件 × 倍率算 */
function migrateEquipmentVariants(db, dryRun) {
  const bases = db.prepare("SELECT * FROM equipments").all();
  if (bases.length === 0) {
    throw new Error("equipments 表是空的 —— 先让服务端跑一次启动 seed（或 make config-import）再迁移。");
  }

  const meta = db.prepare("SELECT * FROM equipment_meta WHERE id = 1").get();
  const prefixRates = readNumberArray(meta && meta.prefix_rates, equipment.EQUIPMENT_PREFIX_RATE_SEEDS);
  const suffixRates = readNumberArray(meta && meta.suffix_rates, equipment.EQUIPMENT_SUFFIX_RATE_SEEDS);
  const recycleCurve = readCurve(meta && meta.recycle_curve, equipment.EQUIPMENT_RECYCLE_CURVE_SEED);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO equipment_variants
       (id, base_id, prefix, suffix, label, level, sell_price, max_hp, hp_recover,
        physical_attack_min, physical_attack_max, magic_attack_min, magic_attack_max,
        taoist_attack_min, taoist_attack_max, physical_defense_min, physical_defense_max,
        magic_defense_min, magic_defense_max, taoist_defense_min, taoist_defense_max, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );

  let inserted = 0;
  let kept = 0;
  // 展开算法与建库 seed 共用同一个函数（`shared/equipment-variant-expand`）——
  // 两处各写一份的话，「迁移出来的 555 行」与「新库 seed 出来的 555 行」迟早不一致
  const expanded = expandEquipmentVariants(bases, prefixRates, suffixRates, recycleCurve);
  for (const variant of expanded) {
    if (dryRun) {
      inserted += 1;
      continue;
    }
    const result = insert.run(
      variant.id,
      variant.base_id,
      variant.prefix,
      variant.suffix,
      variant.label,
      variant.level,
      variant.sell_price,
      variant.max_hp,
      variant.hp_recover,
      variant.physical_attack_min,
      variant.physical_attack_max,
      variant.magic_attack_min,
      variant.magic_attack_max,
      variant.taoist_attack_min,
      variant.taoist_attack_max,
      variant.physical_defense_min,
      variant.physical_defense_max,
      variant.magic_defense_min,
      variant.magic_defense_max,
      variant.taoist_defense_min,
      variant.taoist_defense_max,
    );
    if (result.changes > 0) inserted += 1;
    else kept += 1;
  }
  return { inserted, kept, total: expanded.length };
}

function report(dbPath, roleStats, equipStats, dryRun) {
  const prefix = dryRun ? "[dry-run] 将写入" : "已写入";
  console.log(`${dryRun ? "试算完成（未写库）" : "派生数据迁移完成"}`);
  console.log(`  源文件：${dbPath}`);
  console.log(
    `  角色等级：${prefix} ${roleStats.inserted} 行 / 共 ${roleStats.total} 级` +
      (dryRun ? "" : `（已存在跳过 ${roleStats.kept} 行）`),
  );
  console.log(
    `  装备变体：${prefix} ${equipStats.inserted} 行 / 共 ${equipStats.total} 件` +
      (dryRun ? "" : `（已存在跳过 ${equipStats.kept} 行）`),
  );
  if (!dryRun) {
    console.log("  下一步：make config-export（把新表带进 config-sync.sql）→ 提交");
  }
}

/** JSON 列 → number[]；解析失败或为空回落出厂值 */
function readNumberArray(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const numbers = Array.isArray(parsed) ? parsed.map(Number).filter((value) => Number.isFinite(value)) : [];
    return numbers.length ? numbers : fallback;
  } catch {
    return fallback;
  }
}

/** JSON 列 → 曲线段；解析失败或为空回落出厂值 */
function readCurve(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
    return parsed
      .filter((segment) => segment && typeof segment === "object")
      .map((segment) => ({
        from: Number(segment.from) || 0,
        to: Number(segment.to) || 0,
        start: Number(segment.start) || 0,
        perLevel: Number(segment.perLevel) || 0,
      }));
  } catch {
    return fallback;
  }
}

/** 与 equipment-seed.sampleEquipmentCurve 同一口径（超出末段按末段斜率外推） */
function sampleCurve(segments, level) {
  if (!segments.length) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

main();
