#!/usr/bin/env node
/**
 * 一次性 codemod：给 e2e 里的「写角色」调用补上 revision（#820 / B62）
 *
 * 为什么是脚本而不是手改：8 个文件 66 处，逐处手改必然漏几处——
 * 而漏掉的表现是「400 / 40000」，在这套测试里长得像「接口坏了」。
 *
 * 规则：
 * 1. 定位 `api(<可能带 baseUrl>, "POST", \`roles/${<ID>}/<写接口>\`, { ... })`
 * 2. 若 options 里**已经**有 revision，原样跳过（那些是专测冲突的用例）
 * 3. 否则在 `body: { ... }` 末尾插入 `revision: await revOf(<ID>, <token>)`
 * 4. 在 api 函数之后插入 revOf 定义（按该文件的 api 签名分两种）
 *
 * 只跑一次，跑完人工复核 diff。
 */
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "server", "test");
const ROUTES = [
  "mall-purchase",
  "sell",
  "growth-upgrade",
  "drug-use",
  "money-use",
  "level-scroll-use",
  "bag-op",
  "fashion-buy",
  "fashion-wear",
];

/** api 的第一个参数是不是 baseUrl（决定 revOf 要不要多一个参数） */
const FOUR_ARG = new Set([
  "e2e-bag.cjs",
  "e2e-combat.cjs",
  "e2e-game-config.cjs",
  "e2e-level-scroll.cjs",
  "e2e-money-item.cjs",
  "e2e-sell.cjs",
]);

/** 括号配对，返回 [start, end) */
function matchParen(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 从 `{` 起做花括号配对 */
function matchBrace(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function addRevOf(src, file) {
  if (src.includes("const revOf =")) return src;
  const fnRe = /(async function api\((?:[^)]*)\) \{[\s\S]*?\n\})/;
  const m = src.match(fnRe);
  if (!m) throw new Error(`${file}: 找不到 api 函数`);
  const insertAt = m.index + m[1].length;
  const fourArg = FOUR_ARG.has(file);
  const helper = fourArg
    ? `

/**
 * 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000）
 *
 * 本文件的 api() 是「baseUrl 打头」的形态，所以这里也带上 baseUrl。
 */
const revOf = (baseUrl, roleId, token) =>
  revOfWith((method, route, options) => api(baseUrl, method, route, options), roleId, token);`
    : `

/** 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000） */
const revOf = (roleId, token) => revOfWith(api, roleId, token);`;
  return src.slice(0, insertAt) + helper + src.slice(insertAt);
}

/** 在给定调用里插入 revision；返回新的调用文本，或 null（表示跳过） */
function patchCall(src, callStart, callEnd, file) {
  const call = src.slice(callStart, callEnd);
  if (/revision/.test(call)) return null;

  const routeMatch = call.match(/\/?roles\/\$\{([^}]+)\}\/([a-z-]+)`/);
  if (!routeMatch) return null;
  const roleExpr = routeMatch[1];

  // token 可能是 `token: tokenX` 也可能是简写 `{ token, ... }`
  const tokenKV = call.match(/token:\s*([A-Za-z0-9_.$]+)/);
  const tokenExpr = tokenKV ? tokenKV[1] : /\{\s*token\s*[,}]/.test(call) ? "token" : null;
  if (!tokenExpr) throw new Error(`${file}: 找不到 token - ${call.slice(0, 100)}`);

  // body: { ... } —— 在闭合花括号前插入
  const bodyIdx = call.indexOf("body: {");
  if (bodyIdx < 0) throw new Error(`${file}: 找不到 body - ${call.slice(0, 100)}`);
  const braceStart = call.indexOf("{", bodyIdx);
  const braceEnd = matchBrace(call, braceStart);
  if (braceEnd < 0) throw new Error(`${file}: body 花括号不配对`);

  const fourArg = FOUR_ARG.has(file);
  let baseArg = "";
  if (fourArg) {
    const argsStart = call.indexOf("(") + 1;
    const firstComma = call.indexOf(",", argsStart);
    baseArg = call.slice(argsStart, firstComma).trim() + ", ";
  }
  const insertion = `, revision: await revOf(${baseArg}${roleExpr}, ${tokenExpr}) `;

  const patchedCall =
    call.slice(0, braceEnd - 1) + insertion + call.slice(braceEnd - 1);
  return { patchedCall, callStart, callEnd, route: routeMatch[2] };
}

function processFile(file) {
  const full = path.join(DIR, file);
  let src = fs.readFileSync(full, "utf8");
  const before = src;

  const patches = [];
  for (const route of ROUTES) {
    let idx = 0;
    while ((idx = src.indexOf(route + "`", idx)) !== -1) {
      const before80 = src.slice(Math.max(0, idx - 80), idx);
      if (before80.includes("roles/${")) {
        const callStart = src.lastIndexOf("api(", idx);
        const callEnd = matchParen(src, callStart + 3);
        if (callStart >= 0 && callEnd > 0) {
          const patched = patchCall(src, callStart, callEnd, file);
          if (patched) patches.push(patched);
        }
      }
      idx += route.length;
    }
  }

  // 从后往前替换，保证前面的偏移不失效
  patches.sort((a, b) => b.callStart - a.callStart);
  for (const p of patches) {
    src = src.slice(0, p.callStart) + p.patchedCall + src.slice(p.callEnd);
  }

  src = addRevOf(src, file);
  if (src !== before) {
    // 补 require
    if (!src.includes("revOfWith")) {
      throw new Error(`${file}: revOf 插进去了但没引 revOfWith`);
    }
    if (!src.includes('require("./lib/role-save.cjs")')) {
      throw new Error(`${file}: 需要先手工加 require("./lib/role-save.cjs")`);
    }
    fs.writeFileSync(full, src);
  }
  return patches.length;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".cjs") && FOUR_ARG.has(f)) .concat(
  ["e2e-role-fashion.cjs", "e2e-roles.cjs"],
);
let total = 0;
for (const file of files) {
  const n = processFile(file);
  total += n;
  console.log(`${file}: ${n} 处`);
}
console.log(`合计 ${total} 处`);
