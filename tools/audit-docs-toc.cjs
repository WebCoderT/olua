/**
 * 文档目录表审计（docs TOC audit）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `docs/README.md` 的目录表里有一列「行数」，它是读者判断篇幅的唯一线索。
 * 但这一列从来没有人维护：2026-11-15 实测 **33/38 篇对不上**，最深的一篇
 * 差 200 行（`docs/15` 写 627、实际 826）。
 *
 * 这类数字有两个特点，注定靠人盯不住：
 *   1. 它不参与任何构建，写错了没有任何现象 —— 不加守点就是「永远绿」；
 *   2. 它随每一次正文编辑而变，**改文档的人根本不会想到还要回来改目录表**。
 *
 * 所以判据只能是「按磁盘现算」：目录表里声明的行数必须等于文件实际行数。
 * 修法不需要动脑：`node tools/audit-docs-toc.cjs --write` 一次重算。
 *
 * ===========================================================================
 * 判据（四类）
 * ===========================================================================
 *   A. 编号表行（`| 01 | [标题](./01-xxx.md) | 258 | …`）：声明的行数 == 实际行数；
 *      `wc -l` 口径（数换行符，末尾无换行不计）。
 *   B. 编号表行的序号 == 文件名前两位（`| 07 | […](./08-xxx.md) |` 必错，链接会指错篇）。
 *   C. 编号表 / 附录表里指向的文件必须存在。
 *   D. 双向完整：`docs/` 下每个 `NN-*.md` 必须出现在**编号表或附录表**之一
 *      （`docs/37` 这种故意不编号的篇目走「另有两篇不在编号内」那张表）。
 *      漏登记 = 读者从目录里永远看不到它（`docs/37` 是最该被看到的一篇，却漏了）。
 *
 * 用法：
 *   node tools/audit-docs-toc.cjs           # 只检查，有偏差即退出码 1
 *   node tools/audit-docs-toc.cjs --write   # 按磁盘实际行数重算目录表（唯一的修法）
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const README = path.join(DOCS, "README.md");

const WRITE = process.argv.includes("--write");

/** `| 01 | [标题](./01-xxx.md) | 258 | 摘要 | 何时看 |` */
const ROW_RE = /^\|\s*(\d{2})\s*\|\s*\[[^\]]*\]\(\.\/([^)]+)\)\s*\|\s*(\d+)\s*\|/;
/** `| [37-xxx.md](./37-xxx.md) | 摘要 |`（附录表：无行数列） */
const PLAIN_RE = /^\|\s*\[[^\]]*\]\(\.\/([^)]+)\)\s*\|/;

/** 与 `wc -l` 同口径：换行符个数 */
function countLines(abs) {
  const buf = fs.readFileSync(abs);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

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
      const [, num, file, claimed] = row;
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
      const real = countLines(abs);
      if (real !== Number(claimed)) {
        if (WRITE) {
          lines[i] = lines[i].replace(
            /(\]\(\.\/[^)]+\)\s*\|\s*)\d+(\s*\|)/,
            (_m, head, tail) => head + real + tail
          );
          fixed++;
        } else {
          problems.push(
            `${file}：目录表写 ${claimed} 行，实际 ${real} 行（差 ${real - Number(claimed)}）`
          );
        }
      }
      continue;
    }

    // 附录表（无行数）：只登记，不校验行数
    const plain = lines[i].match(PLAIN_RE);
    if (plain) {
      const file = plain[1];
      registered.add(file);
      if (!fs.existsSync(path.join(DOCS, file))) {
        problems.push(`附录表指向不存在的文件：${file}（第 ${i + 1} 行）`);
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
    console.log(`✔ 已重算 ${fixed} 篇的行数（docs/README.md）`);
  }

  if (problems.length) {
    console.error(`✘ docs/README.md 目录表与磁盘不一致（${problems.length} 处）`);
    for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
    if (problems.length > 40) console.error(`  … 还有 ${problems.length - 40} 处`);
    console.error("  处理：node tools/audit-docs-toc.cjs --write（重算行数后逐条核对其余问题）");
    process.exit(1);
  }

  console.log(
    `✔ docs/README.md 目录表：${rows} 篇编号 + ${registered.size - rows} 篇附录，行数与磁盘一致`
  );
}

main();
