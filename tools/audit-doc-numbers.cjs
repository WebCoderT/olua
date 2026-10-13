/**
 * 文档数字守卫（docs-numbers guard）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 文档里的「51 个接口 / 41 条路径 / 72 个模型」「26 套单测 + 9 套审计 + 876 条 e2e」
 * 这类数字**每加一个接口就漂一次**，而且漂了**没有任何一处会报错** ——
 * 读者拿到的是一份自信的、过期的数字。这跟 `battle-rules.generated.ts` 那类快照腐化
 * 是同一类问题，解法也一样：**别靠记性，靠脚本**。
 *
 * 历史：#81 重刷过 `docs/resume.md`，但没覆盖各端 README —— 于是 `server/README.md`
 * 与 `FAQ.md` 又落后了一两个版本，直到 #93 动接口时才被撞见。
 *
 * ===========================================================================
 * 检查什么（只查「有唯一实测来源」的数字）
 * ===========================================================================
 *   1. 接口总数 / 路径数 / 模型数 / 各分组数   ← `server/openapi.json`
 *   2. e2e 总数，以及括号里那串加数             ← 各 e2e 脚本的 `EXPECTED_ASSERTIONS`
 *   3. 审计脚本数 / 单测套数                    ← `tools/audit-*.cjs`、`client/tools/test-*.cjs`
 *
 * **不查**代码行数、文件数（`约 4.9 万行` 这种）—— 它们没有唯一口径（算不算注释、
 * 算不算生成物取决于心情），钉死了只会天天 FAIL。那类数字靠改代码时顺手看一眼。
 *
 * 数字与文本的对应靠**句式**：文档里承诺了口径的写法是固定的
 * （`X 个接口 / Y 条路径 / Z 个模型`、`N 条 e2e`、`X interfaces` …）。
 * 句式在 CHECKS 里集中登记，新增一种写法就往那儿加一行。
 *
 * 用法：node tools/audit-doc-numbers.cjs
 * 退出码：全部一致 = 0；任一处对不上 = 1（`make audit` 据此判定 FAIL）
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/** 受管文档（存在的才检查；中英双语都在，漏一个译本同样算漂） */
const DOCS = [
  "README.md",
  "README.en.md",
  "FAQ.md",
  "FAQ.en.md",
  "docs/resume.md",
  "server/README.md",
  "server/README.en.md",
  "server/FAQ.md",
  "server/FAQ.en.md",
  "admin/README.md",
  "admin/README.en.md",
  "admin/FAQ.md",
  "admin/FAQ.en.md",
  "client/README.md",
  "client/README.en.md",
  "client/FAQ.md",
  "client/FAQ.en.md",
];

/** e2e 脚本清单（顺序即 `docs/resume.md` 里括号中加数的推荐顺序） */
const E2E_SCRIPTS = [
  ["服务端主链路", "server/test/e2e.cjs"],
  ["角色管理", "server/test/e2e-roles.cjs"],
  ["守卫（口令/审计/限流/封禁/看板）", "server/test/e2e-guard.cjs"],
  ["邮件", "server/test/e2e-mail.cjs"],
  ["账号邮箱", "server/test/e2e-account-email.cjs"],
  ["实时通道", "server/test/e2e-realtime.cjs"],
  ["备份恢复", "server/test/backup.cjs"],
];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

//#region 实测

function measure() {
  const openapi = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "openapi.json"), "utf8"));

  let endpoints = 0;
  const groups = new Map();
  for (const operations of Object.values(openapi.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.includes(method)) continue;
      endpoints += 1;
      const tag = (operation.tags && operation.tags[0]) || "(未分组)";
      groups.set(tag, (groups.get(tag) || 0) + 1);
    }
  }

  return {
    endpoints,
    paths: Object.keys(openapi.paths).length,
    models: Object.keys(openapi.components?.schemas ?? {}).length,
    groups,
    e2e: E2E_SCRIPTS.map(([label, file]) => ({ label, file, count: expectedAssertionsOf(file) })),
    audits: countFiles(path.join(ROOT, "tools"), /^audit-.*\.cjs$/),
    unitTests: countFiles(path.join(ROOT, "client", "tools"), /^test-.*\.cjs$/),
  };
}

