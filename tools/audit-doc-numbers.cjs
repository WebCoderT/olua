/**
 * 文档数字守卫（docs-numbers guard）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 文档里的「52 个接口 / 42 条路径 / 73 个模型」「26 套单测 + 9 套审计 + 926 条 e2e」
 * 这类数字**每加一个接口就漂一次**，而且漂了**没有任何一处会报错** ——
 * 读者拿到的是一份自信的、过期的数字。这跟 `battle-rules.generated.ts` 那类快照腐化
 * 是同一类问题，解法也一样：**别靠记性，靠脚本**。
 *
 * 历史：#81 重刷过 `docs/resume.md`，但没覆盖各端 README —— 于是 `server/README.md`
 * 与 `FAQ.md` 又落后了一两个版本，直到 #93 动接口时才被撞见。
 *
 * #113 又发现**守卫自己**漏得比想象中多：句式都是照着「当时那一行文本」写的正则，
 * 于是同一件事换种写法就抓不到 —— `51 个 REST 接口`（`个` 后有空格）、`8 个跨端审计脚本`
 * （量词是「个」不是「套」）、`9 audits` / `26 unit-test suites`、
 * `（248 / 110 / …）`（分隔符是斜杠不是加号）全都漏检；加数串**项数不符**时还被
 * `continue` 静默放行，等于「加了一套 e2e」永远没人知道。教训两条：
 * **写句式要按「同义写法」想，不是按眼前这一行抄**；**「抓不到」与「通过」必须区分开**。
 *
 * ===========================================================================
 * 检查什么（只查「有唯一实测来源」的数字）
 * ===========================================================================
 *   1. 接口总数 / 路径数 / 模型数 / 各分组数 / 权限点数
 *                              ← `server/openapi.json`、`common/constants/permission.ts`
 *   2. e2e 总数，以及括号里那串加数（**和、集合、项数**三者都要对）
 *                              ← 各 e2e 脚本的 `EXPECTED_ASSERTIONS`
 *   3. 审计脚本数 / 单测套数 / 回归守卫总数（= 前两者之和）
 *                              ← `tools/audit-*.cjs`、`client/tools/test-*.cjs`
 *
 * **不查**代码行数、文件数（`约 4.9 万行` 这种）—— 它们没有唯一口径（算不算注释、
 * 算不算生成物取决于心情），钉死了只会天天 FAIL。那类数字靠改代码时顺手看一眼。
 *
 * 数字与文本的对应靠**句式**：文档里承诺了口径的写法是固定的
 * （`X 个接口 / Y 条路径 / Z 个模型`、`N 条 e2e`、`X interfaces` …）。
 * 句式集中登记在 `main()` 里（`checkNumbers` / `checkE2eBreakdown` / `checkGroupRow` 的调用处），
 * 新增一种写法就往那儿加一行 —— **加的时候先想同义写法**（量词 / 空格 / 连字符 / 单位）。
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
    permissions: countPermissionPoints(),
  };
}

/**
 * 权限点数：`server/src/common/constants/permission.ts` 里 `Permission` 对象有几项
 *
 * 这个文件的注释自己写着「唯一来源」，`docs/resume.md` 的口径说明也把它列为权限点的出处 ——
 * 但脚本此前压根没查它，于是 `server/README.md` 写 17、实际 18 这件事没人发现。
 */
function countPermissionPoints() {
  const relative = "server/src/common/constants/permission.ts";
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) throw new Error(`权限点的唯一来源不存在：${relative}`);
  const source = fs.readFileSync(full, "utf8");
  // 权限点对象的每一项长得像 `  ACCOUNT_READ: "account:read",`（两空格缩进的 `大写键: "资源:动作"`）
  const matched = source.match(/^ {2}[A-Z][A-Z0-9_]*:\s*"[a-z]+:[a-z]+",$/gm) ?? [];
  if (matched.length === 0) {
    throw new Error(
      `${relative} 里解析不出权限点 —— 这个文件的写法变了？\n` +
        "  权限点数的唯一来源就是它，解析不到就不该静默按 0 处理（那会让所有文档一起「对」上）。",
    );
  }
  return matched.length;
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
 * 三种写法都要认（文档里历史上三种都出现过）：
 *   - `服务端 e2e（248 + 110 + … 条）`   —— 数字串后还跟单位「条」
 *   - `服务端 876 条 e2e（248 + 110 + …）` —— 总数写在括号外
 *   - `六套 e2e（248 / 110 / …）`        —— 分隔符是斜杠，不是加号
 *
 * 两处约束挡住误报：
 *   1. 括号前 8 字内必须提到 `e2e` —— 否则文档里任何 `（1 + 2 + 3）` 都会被当成加数串；
 *   2. **项数必须恰好等于 e2e 套数** —— 项数不符同样是漂移（曾经加了一套而没人发现，
 *      因为旧版实现遇到项数不符直接 `continue` 了，等于放行）。
 */
