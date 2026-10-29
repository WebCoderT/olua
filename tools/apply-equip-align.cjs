#!/usr/bin/env node
/**
 * 装备对齐工作台 · 写回脚本
 *
 * 把管理端「装备对齐」页导出的 `equip-align.json` 写回客户端配置：
 *   - `cloth:cloth_1` / `weapon:weapon_1` → `client/assets/configs/equipments.ts`
 *   - `role:1` / `role:2`                → `client/assets/configs/role.ts`（默认裸模的 8 向位置）
 *
 * **只替换几何字段**（`outScale` / `outPositions`，武器再加 `outManual`），
 * 其余字段、注释、格式一字不动；数值等价时不碰原文本（往返导出零 diff）。
 *
 * 用法（项目根执行）：
 *   node tools/apply-equip-align.cjs equip-align.json             # 写回（先备份 .bak）
 *   node tools/apply-equip-align.cjs equip-align.json --dry-run   # 只看会改什么
 *   cat equip-align.json | node tools/apply-equip-align.cjs -
 *
 * 退出码：0 = 成功（含无改动）；1 = 参数/文件/解析错误；2 = 有 key 在配置里找不到。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EQUIPMENTS_FILE = "client/assets/configs/equipments.ts";
const ROLE_FILE = "client/assets/configs/role.ts";
const ANIMATION_FILE = "client/assets/configs/animation.ts";

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const options = { json: "", dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.json) options.json = arg;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^\s*\* ?/gm, "").trim());
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
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return i;
    }
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
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * key → 基础件条目的区间
 *
 * 只认 `const xxxData: EquipmentData[] = [...]` 里的对象；前后缀变体（`cloth_1_p3s2`）
 * 是 `buildEquipmentMap` 运行时展开的，源码里不存在，也不会被这里改到。
 */
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

/**
 * 数值格式：最多 2 位小数，整数不带小数点（与现有配置风格一致）
 *
 * 位置是 0.1 精度就够，但**缩放**要对齐页面的 0.02 步进 —— 只保留 1 位会把 1.05 写成 1.1，
 * 用户调好的比例被悄悄改掉。
 */
function formatNumber(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return String(rounded);
}

/**
 * 生成 outPositions 字段文本：首行**不带缩进**（替换区间从字段名开始，行首空格留在原文本里），
 * 末行 `]` 带缩进、尾部不带逗号（逗号同样留在原文本里）
 */
function buildOutPositionsText(positions, fieldIndent, directions, eol) {
  const pad = " ".repeat(fieldIndent);
  const itemPad = " ".repeat(fieldIndent + 2);
  const lines = ["outPositions: ["];
  positions.forEach((point, index) => {
    const comment = directions[index] ? ` // ${directions[index]}` : "";
    lines.push(`${itemPad}new Vec2(${formatNumber(point[0])}, ${formatNumber(point[1])}),${comment}`);
  });
  lines.push(`${pad}]`);
  return lines.join(eol);
}

/** 定位 outPositions 字段的整段（字段名 → `]`，不含行首缩进与尾逗号） */
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

/** 规整成 8 项 */
function normalizePositions(list) {
  const positions = (list || []).slice(0, 8).map((point) => [Number(point?.[0]) || 0, Number(point?.[1]) || 0]);
  while (positions.length < 8) positions.push(positions[0] ? positions[0].slice() : [0, 0]);
  return positions;
}

/* ------------------------------ 主流程 ------------------------------ */

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readInput() {
  if (options.json && options.json !== "-") {
    const file = path.resolve(ROOT, options.json);
    if (!fs.existsSync(file)) fail(`找不到对齐结果：${file}`);
    return { text: fs.readFileSync(file, "utf8"), from: path.relative(ROOT, file) };
  }
  const text = fs.readFileSync(0, "utf8");
  if (!text.trim()) fail("标准输入是空的（用法见 --help）");
  return { text, from: "stdin" };
}

const input = readInput();
let payload;
try {
  payload = JSON.parse(input.text);
} catch (error) {
  fail(`不是合法 JSON：${error.message}`);
}
const entries = (payload && payload.entries) || {};
const keys = Object.keys(entries);
if (!keys.length) {
  console.log("没有需要写回的条目（entries 为空）。");
  process.exit(0);
}

const directions = readDirections();
const equipmentsPath = path.join(ROOT, EQUIPMENTS_FILE);
const rolePath = path.join(ROLE_FILE);
if (!fs.existsSync(equipmentsPath)) fail(`找不到 ${EQUIPMENTS_FILE}`);
if (!fs.existsSync(rolePath)) fail(`找不到 ${ROLE_FILE}`);

