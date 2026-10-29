/**
 * 文档数字守卫（docs-numbers guard）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 文档里的「52 个接口 / 42 条路径 / 73 个模型」「26 套单测 + 9 套审计 + 926 条 e2e」
 * 这类数字**每加一个接口就漂一次**，而且漂了**没有任何一处会报错** ——
 * 读者拿到的是一份自信的、过期的数字。这跟 `game-data.generated.ts` 那类快照腐化
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
 * #115 挖出的是同一类问题的另外三面 —— 这次不是「写法漏了」，是**「哪一类东西压根没查」**
 * 与**「数字的写法只认一种」**：
 *   - `server/FAQ.md` / `FAQ.en.md` 写的是 `**权限点**（17 个）`（数字在词**后面**），
 *     正向正则一条都抓不到 → 两版都写着 17（实际 18）而审计一直打勾；
 *   - 表数与仓储数**压根没纳入检查** —— 技能里还写着「四张表」「13 个权限点」，
 *     是把技能加进 `DOCS` 时才顺手发现的；
 *   - 英文文档（`server/README.en.md` 等）用的几乎全是**词形**（`Six tables`、
 *     `seven repositories`）—— 只查阿拉伯数字等于**放掉整个英文侧**。
 * 对策三条：倒装写法单独登记、表数与仓储数纳入实测、词形与阿拉伯数字**共用同一套判定**
 * （`checkWordNumbers` 与 `checkNumbers` 都走 `report`，避免「一种写法 FAIL、另一种静默通过」）。
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
 *   4. 表数 / 仓储数             ← `database.service.ts` 的建表语句、`repositories/*.repository.ts`
 *
 * 数字的**写法**要一起管：阿拉伯数字（`18 个`）、倒装（`权限点（18 个）`）与词形
 * （`六张表` / `Six tables`、`七个仓储` / `seven repositories`）三种在本仓库文档里都在用。
 * 只管第一种等于**整个英文侧无人看守** —— 英文里写 `Four tables` 而实际建了六张，
 * 退出码照样是 0（#115 实测踩到）。
 *
 * **不查**代码行数、文件数（`约 4.9 万行` 这种）—— 它们没有唯一口径（算不算注释、
 * 算不算生成物取决于心情），钉死了只会天天 FAIL。那类数字靠改代码时顺手看一眼。
 *
 * 数字与文本的对应靠**句式**：文档里承诺了口径的写法是固定的
 * （`X 个接口 / Y 条路径 / Z 个模型`、`N 条 e2e`、`X interfaces` …）。
 * 句式集中登记在 `main()` 里（`checkNumbers` / `checkWordNumbers` / `checkE2eBreakdown` /
 * `checkGroupRow` 的调用处），新增一种写法就往那儿加一行 —— **加的时候先想同义写法**
 * （量词 / 空格 / 连字符 / 单位 / **语序**），并想一下**中英两版各是怎么写的**。
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
  // 官网（#332）：它也到处写工程数字，但不在本清单里时没人守 —— 曾经停在 51 接口 /
  // 876 条 e2e 漂了两天才被人眼尖发现。只收 index.html（没有 en 译本，
  // audit-docs-en 的双语 parity 不涉及它）；句式照写就行，接口 / 路径 / 模型 /
  // 权限点 / 审计 / e2e 总数这些现有句式对官网文本天然命中。
  "website/index.html",
  // 项目技能也随仓库提交，而且是**下一轮会话唯一的上下文** —— 里面的数字同样不能漂（#115）。
  // 技能不在 DOCS 里时，「权限点是 13 个」这种话没人管，一过期就把下一次改动引到错的地方。
  //
  // **只登记讲服务端 / 管理端工程事实的技能**。`cocos-*` 那批不能加进来：
  // 它们说的「三张表」是游戏配置表、「四个仓储」这种话压根不是同一件事 ——
  // 盲目全量纳入只会换来一堆假 FAIL，而假 FAIL 会让人学会无视这个审计。
  ".workbuddy/skills/olua-server/SKILL.md",
  ".workbuddy/skills/olua-admin/SKILL.md",
];

/** e2e 脚本清单（顺序即 `docs/resume.md` 里括号中加数的推荐顺序） */
const E2E_SCRIPTS = [
  ["服务端主链路", "server/test/e2e.cjs"],
  ["角色管理", "server/test/e2e-roles.cjs"],
  ["守卫（口令/审计/限流/封禁/看板）", "server/test/e2e-guard.cjs"],
  ["邮件", "server/test/e2e-mail.cjs"],
  ["账号邮箱", "server/test/e2e-account-email.cjs"],
  ["实时通道", "server/test/e2e-realtime.cjs"],
  ["伤害结算", "server/test/e2e-combat.cjs"],
  ["世界权威", "server/test/e2e-world.cjs"],
  ["双进程形态", "server/test/e2e-dual.cjs"],
  ["养成配置（称号/战魂）", "server/test/e2e-game-config.cjs"],
  ["备份恢复", "server/test/backup.cjs"],
  ["区服（多开区/合并区）", "server/test/e2e-zone.cjs"],
  ["帮会（建帮/申请/审批/转让/解散）", "server/test/e2e-guild.cjs"],
  ["社交（好友/敌人/互见身份）", "server/test/e2e-social.cjs"],
  ["聊天（世界/帮会/私聊）", "server/test/e2e-chat.cjs"],
  ["任务（接取/推进/交付）", "server/test/e2e-quest.cjs"],
  ["出售 / 回收（经济出口）", "server/test/e2e-sell.cjs"],
  ["屏蔽与举报（社交安全）", "server/test/e2e-blocks.cjs"],
  ["组队（队伍系统）", "server/test/e2e-party.cjs"],
  ["排行榜（全服榜单）", "server/test/e2e-rank.cjs"],
  ["成就（累计型记账 / 状态型现算）", "server/test/e2e-achievement.cjs"],
  ["游戏内邮件（附件领取 / 背包满兜底）", "server/test/e2e-game-mail.cjs"],
  ["装备对齐几何（#513）", "server/test/e2e-equip-align.cjs"],
];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/**
 * 数字与量词之间的间隔：空白或 HTML 标签（#332）
 *
 * 官网数据带的数字夹在标记里 —— `<b>99</b><span>个 REST 接口</span>`，
 * 现行句式里只有 `\s*`，抓不到就等于官网最显眼的那排数字没人守
 * （负向实测：把 99 改成 97 审计照样打勾）。md 文档里没有标签，
 * 加进间隔对它们零影响；`<[^>]+>` 不会跨过普通文本，不会把无关数字桥接进句式。
 */
