/**
 * 数量声明审计（count claims audit）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 有三个数字散落在文案里，每次增减脚本都要手工找一遍：
 *
 *   · 跨端审计项数（`tools/audit-*.cjs` 个数）
 *   · e2e 套件数（`server/package.json` 的 `test:e2e*` 脚本数）
 *   · 客户端单测套数（`client/tools/test-*.cjs` 个数）
 *
 * 还有一族同样靠人数、同样没有现象的：**表数**（77 = 39 配置 + 38 运行时）、
 * **管理端页面 / 路由**（53 / 54）、**客户端 Manager**（32）。2026-11-15 实测，
 * 表数在 8 处写成 76/37、页面路由在目录表写成 49、Manager 写成 30 —— 每一处都要
 * 一条命令才能复核，而没人会为一个数字跑一圈文档。
 *
 * 还有一个不是数字、却一样会静默失真的东西：`docs/13` §九 那张 e2e 分组表。
 * 新增套件时要手工把名字挂进对应组、组小计 +1、末尾求和式跟着改 —— 三处漏一处都不报错。
 *
 * 2026-11-15 实测：同一个「审计项数」在四个文件里分别是 **12 / 15 / 16 / 18** —— 四个年代
 * 的残留同时存在。这不是「某次改漏了」，而是没有单一来源：#1047 修官网时只扫了 `.html`，
 * 没扫 Makefile 与 CI 注释；#1042 加接口时只想到 README。人盯不住这种「写在不显眼处的
 * 口语数字」。
 *
 * 所以判据只能是**现算**：扫描白名单目录里所有 `N 项审计` / `N 套 e2e` / `N 套客户端单测`
 * 的声明，与磁盘实际数量比对。修法不需要动脑：`--write` 一次性全部替换。
 *
 * ===========================================================================
 * 判据（八条 + 一条结构检查）
 * ===========================================================================
 *   A. `N 项审计` / `N 项跨端审计` / `N 个守点` / `N 套 \`tools/audit-*.cjs\``
 *      == `ls tools/audit-*.cjs`
 *   B. `N 套 e2e` / `N 个 test:e2e* 脚本` / `套件：N 套`
 *      == `server/package.json` 里 `test:e2e*` 的脚本数
 *   C. `N 套 \`client/tools/test-*.cjs\`` == `ls client/tools/test-*.cjs`
 *   D. `（1 个主套 + M 个专项）` 的 M == 脚本数 − 1
 *   E. `\`server/test/e2e*.cjs\` 是 K 个` == `ls server/test/e2e*.cjs`
 *      （与脚本数差 1：`test:e2e:backup` 指向 `test/backup.cjs`）
 *   F. **结构检查 · docs/13 §九 的分组表**（`--write` 修不了，只报红）：
 *      标题套数、每组小计、组小计之和、末尾求和式、表内套件名集合，
 *      逐项对 `package.json` 现算。新增套件挂错组 / 忘了挂 / 小计没 +1 都在这里断。
 *   G. `N 张表` / `N 张配置表` / `N 张运行时表` / `数据表清单（N 张）` / `N 张表的字段级清单`
 *      / 官网 `<b>N 张表</b>` == `server/scripts/lib/config-tables.cjs` 两份清单的长度
 *      （**不读 DB**：干净 clone 上没有 `.db`，清单才是「该有哪些表」的唯一来源）
 *   H. `N 个客户端 Manager` == `ls client/assets/ui/core/*.ts`；
 *      `N 个页面文件` == `ls admin/src/pages/*.tsx`；
 *      `N 条路由、` / `N 条路由 / N 个页面` == `App.tsx` 的 `path="…"` 去重数
 *
 * 为什么 D/E 要单列：B 那条 `(\d+)\s*个\s*test:e2e\*?\s*脚本` 曾经**不认反引号**，
 * 而正文写的是「93 个 \`test:e2e*\` 脚本」—— 正则从「个」直接跳到 `test` 就再也不匹配，
 * 于是脚本数 93→94 时表头与表体都改了，正文明晃晃写着 93/92 却一直是绿的（#1063）。
 * 教训：正则放宽到「容忍装饰符」比「精确匹配排版」可靠，排版会变，语义不会。
 *
 * 反过来的教训（G 的第一版）：`(\d+)\s*张表` **太宽**。全仓还有「出厂 5 张表」
 * 「结算缓存 14 张表」「39 张表在管理端哪儿改」（后者指的是 39 张**配置**表）——
 * 裸匹配一跑就报 31 处假红。守点宁可窄也不能假红：**假红一次，下次真红就没人信了**。
 * 所以 G 只认带定语或标点的锚定写法（`张表 =` / `张表：` / `张表的字段级清单` / `（N 张）`）。
 * 同理 H 不匹配裸的 `N 条路由`——`docs/18` 有「加 3 条路由」这种合法叙述。
 *
 * 注意本脚本自己也算一项审计：加上它，审计数从 18 变 19，于是全仓写 18 的地方都要变。
 * 这正是守点的价值 —— 跑一次 `--write` 就能把「凡是写 18 的地方」全部找出来，不用凭记忆列清单。
 *
 * ===========================================================================
 * 扫描范围（显式白名单，不用 glob 全仓）
 * ===========================================================================
 *   docs/ · website/ · .workbuddy/skills/ · .github/workflows/ · Makefile · 各 README
 *
 * **`.workbuddy/memory/**` 永久排除**：那里是历史日志，写的是「当时的数字」，
 * 改成今天的值反而失真（某天记「17 项审计」是事实，不该被改写）。
 *
 * 用法：
 *   node tools/audit-count-claims.cjs           # 只检查，有偏差即退出码 1
 *   node tools/audit-count-claims.cjs --write   # 按磁盘实际数量重写所有声明
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

/** 递归目录白名单 */
const DIRS = ["docs", "website", ".workbuddy/skills", ".github/workflows"];
/** 单文件白名单 */
const FILES = [
  "Makefile",
  "README.md",
  "README.en.md",
  "admin/README.md",
  "server/README.md",
  "client/README.md",
  "client/README.en.md",
  "client/FAQ.md",
  "client/FAQ.en.md",
];
/** 只看这些扩展名（Makefile 无扩展名，单独放行） */
const EXT = new Set([".md", ".html", ".yml", ".yaml", ".cjs"]);
/** 目录遍历时跳过 */
const SKIP = new Set(["node_modules", "dist", "library", "temp", ".git", "memory", "assets", "build"]);

