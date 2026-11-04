#!/usr/bin/env node
/**
 * 配置快照导出 / 导入测试（`scripts/lib/config-sql.cjs`）
 *
 * 这套测试**不起服务**：配置同步是两个脚本加一份 SQL 文件的事，跑起来只会把
 * 「脚本写错了」和「服务起不来」混在一起。
 *
 * ## 为什么用「小规模表集」
 *
 * 生产路径走全量 31 张配置表，但测试只建 3 张（drugs / items / monsters）+ 1 张运行时表
 * （accounts）。理由是测试要验的是**序列化与替换语义**（值转义、整表替换、校验拒绝），
 * 不是「这 31 张表名对不对」—— 后者用静态检查直接比对源码，比建 52 张表更准也更快。
 *
 * 注入表集的那个参数（`{ tables }`）只给测试用，生产脚本不传。
 *
 * ## 覆盖的行为
 *
 * 1. 分类守点：未归类的表 / 缺配置表 → 拒绝（并且**建表清单与分类清单静态一致**）
 * 2. 导出内容：含配置表、不含运行时表、值转义（单引号 / 换行 / NULL）
 * 3. 往返：生成 → 灌进另一个库 → 逐字节等价
 * 4. **改值与删行能同步过去**（这是整套东西存在的理由）
 * 5. 导入校验：格式标记 / 表清单 / DELETE 段 / 运行时表混入 → 全部拒绝
 * 6. `compare` 能指出「哪张表落后了」
 *
 * 用法：npm run test:config-sync
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const configSql = require(path.join(SERVER_DIR, "scripts", "lib", "config-sql.cjs"));
const { CONFIG_TABLES, RUNTIME_TABLES, assertAllClassified } = require(path.join(
  SERVER_DIR,
  "scripts",
  "lib",
  "config-tables.cjs",
));

/** 测试用的配置表（故意只取三张：两张纯字符串、一张带数字） */
const TEST_TABLES = ["drugs", "items", "monsters"];

/** 测试用的运行时表（用来验证「绝不进文件」） */
const TEST_RUNTIME = ["accounts"];

//#region 断言小工具

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

/** 断言某段代码会抛错，并且错误信息里带关键词（防止「抛了别的错也算过」） */
function checkThrows(fn, keyword, label) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check(
      message.includes(keyword),
      `${label}（错误信息应包含 ${JSON.stringify(keyword)}，实际 ${JSON.stringify(message.slice(0, 120))}）`,
    );
  }
  return check(false, `${label}（期望抛错，实际没抛）`);
}

//#endregion

//#region 测试库

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "olua-config-sync-"));