/** 从一个 e2e 脚本里读它的 `EXPECTED_ASSERTIONS`（那是「实测值」的唯一静态来源） */
function expectedAssertionsOf(relativePath) {
  const full = path.join(ROOT, relativePath);
  if (!fs.existsSync(full)) throw new Error(`e2e 脚本不存在：${relativePath}`);
  const source = fs.readFileSync(full, "utf8");
  const matched = source.match(/const EXPECTED_ASSERTIONS = (\d+);/);
  if (!matched) {
    throw new Error(
      `${relativePath} 里没有 \`const EXPECTED_ASSERTIONS = <数字>;\` ——\n` +
        "  这个常量是文档数字的唯一来源，删了它本审计就无从比对（不是「没有数字就不查」）。",
    );
  }
  return Number(matched[1]);
}

function countFiles(dir, pattern) {
  return fs.readdirSync(dir).filter((name) => pattern.test(name)).length;
}

//#endregion

//#region 检查

const failures = [];
let passed = 0;

function ok(label) {
  passed += 1;
  void label;
}

function fail(label, detail) {
  failures.push(detail ? `${label}：${detail}` : label);
}

/**
 * 在一份文档里按正则抓所有数字，每一个都必须等于期望值
 *
 * 抓不到不是失败 —— 这份文档可能压根没提这个数（比如 FAQ 不谈模型数）。
 * 但**抓到了就必须对**。
 */