const equipmentsSource = fs.readFileSync(equipmentsPath, "utf8");
const roleSource = fs.readFileSync(rolePath, "utf8");
// 行尾跟随源文件：这两个配置是 LF，但别的机器 / 别的编辑器可能存成 CRLF，
// 硬写 \n 会在 diff 里掺进「整段行尾变了」的噪声
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const equipmentsEol = eolOf(equipmentsSource);
const roleEol = eolOf(roleSource);
const index = indexEquipmentEntries(equipmentsSource);

/** 支持 `kind:key` 与旧的裸 key 两种写法（裸 key 只认装备，不认裸模） */
function splitKey(raw) {
  const colon = raw.indexOf(":");
  if (colon < 0) return { kind: "equip", key: raw };
  return { kind: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

const equipmentEdits = [];
const roleEdits = [];
const missing = [];
const reports = [];

for (const rawKey of keys) {
  const entry = entries[rawKey] || {};
  const positions = normalizePositions(entry.outPositions);
  const scaleValue = entry.outScale === undefined ? null : Number(entry.outScale);
  const { kind, key } = splitKey(rawKey);

  if (kind === "role") {
    const sex = key === "1" ? "BOY" : key === "2" ? "GRIL" : "";
    if (!sex) {
      missing.push(`${rawKey}（裸模只认 1 = 男 / 2 = 女）`);
      continue;
    }
    const anchor = new RegExp(`roleDefaultCloths\\.set\\(SEX\\.${sex},\\s*\\{`).exec(roleSource);
    if (!anchor) {
      missing.push(`${rawKey}（role.ts 里找不到 SEX.${sex} 的默认外观）`);
      continue;
    }
    const open = anchor.index + anchor[0].lastIndexOf("{");
    const close = matchBracket(roleSource, open);
    if (close < 0) {
      missing.push(`${rawKey}（默认外观对象括号不配对）`);
      continue;
    }
    const objectText = roleSource.slice(open, close + 1);
    const outMatch = /out\s*:\s*"([^"]+)"/.exec(objectText);
    const outSrc = outMatch ? outMatch[1] : "";
    const scale = scaleValue === null ? 1 : scaleValue;

    const itemPad = "  ";
    const lines = [
      "{",
      `${itemPad}out: "${outSrc}",`,
      `${itemPad}outScale: ${formatNumber(scale)},`,
      `${itemPad}outPositions: [`,
      ...positions.map((point, i) => `${itemPad}${itemPad}new Vec2(${formatNumber(point[0])}, ${formatNumber(point[1])}), // ${directions[i] ?? i}`),
      `${itemPad}],`,
      "}",
    ];
    const oldPositions = parseVec2List(objectText);
    // 原值是 `defaultOutPositions()`（8 个零点，没有字面量可解析）：全零导出等于原样，别写
    const alreadyDefault = !oldPositions.length && /defaultOutPositions\(\)/.test(objectText) && positions.every((point) => point[0] === 0 && point[1] === 0);
    if (alreadyDefault || (samePositions(oldPositions, positions) && scale === 1)) {
      reports.push({ key: rawKey, kind: "role", detail: `${describePositions(positions)}（无变化）` });
      continue;
    }
    roleEdits.push({ start: open, end: close + 1, text: lines.join(roleEol), key: rawKey });
    reports.push({ key: rawKey, kind: "role", detail: `${describePositions(oldPositions)} → ${describePositions(positions)}` });
    continue;
  }

  const where = index.get(key);
  if (!where) {
    missing.push(rawKey);
    continue;
  }
  const objectText = equipmentsSource.slice(where.start, where.end);
  const arrayField = findFieldArray(objectText, "outPositions");
  const scaleMatch = /outScale\s*:\s*(-?[\d.]+)/.exec(objectText);
  const manualMatch = /outManual\s*:\s*(true|false)/.exec(objectText);

  if (arrayField) {
    const absoluteStart = where.start + arrayField.start;
    const absoluteEnd = where.start + arrayField.end;
    const oldText = equipmentsSource.slice(absoluteStart, absoluteEnd);
    const oldPositions = parseVec2List(oldText);
    if (samePositions(oldPositions, positions)) {
      reports.push({ key: rawKey, kind: "outPositions", detail: `${describePositions(positions)}（无变化）` });
    } else {
      const indent = lineIndent(equipmentsSource, absoluteStart);
      equipmentEdits.push({ start: absoluteStart, end: absoluteEnd, text: buildOutPositionsText(positions, indent, directions, equipmentsEol), key: rawKey });
      reports.push({ key: rawKey, kind: "outPositions", detail: `${describePositions(oldPositions)} → ${describePositions(positions)}` });
    }
  } else {
    const anchor = /(^[ \t]*(?:out|in)\s*:\s*[^\n]*\n)/m.exec(objectText);
    if (!anchor) {
      missing.push(`${rawKey}（无 outPositions 字段，也找不到插入点）`);
      continue;
    }
    const insertAt = where.start + anchor.index + anchor[1].length;
    const indent = /^[ \t]*/.exec(anchor[1])[0].length;
    equipmentEdits.push({
      start: insertAt,
      end: insertAt,
      text: `${" ".repeat(indent)}${buildOutPositionsText(positions, indent, directions, equipmentsEol)},${equipmentsEol}`,
      key: rawKey,
    });
    reports.push({ key: rawKey, kind: "outPositions(新增)", detail: describePositions(positions) });
  }

  if (scaleValue !== null) {
    if (scaleMatch) {
      const absolute = where.start + scaleMatch.index;
      const end = absolute + scaleMatch[0].length;
      const text = `outScale: ${formatNumber(scaleValue)}`;
      if (equipmentsSource.slice(absolute, end) !== text) {
        equipmentEdits.push({ start: absolute, end, text, key: rawKey });
        reports.push({ key: rawKey, kind: "outScale", detail: `${scaleMatch[1]} → ${formatNumber(scaleValue)}` });
      }
    } else {
      const anchor = /(^[ \t]*out\s*:\s*[^\n]*\n)/m.exec(objectText);
      if (anchor) {
        const insertAt = where.start + anchor.index + anchor[1].length;
        const indent = /^[ \t]*/.exec(anchor[1])[0].length;
        equipmentEdits.push({ start: insertAt, end: insertAt, text: `${" ".repeat(indent)}outScale: ${formatNumber(scaleValue)},${equipmentsEol}`, key: rawKey });
        reports.push({ key: rawKey, kind: "outScale(新增)", detail: formatNumber(scaleValue) });
      }
    }
  }

  // 武器的「手调绝对位置」开关：页面勾了才写，没勾且原来有就删掉（回到自动算法）
  if (kind === "weapon" && typeof entry.manual === "boolean") {
    const desired = entry.manual;
    if (manualMatch) {
      if ((manualMatch[1] === "true") !== desired) {
        const absolute = where.start + manualMatch.index;
        equipmentEdits.push({ start: absolute, end: absolute + manualMatch[0].length, text: `outManual: ${desired}`, key: rawKey });
        reports.push({ key: rawKey, kind: "outManual", detail: `${manualMatch[1]} → ${desired}` });
      }
    } else if (desired) {
      const anchor = /(^[ \t]*outScale\s*:\s*[^\n]*\n)/m.exec(objectText);
      if (anchor) {
        const insertAt = where.start + anchor.index + anchor[1].length;
        const indent = /^[ \t]*/.exec(anchor[1])[0].length;
        equipmentEdits.push({ start: insertAt, end: insertAt, text: `${" ".repeat(indent)}outManual: true,${equipmentsEol}`, key: rawKey });
        reports.push({ key: rawKey, kind: "outManual(新增)", detail: "true" });
      }
    }
  }
}