const NUM_GAP = "(?:\\s|<[^>]+>)*";

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
    tables: countTables(),
    repositories: countFiles(
      path.join(ROOT, "server", "src", "database", "repositories"),
      /\.repository\.ts$/,
    ),
  };
}

/**
 * 表数：`server/src/database/database.service.ts` 里 `CREATE TABLE IF NOT EXISTS <表名> (` 的条数
 *
 * 为什么只认「后面紧跟表名和左括号」的写法：同一份文件里还有一句注释
 * `存量库补列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）`，宽松匹配会把它也算成一张表。
 *
 * 为什么值得查：**表数漂了不会有任何编译错误、运行时也不会报错** —— 文档会安静地写着
 * 「六张表」而实际建了七张。#115 就是靠人工比对才发现的（技能里还写着「四张表」）。
 */
function countTables() {
  const relative = "server/src/database/database.service.ts";
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) throw new Error(`建表的唯一来源不存在：${relative}`);
  const source = fs.readFileSync(full, "utf8");
  const matched = source.match(/CREATE TABLE IF NOT EXISTS\s+[a-z_][a-z0-9_]*\s*\(/gi) ?? [];
  if (matched.length === 0) {
    throw new Error(
      `${relative} 里解析不出建表语句 —— 这个文件的写法变了？\n` +
        "  表数的唯一来源就是它，解析不到不该静默按 0 处理。",
    );
  }
  return matched.length;
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
  // 权限点对象的每一项长得像 `  ACCOUNT_READ: "account:read",`（两空格缩进的 `大写键: "资源:动作"`）。
  // 资源段允许 camelCase（`gameConfig:read`）—— 此前只认 `[a-z]+`，#213 加的两个 gameConfig
  // 权限点被静默漏数（实测停在 18、实际 20），全仓库文档跟着写错而审计一直打勾。
  const matched = source.match(/^ {2}[A-Z][A-Z0-9_]*:\s*"[a-z][a-zA-Z]*:[a-z]+",$/gm) ?? [];
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

/**
 * 每一类句式在受管文档里一共匹配到多少处（`label → 次数`）
 *
 * 为什么要数：**「一处都没匹配到」与「处处都匹配且都对」在退出码上完全一样**。
 * 文档换个写法（写成「权限点共 18 个」而不是「18 个权限点」）、或者正则被改坏，
 * 这一类检查就静默失效，脚本照样打「✔ 与实测一致」—— 这个坑本仓库踩过两次
 * （#113 的 5 个盲区，以及 #115 差点把「技能里的权限点数」加进 DOCS 却根本匹配不上）。
 * 数出来 + 给核心句式定个下限（`REQUIRED_PATTERNS`），才能把「抓不到」从「通过」里分出来。
 */
const matchCounts = new Map();

function counted(label) {
  matchCounts.set(label, (matchCounts.get(label) || 0) + 1);
  passed += 1;
}

function fail(label, detail) {
  failures.push(detail ? `${label}：${detail}` : label);
}

/**
 * 一处匹配的通用判定：等于期望值就记账（`counted`），否则 FAIL 并指出行号
 *
 * 抽出来是为了让「阿拉伯数字」与「词形数字」两种取数方式共用同一套判定 ——
 * 两者的差别只在**怎么从匹配里取出数字**，而「取出来之后怎么办」必须一模一样，
 * 否则迟早出现「一种写法 FAIL、另一种写法静默通过」。
 */
function report(doc, source, label, match, value, expected) {
  if (value === expected) {
    counted(label);
    return;
  }
  const line = source.slice(0, match.index).split("\n").length;
  fail(`${doc}:${line} 的「${label}」与实测不一致`, `文档写 ${value}，实测 ${expected}`);
}

/**
 * 在一份文档里按正则抓所有数字，每一个都必须等于期望值
 *
 * 抓不到不是失败 —— 这份文档可能压根没提这个数（比如 FAQ 不谈模型数）。
 * 但**抓到了就必须对**；而某一类句式**在全部文档里一处都抓不到**同样会失败，
 * 判据在 `REQUIRED_PATTERNS`。
 */
function checkNumbers(doc, source, label, pattern, expected) {
  for (const match of [...source.matchAll(pattern)]) {
    report(doc, source, label, match, Number(match[1]), expected);
  }
}

/**
 * 词形数字（中文 `六张表` / 英文 `six tables`）—— 正则连不上词形数字，只能按字面扫
 *
 * 中英两版文档都大量用词形而不是阿拉伯数字（`六张表` / `Six tables`、`七个仓储` /
 * `seven repositories`）。只查阿拉伯数字等于**放掉整个英文侧**：英文里写 `Four tables`
 * 而实际建了六张，退出码照样是 0。
 */
const WORD_NUMERALS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function checkWordNumbers(doc, source, label, pattern, expected) {
  for (const match of [...source.matchAll(pattern)]) {
    const value = WORD_NUMERALS[match[1].toLowerCase()];
    if (value === undefined) continue; // 正则已经把取值限死了，这里只是兜底
    report(doc, source, label, match, value, expected);
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
    counted("e2e 加数串");
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
    if (sum === total && counts.join("+") === expectedCounts) continue;
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
    counted(`分组「${groupLabel}」`);
    if (value === want) {
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    fail(`${doc}:${line} 分组「${groupLabel}」的数量与实测不一致`, `文档写 ${value}，实测 ${want}`);
  }
}

/**
 * 必须至少在受管文档里匹配到一次的句式
 *
 * 这些是「文档一定会提到」的核心数字。某一条**一处都匹配不到**时，八成不是「文档恰好没提」，
 * 而是**正则废弃了**或**文档换了写法** —— 那意味着这一类检查已经静默失灵，
 * 不能让它继续安静地打勾。加新句式时，若它属于「总该出现」的那类，往这里也加一行。
 */
const REQUIRED_PATTERNS = [
  "接口总数",
  "路径数",
  "模型数",
  "权限点数",
  "表数",
  "仓储数",
  "审计脚本数",
  "单测套数",
  "回归守卫总数",
  "e2e 总数",
  "e2e 加数串",
  "分组「公共接口」",
  "分组「客户端」",
  "分组「管理端」",
];

//#endregion

function main() {
  const expected = measure();

  for (const doc of DOCS) {
    const full = path.join(ROOT, doc);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, "utf8");

    // 1. 接口 / 路径 / 模型（中英两种句式都认；间隔用 NUM_GAP，官网标记见其注释）
    //    `个\s*` 而不是 `个` —— 文档里既有「51 个接口」也有「51 个 REST 接口」，
    //    中间那个空格曾经让这条例行长年漏检（`docs/resume.md` 因此一直写着旧数字）。
    checkNumbers(doc, source, "接口总数", new RegExp(`(\\d+)${NUM_GAP}个${NUM_GAP}(?:REST\\s+)?接口`, "g"), expected.endpoints);
    checkNumbers(doc, source, "接口总数（英文）", /(\d+)\s+interfaces?\b/g, expected.endpoints);
    checkNumbers(doc, source, "路径数", new RegExp(`(\\d+)${NUM_GAP}条路径`, "g"), expected.paths);
    checkNumbers(doc, source, "路径数（英文）", /(\d+)\s+paths?\b/g, expected.paths);
    checkNumbers(doc, source, "模型数", new RegExp(`(\\d+)${NUM_GAP}个模型`, "g"), expected.models);
    checkNumbers(doc, source, "模型数（英文）", /(\d+)\s+models?\b/g, expected.models);
    checkNumbers(doc, source, "权限点数", new RegExp(`(\\d+)${NUM_GAP}个权限点`, "g"), expected.permissions);
    checkNumbers(doc, source, "权限点数（英文）", /(\d+)\s+permission\s+points?/gi, expected.permissions);
    // 倒装写法：`**权限点**（18 个）` / `**Permission points** (18)`
    // 数字在词**后面**，正向正则一条都抓不到 —— `server/FAQ.md` 与 `server/FAQ.en.md`
    // 正是这种写法，于是两版都写着 17（实际 18）而审计一直打勾（#115）。
    // 锚点必须紧贴「权限点」：本文件里还有「每个接口还要求权限点（共 36 个）」，
    // 那是「需要权限点的管理端接口数」，不是权限点数；`\*{0,2}` 吃掉加粗星号，
    // 而 `（共 36 个）` 因为 `共` 不是数字自然不匹配。
    checkNumbers(doc, source, "权限点数（倒装）", /权限点\*{0,2}\s*[（(]\s*(\d+)\s*个/g, expected.permissions);
    checkNumbers(
      doc,
      source,
      "权限点数（倒装，英文）",
      /permission\s+points?\*{0,2}\s*[（(]\s*(\d+)\s*[)）]/gi,
      expected.permissions,
    );

    // 表数 / 仓储数：数据层的两个「唯一来源」事实，漂了不会有任何报错
    //
    // 「张表」这个句式**只留给 SQLite 的表**（建表语句数出来那 6 张）。要说「一份生成物里有几张
    // 数据表」（公共游戏数据是 23 张）时**必须写「张数据表」**：数字与「张表」之间夹了「数据」，
    // 这里就匹配不上，天然不会互相误报。写「23 张表」会被当成「SQLite 建了 23 张表」判 FAIL。
    checkNumbers(doc, source, "表数", /(\d+)\s*张表/g, expected.tables);
    checkNumbers(doc, source, "表数（英文）", /(\d+)\s+tables?\b/gi, expected.tables);
    // 词形写法要单独走：`六张表` / `Six tables`。
    // `(?![打])` 挡掉习语「一张表打三种目标」（那是「同一张表」，不是计数）；计数声明后面
    // 跟的是标点或列表，习语后面跟的是动词。
    checkWordNumbers(doc, source, "表数", /([一二三四五六七八九十])张表(?![打])/g, expected.tables);
    // 英文同款习语要一起挡掉：`one table serves three target kinds`（`一张表打三种目标` 的译本）。
    checkWordNumbers(
      doc,
      source,
      "表数（英文）",
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+tables?\b(?!\s+serves)/gi,
      expected.tables,
    );
    checkNumbers(doc, source, "仓储数", /(\d+)\s*个仓储/g, expected.repositories);
    checkWordNumbers(doc, source, "仓储数", /([一二三四五六七八九十])个仓储/g, expected.repositories);
    checkWordNumbers(
      doc,
      source,
      "仓储数（英文）",
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+repositories\b/gi,
      expected.repositories,
    );

    // 2. 分组表（`| 公共接口 | 6 |`）
    for (const header of ["公共接口", "客户端", "管理端"]) {
      checkGroupRow(doc, source, header, header, expected);
    }

    // 3. e2e 总数与加数串
    const e2eTotal = expected.e2e.reduce((sum, item) => sum + item.count, 0);
    checkNumbers(doc, source, "e2e 总数", new RegExp(`(\\d+)${NUM_GAP}条(?:服务端\\s*)?e2e`, "g"), e2eTotal);
    checkNumbers(doc, source, "e2e 总数（英文）", /(\d+)\s+(?:server\s+)?e2e\b/gi, e2eTotal);
    checkE2eBreakdown(doc, source, expected);

    // 4. 审计脚本数 / 单测套数
    //    量词两种都认（`9 套审计` / `9 个跨端审计脚本`），`跨端` 是修饰语可省。
    checkNumbers(doc, source, "审计脚本数", new RegExp(`(\\d+)${NUM_GAP}[套个](?:跨端)?审计(?:脚本)?`, "g"), expected.audits);
    //    单测的「自动化」修饰语可省（`38 套单测` / 官网的 `38 套自动化单测`，#332）。
    checkNumbers(doc, source, "单测套数", new RegExp(`(\\d+)${NUM_GAP}套(?:自动化)?单测`, "g"), expected.unitTests);
    // 英文量词两种都认：`9 audit scripts` 与 `9 audits`；单测那份还要容忍连字符
    // （`unit-test suites`）—— 就是这么写的，漏认等于没查。
    checkNumbers(doc, source, "审计脚本数（英文）", /(\d+)\s+audits?\b/gi, expected.audits);
    checkNumbers(doc, source, "单测套数（英文）", /(\d+)\s+unit[-\s]tests?\b/gi, expected.unitTests);
    // 词形写法（`八个审计脚本`）—— 中文数字正则抓不到，走词形通道
    checkWordNumbers(doc, source, "审计脚本数", /([一二三四五六七八九十])个审计/g, expected.audits);

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

  // 句式覆盖下限：某一条核心句式一处都没匹配到 = 这一类检查静默失灵（见 matchCounts 的注释）
  for (const label of REQUIRED_PATTERNS) {
    if ((matchCounts.get(label) || 0) > 0) continue;
    fail(`「${label}」在全部受管文档里一处都没匹配到`, "文档换写法了、还是正则废了？「抓不到」不等于「通过」");
  }

  //#region 汇总

  console.log(`实测：${expected.endpoints} 个接口 / ${expected.paths} 条路径 / ${expected.models} 个模型 / ${expected.permissions} 个权限点`);
  console.log(`      ${expected.tables} 张表 / ${expected.repositories} 个仓储`);
  console.log(
    `      ${expected.unitTests} 套单测 · ${expected.audits} 个审计 · ${expected.e2e.reduce((sum, item) => sum + item.count, 0)} 条 e2e（${expected.e2e
      .map((item) => item.count)
      .join(" + ")}）`,
  );
  for (const [tag, count] of expected.groups) console.log(`      分组「${tag}」${count}`);
  // 每一类各匹配到多少处 —— 数字掉到 0 就意味着这类句式静默失灵（下限见 REQUIRED_PATTERNS）
  console.log(
    `      句式覆盖：${[...matchCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([label, times]) => `${label} ${times}`)
      .join(" · ")}`,
  );

  if (failures.length === 0) {
    console.log(`\n✔ 文档数字与实测一致（比对 ${passed} 处，${matchCounts.size} 类句式）`);
    return;
  }

  console.log(`\n✗ 文档里有 ${failures.length} 处对不上：\n`);
  failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  console.log("\n  数字不一致 → 把文档里的数字改成实测值（上面「实测」那几行）。");
  console.log("  句式一处都没匹配到 → 先看文档是不是换了写法，再看正则是不是废了。");
  process.exit(1);
}

main();
