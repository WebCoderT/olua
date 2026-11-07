#!/usr/bin/env node
/**
 * e2e 的「出厂值」预期来源：`server/data/config-sync.sql`
 *
 * ===========================================================================
 * 为什么不读 `dist/shared/*` 了（#655）
 * ===========================================================================
 * 出厂数据以前是一堆 TS 常量（`server/src/shared/*-seed.ts` + `*.generated.ts`），
 * e2e 直接 require 编译产物当「期望值」。那个目录已经删了 —— 现在数据只有一处权威：
 * 数据库；而**库的逐行投影**就是仓库里的这份快照（`make config-export` 生成，
 * 空库启动时由 `bootstrapConfigSnapshot()` 整份灌进去）。
 *
 * 于是 e2e 的断言变成：**接口返回的字段 == 快照里那一列**。
 * 这比原来更严格 —— 它顺带钉住了「SQL → 建表 → 落库 → 读出来」这条链：
 * 快照里写着 60 级经验 12345，接口返回别的数字，就说明中间某一环丢了值。
 *
 * 解析本身在 `tools/lib/snapshot-sql.cjs`（审计读同一份文件，格式只有一种读法），
 * 这里只补 e2e 顺手要的两个索引函数。
 */
"use strict";

const path = require("node:path");
const { SNAPSHOT_FILE, readRowsCamel, readSnapshotText } = require(
  path.join(__dirname, "..", "..", "..", "tools", "lib", "snapshot-sql.cjs"),
);

/** 某张表的全部行（camelCase 列名，JSON 列已解开；保持快照里的书写顺序） */
function rows(table) {
  const result = readRowsCamel(readSnapshotText(), table);
  if (result.length === 0) throw new Error(`快照里没有表 ${table} 的行（跑一次 make config-export？）`);
  return result;
}

/**
 * 按某列索引成对象（`obj[key]` 直接取行）
 *
 * 键一律转成字符串：`npcs` 的 id 是 `'0002'`，`titles.level` 是数字 ——
 * 两种都能用同一个写法取。
 *
 * @param {string} table 表名
 * @param {string} [key] 主键列（camelCase）
 * @returns {Record<string, Record<string, unknown>>}
 */
function index(table, key = "id") {
  const result = {};
  for (const row of rows(table)) result[String(row[key])] = row;
  return result;
}

/**
 * 按某列分组（一行 → 多行的那种关系，如怪物技能挂载）
 *
 * @param {string} table 表名
 * @param {string} key 分组列（camelCase）
 * @returns {Record<string, Array<Record<string, unknown>>>}
 */
function group(table, key) {
  const result = {};
  for (const row of rows(table)) {
    const id = String(row[key]);
    if (!result[id]) result[id] = [];
    result[id].push(row);
  }
  return result;
}

/** 行数（断言「列表 total = 配置表行数」用） */
function count(table) {
  return rows(table).length;
}

/** 某张表的全部行，表不在快照里（或 0 行）时返回空数组 —— 允许为空的运营表用 */
function optionalRows(table) {
  const result = readRowsCamel(readSnapshotText(), table);
  return Array.isArray(result) ? result : [];
}

/**
 * 等级曲线求值（#786）：`role_level_curves` 的段参数 → 某条曲线在某一级的值
 *
 * 等级不再是「一级一行」，等级 / 60 这样的取法没了 —— 要某个等级的出厂值就在这里算。
 * 公式与 `src/common/constants/role-level-curve.ts` 的 `curveValueAt` 同一套
 * （段内二阶、超出末段外推），**故意另写一份当对照基准**：服务端那份写错了，
 * 接口返回值与本函数对不上就会被 e2e 抓到（绝对值另有 `e2e-level-curve` 钉住）。
 *
 * @param {string} curve 曲线键（exp / hp / attack_max / defense_max）
 * @param {number} level 等级（1 起）
 * @returns {number | null} 该级的值；曲线缺失或等级 < 1 时 null
 */
function curveValue(curve, level) {
  if (!(level >= 1)) return null;
  let picked = null;
  for (const row of optionalRows("role_level_curves")) {
    if (row.curve !== curve || Number(row.fromLevel) > level) continue;
    if (!picked || Number(row.fromLevel) > Number(picked.fromLevel)) picked = row;
  }
  if (!picked) return null;
  const k = level - Number(picked.fromLevel);
  return Math.round(Number(picked.startValue) + Number(picked.perLevel) * k + (Number(picked.accel) * k * (k - 1)) / 2);
}

module.exports = { SNAPSHOT_FILE, rows, index, group, count, optionalRows, curveValue };
