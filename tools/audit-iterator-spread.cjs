/**
 * 迭代器展开审计（iterator spread audit）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 客户端打 web 包走的是 **babel loose**：`[...map.values()]` 被转成
 * `[].concat(map.values())`，而 `Array.prototype.concat` **不展开非数组**——
 * 它把一个 Map 迭代器当成单个元素塞进数组。结果是：
 *
 *   - `[...peers.values()]` → `[MapIterator]`，调用方遍历拿到的是迭代器本身，
 *     每条「数据」的字段全是 undefined（#471：私聊选人页永远多一行空名字的幽灵行）；
 *   - `for (const id of [...this.map.keys()])` → 循环体只执行一次且 `id` 是迭代器，
 *     `remove(id)` / `detach(id)` 一个都没删掉 —— **清理路径静默失效**（换图残留幽灵玩家、
 *     状态特效永不过期）。
 *
 * 这几处 tsc 全绿、源码读起来也对，只有构建产物里才错，**跑真机才会看见**。
 * 所以判据不能是「看起来没问题」，得在静态阶段就把 `[...迭代器]` 判死：
 * 客户端要遍历 Map / Set，一律 `Array.from(...)`。
 *
 * 反例（本次实测踩到，产物里就是 `[].concat(...)`）：
 *   client/assets/ui/core/ChatStore.ts        return [...peers.values()];
 *   client/assets/ui/core/OtherPlayerManager.ts  of [...this.others.keys()]
 *   client/assets/ui/core/MonsterManager.ts   of [...this.statusEffects]
 *   client/assets/ui/core/QuestNpcMarks.ts    of [...this.marks.keys()]
 *
 * ===========================================================================
 * 判据（三类）
 * ===========================================================================
 *   A. `[...x.keys() / .values() / .entries()]` —— 一定是迭代器，必错；
 *   B. `[...new Map( ... / new Set(` —— new Map/Set 也是可迭代对象，必错；
 *   C. `[...this.字段]` / `[...字段]`（单独展开一个字段，后面不是方法调用）——
 *      字段是数组还是 Map/Set，静态看不出来，**列进报告逐条核对**：
 *      是数组就登记到 tools/iterator-spread-allowlist.json（附原因），是 Map 就改 Array.from。
 *
 * 用法：
 *   node tools/audit-iterator-spread.cjs          # 报告 + 退出码（有未处理项即 1）
 *   node tools/audit-iterator-spread.cjs --json   # 输出 JSON
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "client", "assets");
const ALLOW_FILE = path.join(__dirname, "iterator-spread-allowlist.json");

const args = process.argv.slice(2);
const MODE = { json: args.includes("--json") };

/** 规则：id / 说明 / 正则（命中即报，A、B 为硬错误，C 需人工核对后登记） */
const RULES = [
  {
    id: "iterator-method",
    label: "展开 keys()/values()/entries()",
    hard: true,
    test: /\[\.\.\.[^\]]*\.(keys|values|entries)\(\)/,
  },
  {
    id: "new-collection",
    label: "展开 new Map()/new Set()",
    hard: true,
    test: /\[\.\.\.new\s+(Map|Set)\s*\(/,
  },
  {
    id: "bare-member",
    label: "展开一个字段（需核对是数组还是 Map/Set）",
    hard: false,
    // [...this.xxx] / [...xxx] / [...xxx,  —— 后面跟的不是 "(" （方法调用返回数组则不算）
    test: /\[\.\.\.(this\.)?[A-Za-z_][\w.]*\s*[,)\]]/,
  },
];

/** 递归收集 .ts（跳过 .meta 与声明文件） */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const allow = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")) : { entries: [] };
const isAllowed = (rel, line) =>
  allow.entries.some((e) => e.file === rel && line.includes(e.snippet));

const files = collect(ASSETS);
const findings = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return; // 注释里的反例不算
    for (const rule of RULES) {
      if (!rule.test.test(line)) continue;
      if (isAllowed(rel, line)) continue;
      findings.push({ file: rel, line: i + 1, rule: rule.id, hard: rule.hard, snippet: line.trim() });
    }
  });
}

if (MODE.json) {
  console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

console.log(`扫描 ${files.length} 个客户端 .ts，命中 ${findings.length} 处（例外清单 ${allow.entries.length} 条）`);
if (findings.length) {
  console.log("");
  for (const f of findings) {
    console.log(`- ${f.file}:${f.line}  [${f.rule}]`);
    console.log(`    ${f.snippet}`);
  }
  console.log("");
  console.log("改法：遍历 Map / Set 一律用 Array.from(...)；确实在展开数组的，登记到");
  console.log("      tools/iterator-spread-allowlist.json（附一句为什么它是数组）。");
  console.log(`FAIL：${findings.length} 处展开写法会在 babel loose 下失效`);
  process.exit(1);
}
console.log("PASS：客户端没有展开迭代器的写法（Map/Set 全走 Array.from）");