// ── 实际数量 ────────────────────────────────────────────────────────
const countAudits = () =>
  fs.readdirSync(path.join(ROOT, "tools")).filter((f) => /^audit-.*\.cjs$/.test(f)).length;

const countE2e = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8"));
  return Object.keys(pkg.scripts || {}).filter((k) => k.startsWith("test:e2e")).length;
};

const countClientTests = () =>
  fs.readdirSync(path.join(ROOT, "client", "tools")).filter((f) => /^test-.*\.cjs$/.test(f)).length;

/** `server/test/e2e*.cjs` 的文件数（口径是脚本数，两者差 1，见判据 E） */
const countE2eFiles = () =>
  fs.readdirSync(path.join(ROOT, "server", "test")).filter((f) => /^e2e.*\.cjs$/.test(f)).length;

/** `test:e2e` → `e2e`，`test:e2e:map-aoi` → `map-aoi` */
const E2E_SCRIPT_PREFIX = "test:e2e";
const e2eScriptNames = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8"));
  return Object.keys(pkg.scripts || {})
    .filter((k) => k.startsWith(E2E_SCRIPT_PREFIX))
    .map((k) => (k === E2E_SCRIPT_PREFIX ? "e2e" : k.slice(E2E_SCRIPT_PREFIX.length + 1)));
};

/**
 * 表数：**只读 `config-tables.cjs` 的两份清单，不读 DB**。
 * 干净 clone 上没有 `server/data/olua.db`，读库会让守点在新环境直接崩；
 * 而清单才是「哪些表该存在」的唯一来源（`assertAllClassified()` 就盯它）。
 */