function checkNumbers(doc, source, label, pattern, expected) {
  const found = [...source.matchAll(pattern)];
  for (const match of found) {
    const value = Number(match[1]);
    if (value === expected) {
      ok(`${doc} ${label}`);
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    fail(`${doc}:${line} 的「${label}」与实测不一致`, `文档写 ${value}，实测 ${expected}`);
  }
}

/**
 * e2e 加数串：括号里 `a + b + c …`，**和**与**集合**都要对得上
 *
 * 两种写法都要认：`服务端 876 条 e2e（248 + …）` 与 `服务端 e2e（248 + … 条）`
 * —— 所以数字串后面还允许跟几个字（单位「条」就落在那里）。
 *
 * **项数必须恰好等于 e2e 套数**：不加这个约束，文档里任何 `（1 + 2 + 3）`
 * 都会被当成加数串误报。
 */
function checkE2eBreakdown(doc, source, expected) {
  const total = expected.e2e.reduce((sum, item) => sum + item.count, 0);
  const expectedCounts = expected.e2e
    .map((item) => item.count)
    .sort((a, b) => a - b)
    .join("+");

  const pattern = /[（(]\s*(\d+(?:\s*\+\s*\d+)+)\s*[^（()）]{0,8}[)）]/g;
  for (const match of [...source.matchAll(pattern)]) {
    const counts = match[1]
      .split("+")
      .map((piece) => Number(piece.trim()))
      .sort((a, b) => a - b);
    if (counts.length !== expected.e2e.length) continue;
    const sum = counts.reduce((total2, value) => total2 + value, 0);
    if (sum === total && counts.join("+") === expectedCounts) {
      ok(`${doc} e2e 加数串`);
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    fail(
      `${doc}:${line} 的 e2e 加数串与实测不一致`,
      `文档写 ${match[1].replace(/\s/g, "")}（和 ${sum}），实测 ${expected.e2e.map((item) => item.count).join(" + ")}（和 ${total}）`,
    );
  }
}

/**
 * 分组表的一行：`| <header> | <数量> |`，数量必须等于 openapi 里该 tag 的接口数
 *
 * 只对**中文**表头（公共接口 / 客户端 / 管理端）做这个检查：英文表头是
 * `Public` / `Client` / `Admin`，太通用（`| Admin | 3 |` 完全可能是「3 种管理员角色」），
 * 无条件扫会误报。英文那份交给 `audit-docs-en` 的数字 multiset 比对兜着 ——
 * 中文对了它就对，中英一起错会被它抓出来。
 */
function checkGroupRow(doc, source, header, groupLabel, expected) {
  const want = expected.groups.get(groupLabel);
  if (want === undefined) return;
  const pattern = new RegExp(`\\|\\s*${header}\\s*\\|\\s*(\\d+)\\s*\\|`, "g");
  for (const match of [...source.matchAll(pattern)]) {
    const value = Number(match[1]);
    if (value === want) {
      ok(`${doc} 分组 ${groupLabel}`);
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    fail(`${doc}:${line} 分组「${groupLabel}」的数量与实测不一致`, `文档写 ${value}，实测 ${want}`);
  }
}

//#endregion

function main() {
  const expected = measure();

  for (const doc of DOCS) {
    const full = path.join(ROOT, doc);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, "utf8");

    // 1. 接口 / 路径 / 模型（中英两种句式都认）
    checkNumbers(doc, source, "接口总数", /(\d+)\s*个(?:REST\s+)?接口/g, expected.endpoints);
    checkNumbers(doc, source, "接口总数（英文）", /(\d+)\s+interfaces?\b/g, expected.endpoints);
    checkNumbers(doc, source, "路径数", /(\d+)\s*条路径/g, expected.paths);
    checkNumbers(doc, source, "路径数（英文）", /(\d+)\s+paths?\b/g, expected.paths);
    checkNumbers(doc, source, "模型数", /(\d+)\s*个模型/g, expected.models);
    checkNumbers(doc, source, "模型数（英文）", /(\d+)\s+models?\b/g, expected.models);

    // 2. 分组表（`| 公共接口 | 6 |`）
    for (const header of ["公共接口", "客户端", "管理端"]) {
      checkGroupRow(doc, source, header, header, expected);
    }

    // 3. e2e 总数与加数串
    const e2eTotal = expected.e2e.reduce((sum, item) => sum + item.count, 0);
    checkNumbers(doc, source, "e2e 总数", /(\d+)\s*条(?:服务端\s*)?e2e/g, e2eTotal);
    checkNumbers(doc, source, "e2e 总数（英文）", /(\d+)\s+(?:server\s+)?e2e\b/gi, e2eTotal);
    checkE2eBreakdown(doc, source, expected);

    // 4. 审计脚本数 / 单测套数
    checkNumbers(doc, source, "审计脚本数", /(\d+)\s*套审计(?:脚本)?/g, expected.audits);
    checkNumbers(doc, source, "单测套数", /(\d+)\s*套单测/g, expected.unitTests);
    checkNumbers(doc, source, "审计脚本数（英文）", /(\d+)\s+audit\s+scripts?/gi, expected.audits);
    checkNumbers(doc, source, "单测套数（英文）", /(\d+)\s+unit\s+tests?/gi, expected.unitTests);
  }

  // 中文数字写法（「八个审计脚本」）单独校验 —— 正则抓不到，只能按字面找
  for (const doc of DOCS) {
    const full = path.join(ROOT, doc);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, "utf8");
    const numerals = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    for (const match of [...source.matchAll(/([一二三四五六七八九十])个审计/g)]) {
      const value = numerals[match[1]];
      if (value === expected.audits) {
        ok(`${doc} 「${match[1]}个审计」`);
        continue;
      }
      const line = source.slice(0, match.index).split("\n").length;
      fail(`${doc}:${line} 的「${match[1]}个审计」与实测不一致`, `文档写 ${value}，实测 ${expected.audits}`);
    }
  }

  //#region 汇总

  console.log(`实测：${expected.endpoints} 个接口 / ${expected.paths} 条路径 / ${expected.models} 个模型`);
  console.log(
    `      ${expected.unitTests} 套单测 · ${expected.audits} 个审计 · ${expected.e2e.reduce((sum, item) => sum + item.count, 0)} 条 e2e（${expected.e2e
      .map((item) => item.count)
      .join(" + ")}）`,
  );
  for (const [tag, count] of expected.groups) console.log(`      分组「${tag}」${count}`);

  if (failures.length === 0) {
    console.log(`\n✔ 文档数字与实测一致（比对 ${passed} 处）`);
    return;
  }

  console.log(`\n✗ 文档里有 ${failures.length} 处数字与实测对不上：\n`);
  failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  console.log("\n  修法只有一种：把文档里的数字改成实测值（上面「实测」那几行）。");
  process.exit(1);
}

main();