function checkE2eBreakdown(doc, source, expected) {
  const total = expected.e2e.reduce((sum, item) => sum + item.count, 0);
  const expectedCounts = expected.e2e
    .map((item) => item.count)
    .sort((a, b) => a - b)
    .join("+");

  // 尾部允许 14 字：中文只跟一个「条」，英文要跟「 assertions」。
  const pattern = /e2e[^（()）\n]{0,10}[（(]\s*(\d+(?:\s*[+/]\s*\d+)+)\s*[^（()）]{0,14}[)）]/gi;
  for (const match of [...source.matchAll(pattern)]) {
    const counts = match[1]
      .split(/[+/]/)
      .map((piece) => Number(piece.trim()))
      .sort((a, b) => a - b);
    const line = source.slice(0, match.index).split("\n").length;
    if (counts.length !== expected.e2e.length) {
      fail(
        `${doc}:${line} 的 e2e 加数串项数与实测不一致`,
        `文档写 ${counts.length} 项（${match[1].replace(/\s/g, "")}），实测 ${expected.e2e.length} 套（${expected.e2e
          .map((item) => item.count)
          .join(" + ")}）`,
      );
      continue;
    }
    const sum = counts.reduce((total2, value) => total2 + value, 0);
    if (sum === total && counts.join("+") === expectedCounts) {
      ok(`${doc} e2e 加数串`);
      continue;
    }
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
    //    `个\s*` 而不是 `个` —— 文档里既有「51 个接口」也有「51 个 REST 接口」，
    //    中间那个空格曾经让这条例行长年漏检（`docs/resume.md` 因此一直写着旧数字）。
    checkNumbers(doc, source, "接口总数", /(\d+)\s*个\s*(?:REST\s+)?接口/g, expected.endpoints);
    checkNumbers(doc, source, "接口总数（英文）", /(\d+)\s+interfaces?\b/g, expected.endpoints);
    checkNumbers(doc, source, "路径数", /(\d+)\s*条路径/g, expected.paths);
    checkNumbers(doc, source, "路径数（英文）", /(\d+)\s+paths?\b/g, expected.paths);
    checkNumbers(doc, source, "模型数", /(\d+)\s*个模型/g, expected.models);
    checkNumbers(doc, source, "模型数（英文）", /(\d+)\s+models?\b/g, expected.models);
    checkNumbers(doc, source, "权限点数", /(\d+)\s*个权限点/g, expected.permissions);
    checkNumbers(doc, source, "权限点数（英文）", /(\d+)\s+permission\s+points?/gi, expected.permissions);

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
    //    量词两种都认（`9 套审计` / `9 个跨端审计脚本`），`跨端` 是修饰语可省。
    checkNumbers(doc, source, "审计脚本数", /(\d+)\s*[套个](?:跨端)?审计(?:脚本)?/g, expected.audits);
    checkNumbers(doc, source, "单测套数", /(\d+)\s*套单测/g, expected.unitTests);
    // 英文量词两种都认：`9 audit scripts` 与 `9 audits`；单测那份还要容忍连字符
    // （`unit-test suites`）—— 就是这么写的，漏认等于没查。
    checkNumbers(doc, source, "审计脚本数（英文）", /(\d+)\s+audits?\b/gi, expected.audits);
    checkNumbers(doc, source, "单测套数（英文）", /(\d+)\s+unit[-\s]tests?\b/gi, expected.unitTests);

    // 5. 「回归守卫」= 单测套数 + 审计脚本数（一句概括全部自动化守卫的写法）
    checkNumbers(
      doc,
      source,
      "回归守卫总数",
      /(\d+)\s*个自动化回归守卫/g,
      expected.unitTests + expected.audits,
    );
    checkNumbers(
      doc,
      source,
      "回归守卫总数（英文）",
      /(\d+)\s+automated\s+regression\s+guards?/gi,
      expected.unitTests + expected.audits,
    );
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

  console.log(`实测：${expected.endpoints} 个接口 / ${expected.paths} 条路径 / ${expected.models} 个模型 / ${expected.permissions} 个权限点`);
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