const tableCounts = () => {
  const { CONFIG_TABLES, RUNTIME_TABLES } = require(path.join(
    ROOT,
    "server",
    "scripts",
    "lib",
    "config-tables.cjs"
  ));
  return { config: CONFIG_TABLES.length, runtime: RUNTIME_TABLES.length };
};
const { config: CONFIG_TABLES_N, runtime: RUNTIME_TABLES_N } = tableCounts();
const TABLES_TOTAL = CONFIG_TABLES_N + RUNTIME_TABLES_N;

/** 管理端页面文件数 + 路由数（路由按 `App.tsx` 的 `path="..."` 去重，与 docs/README §五 写的命令同一口径） */
const pageCount = () =>
  fs.readdirSync(path.join(ROOT, "admin", "src", "pages")).filter((f) => f.endsWith(".tsx")).length;
const routeCount = () => {
  const app = fs.readFileSync(path.join(ROOT, "admin", "src", "App.tsx"), "utf8");
  return new Set([...app.matchAll(/path="([^"]*)"/g)].map((m) => m[1])).size;
};

/** 客户端 `assets/ui/core/*.ts` 里的 Manager 数 */
const managerCount = () =>
  fs.readdirSync(path.join(ROOT, "client", "assets", "ui", "core")).filter((f) => f.endsWith(".ts")).length;

const AUDITS = countAudits();
const E2E = countE2e();
const E2E_FILES = countE2eFiles();
const CLIENT_TESTS = countClientTests();
const PAGES = pageCount();
const ROUTES = routeCount();
const MANAGERS = managerCount();

/**
 * 声明模式。`res` 里每个正则的第 1 组必须是数字。
 * 模式都要求「数字 + 量词 + 名词」连写，避免误伤「漏了 3 套（admin-mail…）」这类叙述。
 */
const CLAIMS = [
  {
    label: "审计项数",
    value: AUDITS,
    res: [
      /(\d+)\s*项跨端审计/g,
      /(\d+)\s*项审计/g,
      /(\d+)\s*个守点/g,
      /(\d+)\s*套\*{0,2}\s*`tools\/audit-/g,
    ],
  },
  {
    label: "e2e 套数",
    value: E2E,
    res: [
      /(\d+)\s*套\s*e2e/g,
      // 反引号可有可无：正文排版会变（`test:e2e*` / test:e2e* / **test:e2e***），语义不变
      /(\d+)\s*个\s*`{0,2}\s*test:e2e\*?\s*`{0,2}\s*脚本/g,
      /套件：(\d+)\s*套/g,
    ],
  },
  {
    label: "e2e 专项数",
    value: E2E - 1,
    res: [/主套\s*\+\s*(\d+)\s*个专项/g],
  },
  {
    label: "e2e 文件数",
    value: E2E_FILES,
    res: [
      /`server\/test\/e2e\*\.cjs`\s*是\s*(\d+)\s*个/g,
      // README §五 的写法多一个 `ls `：「`ls server/test/e2e*.cjs` 是 93 个文件」
      /`ls server\/test\/e2e\*\.cjs`\s*是\s*(\d+)\s*个/g,
    ],
  },
  {
    label: "客户端单测套数",
    value: CLIENT_TESTS,
    res: [/(\d+)\s*套\*{0,2}\s*`client\/tools\/test-/g],
  },
  {
    // 表数：由 `config-tables.cjs` 两份清单现算（不读 DB，干净 clone 上也有唯一答案）。
    // **不能裸匹配「N 张表」**：全仓还有「出厂 5 张表」「结算缓存 14 张表」「39 张表在管理端哪儿改」
    // （后者指的是 39 张**配置**表）这类合法叙述，裸匹配会把它们全判红。只认带定语/标点的锚定写法。
    label: "表数（合计）",
    value: TABLES_TOTAL,
    res: [
      /数据表清单（(\d+)\s*张/g, // docs/15 标题
      /(\d+)\s*张表的字段级清单/g, // 篇末「下一篇」链接
      /<b>(\d+)\s*张表<\/b>/g, // 官网架构页
    ],
  },
  {
    label: "表数（配置）",
    value: CONFIG_TABLES_N,
    res: [/(\d+)\s*张配置表/g, /配置表（(\d+)\s*张/g],
  },
  {
    label: "表数（运行时）",
    value: RUNTIME_TABLES_N,
    res: [/(\d+)\s*张运行时表/g, /运行时表（(\d+)\s*张/g],
  },
  {
    label: "客户端 Manager",
    value: MANAGERS,
    res: [/(\d+)\s*个客户端 Manager/g],
  },
  {
    label: "管理端页面",
    value: PAGES,
    res: [/(\d+)\s*个页面文件/g],
  },
  {
    // 裸的「N 条路由」不能匹配：`docs/18` 有「加 3 条路由」这种合法叙述。
    // 所以只认带标点的锚定写法（目录表里「49 条路由、三级导航」）与成对写法（见 PAIRED）
    label: "管理端路由",
    value: ROUTES,
    res: [/(\d+)\s*条路由、/g],
  },
];

/**
 * 一句话里有**多个**数字的声明（「77 张表 = 39 张配置 + 37 张运行时」「54 条路由 / 53 个页面」）。
 * 单值 CLAIMS 表达不了，单独一张表：`values` 与正则的捕获组按位置一一对应。
 */
const PAIRED = [
  {
    // `## 一、76 张表 = 39 张配置 + 37 张运行时`
    label: "表数（合计 = 配置 + 运行时）",
    values: [TABLES_TOTAL, CONFIG_TABLES_N, RUNTIME_TABLES_N],
    re: /(\d+)\s*张表\s*=\s*(\d+)\s*张配置\s*\+\s*(\d+)\s*张运行时/g,
  },
  {
    // 目录表：`76 张表：39 配置 + 37 运行时`
    label: "表数（目录表：合计 + 配置 + 运行时）",
    values: [TABLES_TOTAL, CONFIG_TABLES_N, RUNTIME_TABLES_N],
    re: /(\d+)\s*张表：\s*(\d+)\s*配置\s*\+\s*(\d+)\s*运行时/g,
  },
  {
    label: "页面 / 路由（54 条路由 / 53 个页面）",
    values: [ROUTES, PAGES],
    re: /(\d+)\s*条路由\s*\/\s*(\d+)\s*个页面/g,
  },
];

// ── 收集文件 ────────────────────────────────────────────────────────
function collect() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(rel))) return;
      for (const e of fs.readdirSync(abs)) walk(path.posix.join(rel, e));
      return;
    }
    const base = path.basename(rel);
    if (base === "Makefile" || EXT.has(path.extname(rel))) out.push(rel);
  };
  for (const d of DIRS) walk(d);
  for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  return out;
}

