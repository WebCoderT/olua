#!/usr/bin/env node
/**
 * 装备人工对齐器 · 写回脚本
 *
 * 把 index.html 导出的 offsets.json 写回 assets/configs/equipments.ts：
 * 只替换目标装备条目的 outPositions（8 方向各一个 Vec2，带方向注释）与 outScale，
 * 其余字段、注释、格式一字不动。
 *
 * 用法（在项目根执行）：
 *   node equip-aligner/apply-offsets.cjs offsets.json             # 写回（先备份 .bak）
 *   node equip-aligner/apply-offsets.cjs offsets.json --dry-run   # 只看会改什么，不落盘
 *   node equip-aligner/apply-offsets.cjs offsets.json --file assets/configs/equipments.ts
 *   cat offsets.json | node equip-aligner/apply-offsets.cjs -     # 从标准输入读
 *
 * 退出码：0 = 成功（含无改动）；1 = 参数/文件/解析错误；2 = 有 key 在 equipments.ts 里找不到。
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DEFAULT_TARGET = "assets/configs/equipments.ts";
const ANIMATION_FILE = "assets/configs/animation.ts";

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const options = { json: "", target: DEFAULT_TARGET, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
    else if (arg === "--file" || arg === "-f") options.target = argv[++i] || options.target;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.json) options.json = arg;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
  process.exit(0);
}

/* --------------------------- 源码扫描 --------------------------- */

/** 从 openIdx 处的括号配对到闭合位置（跳过字符串与行/块注释） */
function matchBracket(text, openIdx) {
  const open = text[openIdx];
  const close = open === "[" ? "]" : open === "{" ? "}" : open === "(" ? ")" : "";
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return i; }
  }
  return -1;
}

/** 切出数组体里的顶层对象（返回 {start, end} 绝对区间） */
function topLevelObjectRanges(body, offset) {
  const ranges = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{") {
      const end = matchBracket(body, i);
      if (end < 0) break;
      ranges.push({ start: offset + i, end: offset + end + 1 });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < body.length) {
        if (body[i] === "\\") { i += 2; continue; }
        if (body[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return ranges;
}

/** 建立 key → 条目区间索引（扫描所有 `const xxxData: EquipmentData[] = [...]`） */
function indexEquipmentEntries(source) {
  const index = new Map();
  const arrayRe = /const\s+(\w+Data)\s*:\s*EquipmentData\[\]\s*=\s*\[/g;
  let match;
  while ((match = arrayRe.exec(source))) {
    const arrayName = match[1];
    const open = match.index + match[0].lastIndexOf("[");
    const close = matchBracket(source, open);
    if (close < 0) continue;
    const bodyStart = open + 1;
    topLevelObjectRanges(source.slice(bodyStart, close), bodyStart).forEach((range) => {
      const text = source.slice(range.start, range.end);
      const keyMatch = /key:\s*"([^"]*)"/.exec(text);
      if (!keyMatch) return;
      if (index.has(keyMatch[1])) {
        console.warn(`! 重复 key：${keyMatch[1]}（${arrayName}）——后者被忽略`);
        return;
      }
      index.set(keyMatch[1], { arrayName, start: range.start, end: range.end });
    });
  }
  return index;
}

/** 方向注释名（顺序即 outPositions 下标）：取自 configs/animation 的 directions 数组 */
function readDirections() {
  const fallback = ["up", "right_up", "right", "right_down", "down", "left_down", "left", "left_up"];
  const file = path.join(ROOT, ANIMATION_FILE);
  if (!fs.existsSync(file)) return fallback;
  const source = fs.readFileSync(file, "utf8");
  const block = /export const directions:\s*DIRECTION\[\]\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) return fallback;
  const names = [];
  const itemRe = /DIRECTION\.(\w+)/g;
  let match;
  while ((match = itemRe.exec(block[1]))) names.push(match[1].toLowerCase());
  return names.length === 8 ? names : fallback;
}

/* ------------------------------ 生成 ------------------------------ */

/** 数值格式：保留 1 位小数，整数不带小数点（与现有配置风格一致） */
function formatNumber(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 生成 outPositions 字段文本：首行**不带缩进**（替换区间从字段名开始，行首空格留在原文本里），
 * 末行 `]` 带缩进、尾部不带逗号（逗号同样留在原文本里）
 */
function buildOutPositionsText(positions, fieldIndent, directions) {
  const pad = " ".repeat(fieldIndent);
  const itemPad = " ".repeat(fieldIndent + 2);
  const lines = ["outPositions: ["];
  positions.forEach((point, index) => {
    const comment = directions[index] ? ` // ${directions[index]}` : "";
    lines.push(`${itemPad}new Vec2(${formatNumber(point[0])}, ${formatNumber(point[1])}),${comment}`);
  });
  lines.push(`${pad}]`);
  return lines.join("\n");
}

/**
 * 定位 outPositions 字段的**整段**（字段名 → `]`，不含行首缩进与尾逗号），
 * 替换时既不会把 `outPositions:` 重复一遍，也不会把缩进叠成两层
 */
function findFieldArray(text, field) {
  const re = new RegExp(`${field}\\s*:\\s*\\[`);
  const match = re.exec(text);
  if (!match) return null;
  const open = text.indexOf("[", match.index);
  const close = matchBracket(text, open);
  if (close < 0) return null;
  return { start: match.index, end: close + 1 };
}

/** 取字段所在行的缩进宽度 */
function lineIndent(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, index));
  return match ? match[0].length : 0;
}