/** 建一个只含测试表集的库 */
function createDb(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE drugs (
        id      TEXT PRIMARY KEY,
        label   TEXT NOT NULL,
        hp      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE items (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        sell_price  INTEGER NOT NULL DEFAULT 0,
        description TEXT
      );
      CREATE TABLE monsters (
        id    TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE accounts (
        id       TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
  return file;
}

/** 执行一段 SQL */
function exec(file, sql) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** 读一个标量 */
function scalar(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

/** 建一个带出厂数据的库（source 用） */
function seedSource() {
  const file = createDb(path.join(TEMP_DIR, "source.db"));
  exec(
    file,
    `
    INSERT INTO accounts VALUES ('acc_1', 'player', 'scrypt$hash$value');
    INSERT INTO drugs    VALUES ('drug_hp_1', '金创药（小）', 60);
    INSERT INTO items    VALUES ('item_iron', '铁矿', 12, '锻造用的基础材料');
    INSERT INTO items    VALUES ('item_gem', '宝石', 500, NULL);
    INSERT INTO items    VALUES ('item_quote', 'O''Brien 的剑', 88, '第一行
第二行');
    INSERT INTO monsters VALUES ('m_1', '鸡', 1);
    INSERT INTO monsters VALUES ('m_2', '鹿', 3);
  `,
  );
  return file;
}

//#endregion

//#region 一 · 分类守点

group("一 · 分类守点（新表忘了归类要当场报错）");

checkThrows(
  () => assertAllClassified([...TEST_TABLES, "some_new_table"], { config: TEST_TABLES, runtime: TEST_RUNTIME }),
  "还没归类",
  "未归类的表被拒绝",
);

checkThrows(
  () => assertAllClassified(["drugs", "items"], { config: TEST_TABLES, runtime: TEST_RUNTIME }),
  "缺少这些配置表",
  "缺配置表被拒绝",
);

const classified = assertAllClassified([...TEST_TABLES, ...TEST_RUNTIME], {
  config: TEST_TABLES,
  runtime: TEST_RUNTIME,
});
checkEqual(classified.config.length, 3, "分类通过时返回 3 张配置表");
checkEqual(classified.runtime.length, 1, "分类通过时返回 1 张运行时表");

// 静态检查：database.service.ts 建的每张表都必须在两个清单之一（不依赖真库，CI 也跑）
const databaseSource = fs.readFileSync(path.join(SERVER_DIR, "src", "database", "database.service.ts"), "utf8");
const declaredTables = [...databaseSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((match) => match[1]);
const knownTables = new Set([...CONFIG_TABLES, ...RUNTIME_TABLES]);
const unclassifiedInSource = declaredTables.filter((name) => !knownTables.has(name));
check(
  declaredTables.length >= 50,
  `从 database.service.ts 里读到了建表清单（${declaredTables.length} 张；少于 50 说明正则失效，这条会假绿）`,
);
check(
  unclassifiedInSource.length === 0,
  `建表清单里每张表都已归类（漏：${unclassifiedInSource.join(", ") || "无"}）`,
);
// config_meta 由 bootstrapConfigSnapshot（config-snapshot.ts）建——它是快照元信息标记表，
// 不走 database.service.ts 的建表清单，所以单独豁免（缺了它 knownTables 会误报「多余」）。
const BOOTSTRAP_ONLY_TABLES = ["config_meta"];
const ghostTables = [...knownTables].filter(
  (name) => !declaredTables.includes(name) && !BOOTSTRAP_ONLY_TABLES.includes(name),
);
check(ghostTables.length === 0, `分类清单里没有写错的表名（多余：${ghostTables.join(", ") || "无"}）`);

//#endregion

//#region 二 · 导出内容

group("二 · 导出内容（只含配置表、值转义正确）");

const source = seedSource();
const exported = configSql.build(source, { tables: TEST_TABLES });

checkEqual(exported.stats.tables, 3, "导出 3 张表");
checkEqual(exported.stats.rows, 6, "导出 6 行（drugs 1 + items 3 + monsters 2）");
check(exported.sql.includes('DELETE FROM "items";'), "每张表先 DELETE（整表替换语义）");
check(
  exported.sql.includes('INSERT INTO "monsters" ("id", "label", "level") VALUES (\'m_1\', \'鸡\', 1);'),
  "行按值写出（列名显式列出——位置式 INSERT 在存量库上遇到列序不一致会把值塞错列）",
);
check(!exported.sql.includes("accounts"), "运行时表（accounts）不在文件里");
check(!exported.sql.includes("scrypt$hash$value"), "账号密码哈希不在文件里");
check(exported.sql.includes("'O''Brien 的剑'"), "单引号被转义成两个（否则导入会语法错）");
check(exported.sql.includes("NULL"), "NULL 写成 NULL 而不是空字符串");

// 顺序稳定：同一份数据连导两次必须逐字节一致（否则 config-check 天天误报）
const again = configSql.build(source, { tables: TEST_TABLES });
checkEqual(again.sql, exported.sql, "同一份数据两次导出逐字节一致");

//#endregion

//#region 三 · 往返

group("三 · 往返（导出 → 导入另一个库 → 逐字节等价）");

const target = createDb(path.join(TEMP_DIR, "target.db"));
exec(target, exported.sql);

const roundTrip = configSql.build(target, { tables: TEST_TABLES });
checkEqual(roundTrip.sql, exported.sql, "导入后重新导出，与文件逐字节一致");
checkEqual(scalar(target, "SELECT sell_price FROM items WHERE id = 'item_iron'"), 12, "数字原样过去");
checkEqual(scalar(target, "SELECT description FROM items WHERE id = 'item_gem'"), null, "NULL 原样过去");
checkEqual(
  scalar(target, "SELECT label FROM items WHERE id = 'item_quote'"),
  "O'Brien 的剑",
  "带单引号的字符串原样过去",
);
check(
  String(scalar(target, "SELECT description FROM items WHERE id = 'item_quote'")).includes("\n"),
  "带换行的字符串原样过去",
);

//#endregion

//#region 四 · 改动同步（这套东西存在的理由）

group("四 · 改动同步（改值 / 删行都要能过去）");

exec(source, "UPDATE items SET sell_price = 999, label = '铁矿（精炼）' WHERE id = 'item_iron'");
const afterEdit = configSql.build(source, { tables: TEST_TABLES });
check(afterEdit.sql !== exported.sql, "改值后快照内容变了");

exec(target, afterEdit.sql);
checkEqual(scalar(target, "SELECT sell_price FROM items WHERE id = 'item_iron'"), 999, "改过的卖价同步过去了");
checkEqual(
  scalar(target, "SELECT label FROM items WHERE id = 'item_iron'"),
  "铁矿（精炼）",
  "改过的名字同步过去了",
);

exec(source, "DELETE FROM items WHERE id = 'item_gem'");
const afterDelete = configSql.build(source, { tables: TEST_TABLES });
exec(target, afterDelete.sql);
checkEqual(scalar(target, "SELECT COUNT(1) FROM items"), 2, "源库删掉的行在目标库也没了（整表替换，不是 upsert）");

exec(source, "INSERT INTO drugs VALUES ('drug_hp_2', '金创药（中）', 250)");
const afterInsert = configSql.build(source, { tables: TEST_TABLES });
exec(target, afterInsert.sql);
checkEqual(scalar(target, "SELECT COUNT(1) FROM drugs"), 2, "源库新增的行同步过去了");

// 账号表始终不受影响
exec(target, "INSERT INTO accounts VALUES ('acc_local', 'local', 'local-hash')");
exec(target, afterInsert.sql);
checkEqual(scalar(target, "SELECT COUNT(1) FROM accounts"), 1, "导入配置不会清掉目标库的账号");
checkEqual(scalar(target, "SELECT password FROM accounts WHERE id = 'acc_local'"), "local-hash", "账号数据原样保留");

//#endregion

//#region 五 · 导入校验

group("五 · 导入校验（坏文件要拒绝，不能清空配置）");

const good = afterInsert.sql;

/** 把好文件改造一下再校验：每段都基于同一份内容，避免互相干扰 */
function validateVariant(mutate) {
  const text = mutate(good);
  return () => configSql.validate(text, configSql.parseMeta(text), TEST_TABLES);
}

check(
  (() => {
    try {
      validateVariant((text) => text)();
      return true;
    } catch {
      return false;
    }
  })(),
  "好文件通过校验",
);

checkThrows(
  validateVariant((text) => text.replace("-- olua config snapshot v1", "-- 随手改的文件")),
  "找不到",
  "没有格式标记的文件被拒绝",
);

checkThrows(
  validateVariant((text) => text.replace(/^-- tables: .*$/m, "-- tables: drugs,items")),
  "表清单与当前脚本不一致",
  "表清单少一张被拒绝（否则那张会被清空）",
);

checkThrows(
  validateVariant((text) => text.replace(/^-- tables: .*$/m, "-- tables: drugs,items,monsters,evil")),
  "表清单与当前脚本不一致",
  "表清单多一张被拒绝",
);

checkThrows(
  validateVariant((text) => text.replace('DELETE FROM "monsters";\n', "")),
  "DELETE 段数量不对",
  "缺 DELETE 段的文件被拒绝（否则旧行会残留）",
);

checkThrows(
  validateVariant((text) => text.replace('DELETE FROM "items";', 'DELETE FROM "items";\nDELETE FROM "items";')),
  "DELETE 段数量不对",
  "重复 DELETE 段被拒绝",
);

checkThrows(
  validateVariant((text) =>
    text.replace("COMMIT;", 'INSERT INTO "accounts" VALUES (\'acc_x\', \'x\', \'hash\');\nCOMMIT;'),
  ),
  "运行时表",
  "混入运行时表的文件被拒绝",
);

checkThrows(
  validateVariant((text) => text.replace("COMMIT;", 'INSERT INTO "unknown_table" VALUES (1);\nCOMMIT;')),
  "未登记的表",
  "混入未登记表的文件被拒绝",
);

//#endregion

//#region 六 · compare

group("六 · compare（报告哪张表落后了）");

checkEqual(configSql.compare(good, good), null, "内容一致时返回 null");

const drifted = good.replace(
  "INSERT INTO \"items\" (\"id\", \"label\", \"sell_price\", \"description\") VALUES ('item_iron', '铁矿（精炼）', 999, '锻造用的基础材料');",
  "INSERT INTO \"items\" (\"id\", \"label\", \"sell_price\", \"description\") VALUES ('item_iron', '铁矿（精炼）', 1, '锻造用的基础材料');",
);
const diff = configSql.compare(drifted, good);
check(diff !== null, "内容不一致时返回差异");
checkEqual(diff?.section, "items", "差异定位到 items 表");
check(typeof diff?.firstLine === "number" && diff.firstLine > 0, "差异带行号");

//#endregion

//#region 七 · 落盘

group("七 · 落盘（先写临时文件再 rename）");

const outFile = path.join(TEMP_DIR, "out", "config-sync.sql");
configSql.writeAtomic(outFile, exported.sql);
check(fs.existsSync(outFile), "文件写出来了");
checkEqual(fs.readFileSync(outFile, "utf8"), exported.sql, "文件内容与生成结果一致");
check(!fs.existsSync(`${outFile}.tmp-${process.pid}`), "没有留下临时文件");

//#endregion

//#region 收尾

try {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论，系统临时目录会被回收 */
}

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.log(failures.map((label) => `  ✗ ${label}`).join("\n"));
  process.exit(1);
}

//#endregion