// ── 判据 F：docs/13 §九 的 e2e 分组表 ────────────────────────────────
/**
 * 这张表是「新增套件时唯一要人动手」的地方，也是最容易静默失真的地方：
 * 名字挂错组、忘了挂、小计没 +1、末尾求和式没跟着改，四样全都不报错。
 * 所以这里不看人写了什么，而是拿 `package.json` 的脚本清单**双向比对**整张表。
 *
 * 与 A/B 的区别：那些是「数字对不上 → 一个 `--write` 全改完」；
 * 这里的偏差没有唯一解（漏的那个套件该挂哪一组要人判断），所以**只报红不改**。
 */
function checkE2eGroupTable() {
  const rel = "docs/13-部署运维与质量门禁.md";
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [`${rel} 不存在，判据 F 无法执行`];

  const out = [];
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const head = lines.findIndex((l) => /^##\s*九、\s*e2e 套件/.test(l));
  if (head < 0) return [`${rel} 找不到「九、e2e 套件」标题（判据 F 的锚点）`];

  const title = /：\s*(\d+)\s*套/.exec(lines[head]);
  if (!title) out.push(`${rel}:${head + 1} 标题里没写「N 套」`);
  else if (Number(title[1]) !== E2E) out.push(`${rel}:${head + 1} 标题写 ${title[1]} 套，实际 ${E2E} 套`);

  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    // 分组表之后还有「### 跑法」「### 三个本地跑 e2e 的坑」等同级表，
    // 见到任何标题就收工 —— 否则「坑」那张表会被当成组，`server/src` 也会被当成套件名
    if (/^#{2,}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const groups = [];
  for (let i = head + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 2) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
    if (cells[0] === "分组") continue; // 表头
    const name = /\*\*(.+?)\*\*/.exec(cells[0]);
    const sub = /（\s*(\d+)\s*）\s*$/.exec(cells[0]);
    // 只认反引号包住的套件名；括号里的「67 条」是断言数，不在反引号内，不会误收
    const suites = [...cells[1].matchAll(/`([A-Za-z][\w-]*)`/g)].map((m) => m[1]);
    groups.push({ no: i + 1, group: name ? name[1] : cells[0], sub: sub ? Number(sub[1]) : null, suites });
  }
  if (!groups.length) return [...out, `${rel}:${head + 1} 之后没解析出分组表（判据 F）`];

  const counts = [];
  for (const g of groups) {
    if (g.sub === null) out.push(`${rel}:${g.no} 组「${g.group}」没写小计`);
    else if (g.sub !== g.suites.length) {
      out.push(`${rel}:${g.no} 组「${g.group}」小计写 ${g.sub}，实际列了 ${g.suites.length} 项`);
    }
    counts.push(g.suites.length);
  }

  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum !== E2E) out.push(`${rel} §九 分组表合计 ${sum} 项，实际 ${E2E} 个脚本`);

  const listed = groups.flatMap((g) => g.suites);
  for (const n of new Set(listed.filter((x, i) => listed.indexOf(x) !== i))) {
    out.push(`${rel} §九 表里 \`${n}\` 出现了不止一次`);
  }
  const actual = e2eScriptNames();
  const missing = actual.filter((n) => !listed.includes(n));
  const extra = [...new Set(listed)].filter((n) => !actual.includes(n));
  if (missing.length) out.push(`${rel} §九 表里漏了 ${missing.length} 个套件：${missing.join(" / ")}`);
  if (extra.length) out.push(`${rel} §九 表里有 ${extra.length} 个不存在的套件：${extra.join(" / ")}`);

  // 末尾的「（N 组小计 a+b+c = N）」：组数、逐组项数、求和、合计四处都要对
  const totLine = lines.findIndex(
    (l, i) => i > head && i < end && /\d+\s*组小计\s*[\d+\s]+?=\s*\d+/.test(l)
  );
  if (totLine < 0) {
    out.push(`${rel} §九 找不到「N 组小计 a+b+… = N」的合计行`);
    return out;
  }
  const m = /(\d+)\s*组小计\s*([\d+\s]+?)\s*=\s*(\d+)/.exec(lines[totLine]);
  const nGroups = Number(m[1]);
  const parts = m[2]
    .trim()
    .split(/\s*\+\s*/)
    .map(Number);
  const total = Number(m[3]);
  if (nGroups !== groups.length) out.push(`${rel}:${totLine + 1} 写 ${nGroups} 组，表里是 ${groups.length} 组`);
  if (parts.length !== groups.length) {
    out.push(`${rel}:${totLine + 1} 求和式有 ${parts.length} 项，表里是 ${groups.length} 组`);
  } else if (parts.some((v, i) => v !== counts[i])) {
    out.push(`${rel}:${totLine + 1} 求和式 ${parts.join("+")} 与各组实际项数 ${counts.join("+")} 不一致`);
  }
  const partsSum = parts.reduce((a, b) => a + b, 0);
  if (partsSum !== total) out.push(`${rel}:${totLine + 1} 求和式加出来 ${partsSum}，却写着 = ${total}`);
  if (total !== E2E) out.push(`${rel}:${totLine + 1} 合计写 ${total}，实际 ${E2E} 个脚本`);

  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────
const problems = [];
const hits = [];
let fixed = 0;

for (const rel of collect()) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, "utf8");
  const lines = src.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    for (const claim of CLAIMS) {
      for (const re of claim.res) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const n = Number(m[1]);
          hits.push({ rel, line: i + 1, claim: claim.label, n, expect: claim.value });
        }
        // 重写：保留原模式的其余文本，只换数字
        line = line.replace(re, (whole, num) => whole.replace(num, String(claim.value)));
      }
    }
    for (const pair of PAIRED) {
      pair.re.lastIndex = 0;
      let m;
      while ((m = pair.re.exec(line))) {
        const got = pair.values.map((_, k) => Number(m[k + 1]));
        hits.push({
          rel,
          line: i + 1,
          claim: pair.label,
          n: got.join(" / "),
          expect: pair.values.join(" / "),
        });
      }
      // 逐组替换：先用占位符换掉两个捕获组，再填目标值。
      // 不能「按数字找第一个」—— 两个数一样（`39 配置 + 39 运行时`）或写反了（`38 配置 + 39 运行时`）
      // 会把同一个数字改两次、另一个留在原地。
      line = line.replace(pair.re, (whole, ...rest) => {
        const caps = rest.slice(0, pair.values.length).map(String);
        let out = whole;
        caps.forEach((c, k) => {
          out = out.replace(c, `\u0000${k}\u0000`);
        });
        pair.values.forEach((v, k) => {
          out = out.split(`\u0000${k}\u0000`).join(String(v));
        });
        return out;
      });
    }
    if (line !== lines[i]) {
      lines[i] = line;
      changed = true;
    }
  }

  const bad = hits.filter((h) => h.rel === rel && h.n !== h.expect);
  if (bad.length) {
    if (WRITE) {
      fs.writeFileSync(abs, lines.join("\n"), "utf8");
      fixed += bad.length;
    } else {
      for (const h of bad) {
        problems.push(`${rel}:${h.line} 写 ${h.n}，实际 ${h.expect}（${h.claim}）`);
      }
    }
  } else if (changed && WRITE) {
    // 没有任何偏差却改动了行 —— 说明模式误伤，直接报出来
    problems.push(`${rel}: 模式命中了不该改的行（请检查正则）`);
  }
}