console.log(`来源：${input.from}`);
console.log(`方向：${directions.join(", ")}`);
console.log(`条目：${keys.length} 件${options.dryRun ? "（dry-run，不落盘）" : ""}`);
console.log("");
reports.forEach((report) => console.log(`  ${report.key.padEnd(18)} ${report.kind.padEnd(18)} ${report.detail}`));

if (!equipmentEdits.length && !roleEdits.length) {
  console.log("\n没有实际改动（导出的值与配置现状一致）。");
  if (missing.length) console.log(`未找到的 key：${missing.join(", ")}`);
  process.exit(missing.length ? 2 : 0);
}

/** 从后往前替换，避免前面的改动让后面的偏移失效 */
function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of sorted) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

const nextEquipments = applyEdits(equipmentsSource, equipmentEdits);
const nextRole = applyEdits(roleSource, roleEdits);

if (options.dryRun) {
  console.log(`\n[dry-run] equipments.ts 改 ${equipmentEdits.length} 处、role.ts 改 ${roleEdits.length} 处，未写入。`);
} else {
  if (equipmentEdits.length) {
    fs.writeFileSync(`${equipmentsPath}.bak`, equipmentsSource, "utf8");
    fs.writeFileSync(equipmentsPath, nextEquipments, "utf8");
  }
  if (roleEdits.length) {
    fs.writeFileSync(`${rolePath}.bak`, roleSource, "utf8");
    fs.writeFileSync(rolePath, nextRole, "utf8");
  }
  console.log(`\n已写回：${equipmentEdits.length ? EQUIPMENTS_FILE : ""}${equipmentEdits.length && roleEdits.length ? " + " : ""}${roleEdits.length ? ROLE_FILE : ""}`);
  console.log("备份：*.ts.bak（提交前记得删掉）");
  console.log("接着做：node tools/gen-equip-align-catalog.cjs 让管理端清单跟上，再跑 make client-check");
}

if (missing.length) {
  console.log(`\n未找到的 key（未改动）：${missing.join(", ")}`);
  process.exit(2);
}
