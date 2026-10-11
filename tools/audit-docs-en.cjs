/**
 * 英文文档守卫（English-docs guard）
 *
 * 背景：中英两份文档如果没人盯着，下一次改中文时英文会留在旧版本、而且不会报错。
 * 这个仓库的惯例是把坑变成脚本 —— 本脚本把所有「译本会不会和原文走散」的判据
 * 固化下来，接入 `make audit`（自动发现，无需改循环）。
 *
 * 检查项（对应 #39 的验收清单）：
 *   0. 覆盖 + 孤儿：受管中文文档都要有 .en.md；反之仓库里出现 .en.md 也必须能
 *      对上一个中文版，孤儿文件直接报错
 *   1. 残留中文：英文版不得出现 CJK（含带圈数字 ①-⑳）；专有名词若确需保留走白名单，
 *      这里不放宽成「包含中文也放行」。语言互链那一行（`[简体中文](X.md)`）豁免
 *   2. 章节等价：两份的标题（#~######）数量一致、顺序一致 —— 最省事的「整段漏译」探针
 *   3. 数字不丢：两份里出现的数字各抽一遍 multiset，必须完全相等（翻译最容易在长句里
 *      吞掉一个数量）。带圈数字 / 全角数字归一，万 / 亿展开，千分位逗号去掉 —— 三者都
 *      是「同一个值换了写法」，不是事实差异；行首有序列表序号（1. 2. 3.）是排版不是事实，
 *      计数前摘掉
 *   4. 同文件锚点可达：两份里 `#anchor` 链接必须都有对应标题
 *   5. 相对链接可达：两份里的相对链接目标必须真实存在
 *   6. 互链：中文顶部与英文顶部各有一行指向对方的语言切换链接
 *
 * 用法：
 *   node tools/audit-docs-en.cjs            # 报告 + 退出码（有未通过项即 1）
 *
 * 退出码：全部通过 = 0；任一检查不通过 = 1（`make audit` 据此判定 FAIL）
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 受管文档对：中文（保留主体）+ 英文（译本）。这是唯一来源，其余检查都基于它。
const PAIRS = [
  ["README.md", "README.en.md"],
  ["FAQ.md", "FAQ.en.md"],
  ["equip-aligner/README.md", "equip-aligner/README.en.md"],
  ["admin/README.md", "admin/README.en.md"],
  ["admin/FAQ.md", "admin/FAQ.en.md"],
  ["client/README.md", "client/README.en.md"],
  ["client/FAQ.md", "client/FAQ.en.md"],
  ["server/README.md", "server/README.en.md"],
  ["server/FAQ.md", "server/FAQ.en.md"],
];

// 已知文档目录（用于孤儿检测，非递归即可，受管文档都直接落在这些目录里）
const DOC_DIRS = [".", "client", "admin", "server", "equip-aligner"];

// GitHub 的锚点算法：标点去掉后，每个空格各换成一个连字符（不合并连续空格）
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

const headings = (s) =>
  s
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim());

/**
 * 数字归一：三种「同一个值换了个写法」的差异，都不该判成翻译问题
 *
 * 1. 带圈数字 ①②③ / 全角数字 ０１ → 阿拉伯数字（中文写「①」，英文自然写「(1)」）
 * 2. 千分位逗号 → 去掉（英文写 40,000，数字 multiset 里会被切成 40 与 000）
 * 3. 中文数量单位展开：4 万 → 40000（**这条能抓真错** —— 把「4 万」译成 4,000
 *    是数量级事故，而它恰好也只差一个 0，放宽检查的话正好放它过去）
 */
const normalizeDigits = (s) =>
  s
    .replace(/[①-⑳]/g, (c) => String(c.codePointAt(0) - 0x2460 + 1))
    .replace(/[０-９]/g, (c) => String(c.codePointAt(0) - 0xff10))
    .replace(/(\d)\s*亿/g, (_, d) => `${d}00000000`)
    .replace(/(\d)\s*万/g, (_, d) => `${d}0000`)
    .replace(/(\d),(\d)/g, "$1$2");

let bad = 0;
const fail = (msg) => {
  console.log("FAIL " + msg);
  bad++;
};

// ---------------------------------------------------------------------------
// 0) 覆盖 + 孤儿
// ---------------------------------------------------------------------------
const expectedEn = new Set(PAIRS.map(([, e]) => e));
for (const [z, e] of PAIRS) {
  if (!fs.existsSync(path.join(ROOT, z))) fail("中文文档缺失：" + z);
  if (!fs.existsSync(path.join(ROOT, e))) fail("英文文档缺失（覆盖检查）：" + e);
}
// 孤儿：仓库里出现 .en.md 但不在受管集合（没有对应中文版）
const foundEn = new Set();
for (const d of DOC_DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".en.md")) foundEn.add(path.join(d, f).split(path.sep).join("/"));
  }
}
for (const e of foundEn) {
  if (!expectedEn.has(e)) fail("孤儿英文文档（没有对应中文版）：" + e);
}