const tableProblems = checkE2eGroupTable();

if (WRITE && fixed) {
  console.log(
    `✔ 已按磁盘实际数量重写 ${fixed} 处声明（审计 ${AUDITS} / e2e ${E2E} / 客户端单测 ${CLIENT_TESTS}）`
  );
}

if (problems.length) {
  console.error(`✘ 数量声明与实际不一致（${problems.length} 处）`);
  for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
  if (problems.length > 40) console.error(`  … 还有 ${problems.length - 40} 处`);
  console.error("  处理：node tools/audit-count-claims.cjs --write");
  process.exit(1);
}

if (tableProblems.length) {
  console.error(`✘ docs/13 §九 的 e2e 分组表与 package.json 不一致（${tableProblems.length} 处）`);
  for (const p of tableProblems) console.error(`  · ${p}`);
  console.error("  处理：手工改表（新套件挂哪一组要人判断，这里不给 --write）");
  process.exit(1);
}

console.log(
  `✔ 全仓 ${hits.length} 处数量声明与磁盘一致（审计 ${AUDITS} / e2e ${E2E} / 单测 ${CLIENT_TESTS} / ` +
    `表 ${TABLES_TOTAL}=${CONFIG_TABLES_N}+${RUNTIME_TABLES_N} / 页面 ${PAGES}·路由 ${ROUTES} / Manager ${MANAGERS}）`
);
console.log(`✔ docs/13 §九 分组表 ${E2E} 项与 package.json 一一对应（组小计、求和式、套件名集合）`);