/* ------------------------------ 主流程 ------------------------------ */

function readInput() {
  if (options.json && options.json !== "-") {
    const file = path.resolve(ROOT, options.json);
    if (!fs.existsSync(file)) fail(`找不到 offsets.json：${file}`);
    return { text: fs.readFileSync(file, "utf8"), from: file };
  }
  const text = fs.readFileSync(0, "utf8");
  if (!text.trim()) fail("标准输入是空的（用法见 --help）");
  return { text, from: "stdin" };
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const input = readInput();
let payload;
try {
  payload = JSON.parse(input.text);
} catch (err) {
  fail(`offsets.json 不是合法 JSON：${err.message}`);
}
const entries = (payload && payload.entries) || {};
const keys = Object.keys(entries);
if (!keys.length) {
  console.log("没有需要写回的条目（offsets.json 的 entries 为空）。");
  process.exit(0);
}

const targetPath = path.resolve(ROOT, options.target);
if (!fs.existsSync(targetPath)) fail(`找不到目标文件：${targetPath}`);
const source = fs.readFileSync(targetPath, "utf8");
const directions = readDirections();
const index = indexEquipmentEntries(source);

console.log(`来源：${input.from}`);
console.log(`目标：${options.target}`);
console.log(`方向：${directions.join(", ")}`);
console.log(`条目：${keys.length} 件${options.dryRun ? "（dry-run，不落盘）" : ""}`);
console.log("");

const edits = [];      // {start, end, text}
const missing = [];
const reports = [];

keys.forEach((key) => {
  const where = index.get(key);
  const entry = entries[key] || {};
  if (!where) { missing.push(key); return; }
  const objectText = source.slice(where.start, where.end);
  const positions = (entry.outPositions || []).slice(0, 8).map((point) => [Number(point[0]) || 0, Number(point[1]) || 0]);
  while (positions.length < 8) positions.push(positions[0] ? positions[0].slice() : [0, 0]);

  const arrayField = findFieldArray(objectText, "outPositions");
  const scaleMatch = /outScale\s*:\s*(-?[\d.]+)/.exec(objectText);
  const scaleValue = entry.outScale === undefined ? null : Number(entry.outScale);

  if (arrayField) {
    const absoluteStart = where.start + arrayField.start;
    const absoluteEnd = where.start + arrayField.end;
    const oldText = source.slice(absoluteStart, absoluteEnd);
    const oldPositions = parseVec2List(oldText);
    // 数值等价就不碰原文本：保留作者手写的写法（如 `-10.0`）与多余格式差异，往返导出零 diff
    if (samePositions(oldPositions, positions)) {
      reports.push({ key, kind: "outPositions", detail: `${describePositions(positions)}（无变化）` });
    } else {
      const indent = lineIndent(source, absoluteStart);
      const newText = buildOutPositionsText(positions, indent, directions);
      edits.push({ start: absoluteStart, end: absoluteEnd, text: newText, key });
      reports.push({ key, kind: "outPositions", detail: `${describePositions(oldPositions)} → ${describePositions(positions)}` });
    }
  } else {
    // 条目里原本没有 outPositions：在 out / in 行之后补一段
    const anchor = /(^[ \t]*(?:out|in)\s*:\s*[^\n]*\n)/m.exec(objectText);
    if (!anchor) { missing.push(`${key}（无 outPositions 字段，也找不到插入点）`); return; }
    const insertAt = where.start + anchor.index + anchor[1].length;
    const indent = lineIndent(source, where.start + anchor.index);
    // 插入点落在行首，首行要自己补缩进
    edits.push({ start: insertAt, end: insertAt, text: `${" ".repeat(indent)}${buildOutPositionsText(positions, indent, directions)},\n`, key });
    reports.push({ key, kind: "outPositions(新增字段)", detail: describePositions(positions) });
  }

  if (scaleValue !== null) {
    if (scaleMatch) {
      const absolute = where.start + scaleMatch.index;
      const end = absolute + scaleMatch[0].length;
      const text = `outScale: ${formatNumber(scaleValue)}`;
      if (source.slice(absolute, end) !== text) {
        edits.push({ start: absolute, end, text, key });
        reports.push({ key, kind: "outScale", detail: `${scaleMatch[1]} → ${formatNumber(scaleValue)}` });
      }
    } else {
      const anchor = /(^[ \t]*out\s*:\s*[^\n]*\n)/m.exec(objectText);
      if (anchor) {
        const insertAt = where.start + anchor.index + anchor[1].length;
        const indent = lineIndent(source, where.start + anchor.index);
        edits.push({ start: insertAt, end: insertAt, text: `${" ".repeat(indent)}outScale: ${formatNumber(scaleValue)},\n`, key });
        reports.push({ key, kind: "outScale(新增字段)", detail: formatNumber(scaleValue) });
      }
    }
  }
});

reports.forEach((report) => {
  console.log(`  ${report.key.padEnd(14)} ${report.kind.padEnd(20)} ${report.detail}`);
});

if (!edits.length) {
  console.log("\n没有实际改动（导出的值与文件现状一致）。");
  if (missing.length) console.log(`未找到的 key：${missing.join(", ")}`);
  process.exit(missing.length ? 2 : 0);
}

// 从后往前替换，避免前面的改动让后面的偏移失效
edits.sort((a, b) => b.start - a.start);
let output = source;
edits.forEach((edit) => {
  output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
});

if (options.dryRun) {
  console.log(`\n[dry-run] 将替换 ${edits.length} 处、涉及 ${new Set(edits.map((edit) => edit.key)).size} 件装备，未写入文件。`);
} else {
  const backup = `${targetPath}.bak`;
  fs.writeFileSync(backup, source, "utf8");
  fs.writeFileSync(targetPath, output, "utf8");
  console.log(`\n已写回 ${options.target}（原文件备份：${path.relative(ROOT, backup)}）`);
  console.log("建议接着做：");
  console.log("  1) 等 20 秒后用 grep 核对磁盘内容（编辑器有周期性回写，见项目记忆）");
  console.log("  2) 跑工程 tsc 与单测（node tools/test-*.cjs）确认没破坏配置");
}

if (missing.length) {
  console.log(`\n未找到的 key（未改动）：${missing.join(", ")}`);
  process.exit(2);
}

/** 从一段文本里提取 Vec2 列表（报告与「有无变化」判断用） */
function parseVec2List(text) {
  const points = [];
  const re = /new\s+Vec2\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g;
  let match;
  while ((match = re.exec(text))) points.push([parseFloat(match[1]), parseFloat(match[2])]);
  return points;
}

/** 两组偏移是否数值等价（按 0.1 精度比较，忽略 `-10.0` 与 `-10` 这类写法差异） */
function samePositions(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.round(a[i][0] * 10) !== Math.round(b[i][0] * 10)) return false;
    if (Math.round(a[i][1] * 10) !== Math.round(b[i][1] * 10)) return false;
  }
  return true;
}

/** 偏移列表的可读描述（8 向同值时合并显示） */
function describePositions(positions) {
  if (!positions.length) return "(无)";
  const first = positions[0];
  let same = positions.length === 8;
  for (let i = 1; i < positions.length && same; i++) {
    if (positions[i][0] !== first[0] || positions[i][1] !== first[1]) same = false;
  }
  const head = `(${formatNumber(first[0])}, ${formatNumber(first[1])})`;
  return same ? `${head} ×8` : `8 向不同，首项 ${head}`;
}
