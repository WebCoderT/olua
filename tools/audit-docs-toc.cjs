/**
 * 文档目录表审计（docs TOC audit）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `docs/README.md` 的目录表是读者唯一的入口索引，它有三类「手写就会错、错了没有任何
 * 现象」的东西：
 *
 *   1. **序号** —— `| 07 | […](./08-xxx.md) |` 链到别篇，读者点进去看到的是另一篇；
 *   2. **登记** —— 新加一篇 `NN-*.md` 忘了写进目录表，读者从目录里永远看不到它
 *      （`docs/37` 这个「最高优先单一来源」曾长期只出现在附录里）；
 *   3. **接口数** —— 一条线加了接口、`docs/14` 自动重生成，README 第五节的
 *      「N 个接口」还停在旧数（#1042 就是这么漏的）。
 *
 * ===========================================================================
 * 曾经还守过「行数」，2026-11-15 删掉了（#1045）
 * ===========================================================================
 * 目录表曾经有一列「行数」，实测 32/38 篇过期（`docs/15` 差 199 行）。加了守点后
 * **首跑就红**（#1042）—— 不是守点写错，而是它在 worktree 里算完还没合并，另一条线
 * 改了 5 篇文档。
 *
 * 结论：行数是唯一「改任何一篇正文的一个字都可能变」的派生数字，冲突面 100%，
 * 每个改文档的 PR 都要连带动一行 README，多会话并行下「算完 → 合并」必然漂移。
 * **派生数字要么精确维护、要么不写** —— 写一个「大致准」的行数就是假精确，
 * 所以那一列直接删掉，篇幅信息由「讲什么 / 什么时候读」两列承担。
 *
 * 对比剩下的接口数：只在加/删接口时变（低频），且本就是「该跟上」的语义数字，
 * 维护成本可接受，所以留着。
 *
 * ===========================================================================
 * 判据（四类）
 * ===========================================================================
 *   A. 编号表行 `| 01 | [标题](./01-xxx.md) | 摘要 |`：序号 == 文件名前两位。
 *   B. 编号表 / 附录表里指向的文件必须存在。
 *   C. 双向完整：`docs/` 下每个 `NN-*.md` 必须出现在**编号表或附录表**之一
 *      （`docs/37` 这种故意不编号的篇目走「另有两篇不在编号内」那张表）。
 *   D. 接口数：README 第五节的「N 个接口」/「N 个 admin 接口」必须等于
 *      `server/openapi.json` 现算（operationId 总数 / `/admin` 前缀操作数）。
 *
 * 用法：
 *   node tools/audit-docs-toc.cjs           # 只检查，有偏差即退出码 1
 *   node tools/audit-docs-toc.cjs --write   # 重算接口数（守点里唯一的派生数字）
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const README = path.join(DOCS, "README.md");

const WRITE = process.argv.includes("--write");

/** `| 01 | [标题](./01-xxx.md) | 摘要 | 何时读 |`（只取序号与链接，不依赖列数） */
const ROW_RE = /^\|\s*(\d{2})\s*\|\s*\[[^\]]*\]\(\.\/([^)]+)\)\s*\|/;
/** `| [37-xxx.md](./37-xxx.md) | 摘要 |`（附录表：无序号） */
const PLAIN_RE = /^\|\s*\[[^\]]*\]\(\.\/([^)]+)\)\s*\|/;

function main() {
  const md = fs.readFileSync(README, "utf8");
  const lines = md.split("\n");

  const problems = [];
  const registered = new Set();
  let rows = 0;
  let fixed = 0;

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].match(ROW_RE);
    if (row) {
      const [, num, file] = row;
      rows++;
      registered.add(file);
      const abs = path.join(DOCS, file);
      if (!fs.existsSync(abs)) {
        problems.push(`目录表指向不存在的文件：${file}（第 ${i + 1} 行）`);
        continue;
      }
      const prefix = path.basename(file).slice(0, 2);
      if (prefix !== num) {
        problems.push(`序号与文件名不一致：第 ${i + 1} 行写 ${num}，指向 ${file}`);
      }
      continue;
    }

    // 附录表（无序号）：只登记与存在性
    const plain = lines[i].match(PLAIN_RE);
    if (plain) {
      const file = plain[1];
      registered.add(file);
      if (!fs.existsSync(path.join(DOCS, file))) {
        problems.push(`附录表指向不存在的文件：${file}（第 ${i + 1} 行）`);
      }
    }
  }

  // ── 接口数 ──────────────────────────────────────────────────────
  // 手写复制到 README 第五节的派生数字。#1042 就是这么漏的 —— 一条线加了 2 个接口、
  // `docs/14` 自动重新生成了，README 的手写值还停在旧数。
  const openapiPath = path.join(ROOT, "server", "openapi.json");
  if (fs.existsSync(openapiPath)) {
    const openapi = JSON.parse(fs.readFileSync(openapiPath, "utf8"));
    const HTTP = new Set(["get", "post", "patch", "put", "delete"]);
    let total = 0;
    let admin = 0;
    for (const [p, ops] of Object.entries(openapi.paths)) {
      for (const [m, op] of Object.entries(ops)) {
        if (!HTTP.has(m) || !op || !op.operationId) continue;
        total++;
        if (p.startsWith("/admin")) admin++;
      }
    }
    for (const d of [
      { key: "个接口", value: total, note: "operationId 总数" },
      { key: "个 admin 接口", value: admin, note: "/admin 前缀的操作数" },
    ]) {
      const re = new RegExp("^\\| (\\d+) " + d.key + " \\|", "m");
      const at = lines.findIndex((l) => re.test(l));
      if (at < 0) {
        problems.push(`docs/README 里找不到「${d.key}」的声明行（守点会静默失效，必须补回）`);
        continue;
      }
      const claimed = Number(lines[at].match(re)[1]);
      if (claimed !== d.value) {
        if (WRITE) {
          lines[at] = lines[at].replace(re, `| ${d.value} ${d.key} |`);
          fixed++;
        } else {
          problems.push(
            `README 声明 ${claimed} ${d.key}，openapi.json ${d.note} 实算 ${d.value}（差 ${d.value - claimed}）`
          );
        }
      }
    }
  }

  // 双向完整：docs 下每个 NN-*.md 都要被登记（README 自身除外）
  const missing = fs
    .readdirSync(DOCS)
    .filter((f) => /^\d{2}-.*\.md$/.test(f) && !registered.has(f));
  if (missing.length) {
    problems.push(`docs/ 下有未登记进目录表的篇目：${missing.join("、")}`);
  }

  if (WRITE && fixed) {
    fs.writeFileSync(README, lines.join("\n"), "utf8");
    console.log(`✔ 已按 openapi.json 重算 ${fixed} 处接口数（docs/README.md）`);
  }

  if (problems.length) {
    console.error(`✘ docs/README.md 目录表与磁盘不一致（${problems.length} 处）`);
    for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
    if (problems.length > 40) console.error(`  … 还有 ${problems.length - 40} 处`);
    console.error("  处理：接口数用 node tools/audit-docs-toc.cjs --write；其余逐条手工核对");
    process.exit(1);
  }

  console.log(
    `✔ docs/README.md：${rows} 篇编号 + ${registered.size - rows} 篇附录，序号 / 登记 / 接口数均与磁盘一致`
  );
}

main();