// ---------------------------------------------------------------------------
// 逐对检查 1)~6)
// ---------------------------------------------------------------------------
for (const [zh, en] of PAIRS) {
  console.log("=== " + zh + "  <->  " + en + " ===");
  const zp = path.join(ROOT, zh),
    ep = path.join(ROOT, en);
  if (!fs.existsSync(zp) || !fs.existsSync(ep)) continue; // 覆盖检查已报，这里跳过避免崩
  const zs = fs.readFileSync(zp, "utf8"),
    es = fs.readFileSync(ep, "utf8");

  // 1) 英文版不得残留 CJK（含带圈数字 ①-⑳）；语言互链那一行豁免（它本就该写「简体中文」）
  const esNoSwitch = es
    .split("\n")
    .filter((l) => !l.includes(`(${path.basename(zh)})`))
    .join("\n");
  const cjk = [...esNoSwitch.matchAll(/[　-〿㐀-䶿一-鿿＀-￯①-⑳]/g)];
  if (cjk.length) {
    const around = cjk
      .slice(0, 5)
      .map((m) => JSON.stringify(esNoSwitch.slice(Math.max(0, m.index - 30), m.index + 30)));
    fail("英文版残留 CJK " + cjk.length + " 处：\n    " + around.join("\n    "));
  }

  // 2) 章节数量与顺序
  const zh1 = headings(zs),
    en1 = headings(es);
  if (zh1.length !== en1.length) {
    fail(`章节数不一致：中文 ${zh1.length} / 英文 ${en1.length}`);
    const max = Math.max(zh1.length, en1.length);
    for (let i = 0; i < max; i++)
      if (zh1[i] !== en1[i]) console.log(`    [${i}] 中「${zh1[i]}」 英「${en1[i]}」`);
  }

  // 3) 数字 multiset 完全相等（差异逐条打印上下文）
  // 行首有序列表序号（1. 2. 3.）是排版不是事实，计数前先摘掉
  const stripListMarks = (s) => s.replace(/^\s*\d+\.\s+/gm, "");
  const zhBody = stripListMarks(normalizeDigits(zs)),
    enBody = stripListMarks(normalizeDigits(es));
  const zRes = [],
    eRes = [];
  for (const m of zhBody.matchAll(/\d+(?:\.\d+)?/g)) zRes.push({ v: m[0], i: m.index });
  for (const m of enBody.matchAll(/\d+(?:\.\d+)?/g)) eRes.push({ v: m[0], i: m.index });
  if (zRes.length === 0 || eRes.length === 0)
    fail("数字提取为空 —— 检查脚本自身有问题，别信它的结果");
  const cnt = (arr) => arr.reduce((a, x) => ((a[x.v] = (a[x.v] || 0) + 1), a), {});
  const cz = cnt(zRes),
    ce = cnt(eRes);
  const keys = new Set([...Object.keys(cz), ...Object.keys(ce)]);
  for (const k of keys) {
    const d = (cz[k] || 0) - (ce[k] || 0);
    if (d === 0) continue;
    const side = d > 0 ? zs : es;
    const res = d > 0 ? zRes : eRes;
    const where = res
      .filter((x) => x.v === k)
      .slice(0, 2)
      .map((x) =>
        JSON.stringify(side.slice(Math.max(0, x.i - 35), x.i + 35)).replace(/\\n/g, " ")
      );
    console.log(`  数字「${k}」${d > 0 ? "中文多" : "英文多"} ${Math.abs(d)} 次：`);
    where.forEach((w) => console.log("      " + w));
    bad++;
  }

  // 4) 同文件内锚点必须可达
  const anchors = new Set(headings(es).map(slug));
  for (const m of es.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!anchors.has(m[1])) fail("英文版死锚点：#" + m[1]);
  }
  const zhAnchors = new Set(headings(zs).map(slug));
  for (const m of zs.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!zhAnchors.has(m[1])) fail("中文版死锚点：#" + m[1]);
  }

  // 5) 相对链接目标必须存在（剥掉 #anchor 与 http 链接）
  for (const [src, body] of [
    [en, es],
    [zh, zs],
  ]) {
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1];
      if (/^https?:/.test(raw) || raw.startsWith("#")) continue;
      const filePart = raw.split("#")[0];
      if (!filePart) continue;
      const target = path.join(path.dirname(path.join(ROOT, src)), filePart);
      if (!fs.existsSync(target)) fail(`${src} 里的链接目标不存在：${raw}`);
    }
  }

  // 6) 互链必须存在
  if (!zs.includes(`(${path.basename(en)})`)) fail(zh + " 缺指向英文版的互链");
  if (!es.includes(`(${path.basename(zh)})`)) fail(en + " 缺指向中文版的互链");
}

console.log(bad === 0 ? "\n全部检查通过" : `\n共 ${bad} 项不通过`);
process.exit(bad === 0 ? 0 : 1);
