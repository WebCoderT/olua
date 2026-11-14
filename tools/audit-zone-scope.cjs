#!/usr/bin/env node
/**
 * 区边界审计（#956 / docs/39-区服模型补完设计.md §2.4）
 *
 * ===========================================================================
 * 为什么要有它
 * ===========================================================================
 * 区在这个项目里一直是「账号 + 怪物世界」的标签，不是边界：世界频道发全进程、
 * 组队与经验分成只比 mapId、帮会没有 zone 列、排行榜全服混排、管理端除 zones 外
 * 零 zone 引用。这些漏点单看都是「少写了一句 where」，合起来就是：
 *
 *   改个包 / 遍历 roleId / 拼一个 ?zoneId= → 摸到别的区的人。
 *
 * 而「少写一句 where」是 review 看不完的 —— 仓储存取方法有几十个，每加一个入口
 * 就多一处可能漏。所以这里不审「业务逻辑对不对」，只钉三条**结构判据**：
 *
 *   1. 玩家侧（非 admin / 非 zone 模块）controller 不许把 zone 当请求入参；
 *      玩家侧 DTO 不许出现带校验装饰器的 zoneId 字段（只许服务端推导）。
 *   2. zone-scoped 仓储的查询函数签名必须带区（findById / list / count / findByAccount /
 *      findIdsByName / listForLeaderboard 这一批），否则调用方能在编译期就合法地「不带区查」。
 *   3. 已经带 zone_id 列的表（roles / world_monsters / map_monitor_*），**读**它们的 SQL 必须
 *      真的过滤 zone（写语句与「按主键取一行拼名字」的装饰 join 不算，理由见 tablesIn /
 *      rolesAreDecorative 的注释）；service 层不许解构 dto.zoneId / query.zoneId 当权威。
 *
 * 判据都是静态的，不需要跑服务。输出风格与 audit-world-authority.cjs 一致：
 * 逐条指名道姓（文件:行 + 方法 + 该怎么做），exit 1。
 *
 * ===========================================================================
 * 白名单
 * ===========================================================================
 * `tools/zone-scope-allowlist.json`，**条目级**（rule + file + method/symbol），不许整文件豁免 ——
 * 整文件豁免等于「这个文件以后随便写」，而问题是会长的。
 *
 * 两条硬性要求（脚本自己会查）：
 *   - 每条必须带 `issue`（清它的那个 issue）与 `reason`（为什么暂时留着）；
 *   - **条目不再命中任何违规 → 也算红**。代码改好了就顺手删条目，否则白名单只增不减，
 *     半年后又变成「一堆没人知道能不能删的豁免」。
 *
 * 反证方式：塞一个 `@Query("zoneId")`、一个单参 `findById(id)`、一条不带 zone 的
 * `FROM world_monsters`，三处必须全部点名且 exit=1；删掉后回绿。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server", "src");
const MODULES = path.join(SERVER, "modules");
const REPOS = path.join(SERVER, "database", "repositories");
const SCHEMA = path.join(SERVER, "database", "database.service.ts");
const ALLOWLIST_FILE = path.join(__dirname, "zone-scope-allowlist.json");

/**
 * 玩家侧 = 除管理端 / 区服 / 审计之外的模块
 *
 * 这三个模块的区都不是「玩家的归属」，而是别的意思：
 *   - `admin` / `zone`：区是**必填上下文**（`X-Zone-Id`），本来就该有；
 *   - `audit`：管理端的旁路。写入口的 `zoneId` 是**服务端从守卫取到的当前区**
 *     （不是玩家请求参数），查询的 `?zoneId=` 是管理员的**筛选条件**（不传 = 全部区）。
 */
const PLAYER_SIDE_EXCLUDE = [
  path.join("modules", "admin"),
  path.join("modules", "zone"),
  path.join("modules", "audit"),
];

/**
 * 已经带 zone_id 列的表 —— 这些表的 SQL 必须自己过滤 zone。
 *
 * 加完列**必须**把表加到这里：脚本下面有「schema 已带 zone_id 但清单没登记」的检查，漏改会红。
 * 现役：roles（#957）、guilds（#958）、world_monsters / map_monitor_*（#809 之前就有）。
 */
const TABLES_WITH_ZONE = ["roles", "guilds", "world_monsters", "map_monitor_state", "map_monitor_events"];

/**
 * 刻意**不**纳入的表（它们也有 zone_id 列，但按设计允许全局查）：
 *   - `accounts` / `admins`：账号与管理员的区是「当前浏览区」，本身跨区；
 *   - `event_logs` / `audit_logs`：流水按 roleId / 时间查，追责刻意跨区（管理端的区过滤在 #960 单独做）；
 *   - `world_reload_requests`：查询本来就带 zone_id（`WHERE zone_id = ? AND map_id = ?`），
 *     纳进来只是让「管理端看所有区的待办」这类视图去挂豁免。
 * 把它们列进来会长期挂着豁免条目 —— 白名单一旦变成「永远删不掉的一堆」，守点就废了。
 */

/** 将来加列的表：schema 里出现 zone_id 时用来提示「该把谁补进 TABLES_WITH_ZONE」 */
const TABLES_BECOMING_ZONE_SCOPED = ["role_mails"];

/**
 * 区**可空**的表：`zone_id` 为 NULL = 全服（#963 的公告就是这一档）
 *
 * 这类表刻意不进 `TABLES_WITH_ZONE`：跨区可见是设计要求 —— 一条全服公告每个区都读得到，
 * 管理端列表也必须看得见别区的公告（否则「发到 2 区去了」在 1 区的界面上直接消失），
 * 给这些查询挂豁免会变成一堆永远删不掉的条目。
 *
 * 真正要守的是**写入口必须表态**：INSERT / UPDATE 得自己写 `zone_id` 列。漏写的后果不是
 * 「查不到」而是**静默变成全服**（NULL）—— 一条本想只投本区的通知会影响所有区。
 * 所以这里只查写、不查读（读的可见性由 e2e 盯着：别区看不到、登录页只有全服）。
 */
const TABLES_WITH_NULLABLE_ZONE = ["announcements"];

/**
 * zone-scoped 仓储：行属于某个区，按 id/名字取到别区对象就是跨区攻击。
 *
 * 只收「**别的玩家能拿到 id**」的对象：角色（好友 / 组队 / 邀请靠 roleId）、帮会（申请靠 guildId）、
 * 世界怪（instance_id）、房间监控（zone:map:slot）。
 *
 * 刻意**不含** role-mail / role-position / social / party / quest 这类「按我自己的 roleId 取」的表：
 * 入参本来就是我的角色，行只会落在我的区。把它们列进来只会制造噪音，噪音一多就会有人
 * 整文件豁免 —— 那才是真的失守。邮件 / 坐标这类跨区风险在 service 用 mustSameZone 拦（docs/39 §2.4 规则 3）。
 */
const ZONE_SCOPED_REPOS = [
  "role.repository.ts",
  "guild.repository.ts",
  "world-monster.repository.ts",
  "map-monitor.repository.ts",
];

/**
 * 签名必须带区的查询方法名（docs/39 §2.4 规则 2 点名的这一批）。
 * 判据只看**定义**，不看调用 —— 定义没区，调用就永远可以不交区。
 */
const WATCHED_METHODS = [
  "findById",
  "findByIdAnyZone",
  "findByIds",
  "findByKey",
  "findByAccount",
  "findByAccountAndName",
  "findIdsByName",
  "findByRole",
  "list",
  "count",
  "listForLeaderboard",
  "listByRoom",
  "listByZone",
  "listStates",
  "listEvents",
];

/** 玩家侧「区入参」的形态：query / param / header 三处都算 */
const ZONE_INPUT_PATTERNS = [
  { re: /@Query\(\s*["']zoneId["']/, what: '@Query("zoneId")' },
  { re: /@Param\(\s*["']zoneId["']/, what: '@Param("zoneId")' },
  { re: /@Headers\(\s*["']x-zone-id["']/i, what: '@Headers("X-Zone-Id")' },
];

/** service 把客户端传来的区当权威（docs/39 §2.4 规则 1 推论） */
const ZONE_INPUT_DESTRUCTURE = /\b(dto|query|body|params|filter|input)\.zoneId\b/;

// ---------------------------------------------------------------------------

/** @type {Array<{rule: string, file: string, line: number, key: string, hint: string}>} */
const problems = [];
const usedAllowlistKeys = new Set();
/** 每个豁免命中了多少处违规：>1 说明「同一个名字又长出一处」，豁免不该顺带盖住它 */
const allowHitCount = new Map();

function problem(rule, file, line, key, hint) {
  problems.push({ rule, file: path.relative(ROOT, file), line, key, hint });
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function isPlayerSide(file) {
  return !PLAYER_SIDE_EXCLUDE.some((segment) => file.includes(path.sep + segment + path.sep) || file.includes(segment + path.sep));
}

/**
 * 白名单查找。键 = `rule|相对路径|方法名或符号`。
 * 命中即记 used（用于「过期条目」检查），返回条目本身。
 */
let allowlist = { entries: [] };
if (fs.existsSync(ALLOWLIST_FILE)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
  } catch (error) {
    console.error(`✗ 区边界：白名单不是合法 JSON —— ${ALLOWLIST_FILE}\n  ${error.message}`);
    process.exit(1);
  }
}

function allowKey(rule, relFile, key) {
  return `${rule}|${relFile}|${key}`;
}

function allowlisted(rule, file, key) {
  const relFile = path.relative(ROOT, file);
  const id = allowKey(rule, relFile, key);
  const hit = (allowlist.entries ?? []).find((entry) => allowKey(entry.rule, entry.file, entry.key) === id);
  if (hit) {
    usedAllowlistKeys.add(id);
    allowHitCount.set(id, (allowHitCount.get(id) ?? 0) + 1);
  }
  return hit;
}

/** 报了问题才看白名单：命中就不报（但仍记 used），没命中才进 problems */
function report(rule, file, line, key, hint) {
  const hit = allowlisted(rule, file, key);
  if (hit) {
    if (!hit.issue || !hit.reason) {
      problem(rule, file, line, key, `白名单条目缺 issue 或 reason（${allowlistPath()}）—— 豁免必须说明谁来清、为什么留`);
    }
    return;
  }
  problem(rule, file, line, key, hint);
}

function allowlistPath() {
  return path.relative(ROOT, ALLOWLIST_FILE);
}

// ---------------------------------------------------------------------------
// 一、玩家侧不许把区当请求入参（规则 1）
// ---------------------------------------------------------------------------
for (const file of walk(MODULES)) {
  if (!file.endsWith(".controller.ts") || !isPlayerSide(file)) continue;
  const lines = read(file).split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const { re, what } of ZONE_INPUT_PATTERNS) {
      if (re.test(text)) {
        report(
          "controller-input",
          file,
          index + 1,
          what,
          `玩家侧不许出现 ${what}：区由服务端推导（浏览期 active_zone_id / 进图后在线角色区），客户端传了也不该有人读`,
        );
      }
    }
  });
}

// 玩家侧 DTO 不许出现「带校验装饰器」的 zoneId 字段。
// 只认 @IsXxx / @Min / @Max —— 响应 DTO 用的是 @ApiProperty（展示用，允许）。
{
  const VALIDATOR = /@(Is[A-Z]\w*|Min|Max|Matches|Length)\(/;
  for (const file of walk(MODULES)) {
    if (!file.endsWith(".dto.ts") || !isPlayerSide(file)) continue;
    const lines = read(file).split(/\r?\n/);
    lines.forEach((text, index) => {
      if (!/^\s*zoneId\??\s*:/.test(text)) return;
      const above = lines.slice(Math.max(0, index - 8), index).join("\n");
      if (!VALIDATOR.test(above)) return;
      report(
        "dto-input",
        file,
        index + 1,
        "zoneId",
        "玩家侧入参 DTO 又长出 zoneId 了：建角 / 选服之外，区一律由服务端代入（#957 会把注册的这条也删掉）",
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 二、service 不许把客户端传来的区当权威（规则 1 推论）
// ---------------------------------------------------------------------------
for (const file of walk(MODULES)) {
  if (!file.endsWith(".service.ts") || !isPlayerSide(file)) continue;
  const lines = read(file).split(/\r?\n/);
  lines.forEach((text, index) => {
    // `dto.zoneId = zoneId;` 是**响应组装**（把算出来的区写进视图），不是读入参
    if (/^\s*[\w.$]+\.zoneId\s*=[^=]/.test(text)) return;
    const hit = ZONE_INPUT_DESTRUCTURE.exec(text);
    if (!hit) return;
    report(
      "service-zone-input",
      file,
      index + 1,
      hit[1] + ".zoneId",
      `service 在读 ${hit[1]}.zoneId —— 玩家侧的区只能在服务端算（accounts.active_zone_id / 在线角色 roles.zone_id），不是请求参数`,
    );
  });
}

// ---------------------------------------------------------------------------
// 三、zone-scoped 仓储：签名必须带区（规则 2）
// ---------------------------------------------------------------------------
const METHOD_DEF = /^ {2}(?:(?:private|public|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

/** 取一个方法的参数表原文（支持跨行） */
function paramsOf(source, startIndex) {
  const open = source.indexOf("(", startIndex);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/** 把一个仓储文件切成 [{name, line, params, body}] */
function methodsOf(rawSource) {
  // 统一 CRLF：下面按「行号 × 偏移」切片，换行符多一个字符就会整体错位
  const source = rawSource.replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const found = [];
  let offset = 0;
  const offsets = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });
  lines.forEach((line, index) => {
    const m = METHOD_DEF.exec(line);
    if (!m) return;
    const name = m[1];
    if (name === "constructor") return;
    found.push({ name, line: index + 1, start: offsets[index] });
  });
  return found.map((item, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : source.length;
    const body = source.slice(item.start, end);
    return { ...item, params: paramsOf(source, item.start), body };
  });
}

/**
 * 方法体里出现的表（FROM / INTO / JOIN 之后那个词）
 *
 * **不算 `UPDATE <表>`**：这条规则盯的是「**读**出来的行把别区也算进来」，写语句（按主键
 * `UPDATE roles SET … WHERE id = ?`）写错行由「仓储签名带区 + 上游已解区」保证 —— 上游拿不到
 * 别区的 id（拿 id 的那一步是 `findById(zoneId, id)`，跨区直接 404）。把写入也算进来只会
 * 逼出一串「按主键写」的豁免条目，条目一多就没人看，规则等于废掉。
 * `INTO` 保留：`INSERT INTO roles (…)` 少了 `zone_id` 列是真错，得拦。
 */
function tablesIn(body) {
  const found = new Set();
  const re = /\b(?:FROM|INTO|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(body))) found.add(m[1].toLowerCase());
  return found;
}

/**
 * `roles` 是不是只被当作「按主键取一行的装饰」（标量子查询 / join 到外层已有的外键）
 *
 * 形态只有两种，都要求 `ON <别名>.id = …` / `WHERE <别名>.id = …`：
 *
 *   COALESCE((SELECT r.name FROM roles r WHERE r.id = g.leader_id), '') AS leader_name
 *   SELECT m.*, r.name AS role_name FROM guild_members m JOIN roles r ON r.id = m.role_id
 *
 * 这类引用捞不出别区的行 —— 行被外层的 id 钉死，最多取到那一行（取不到就是 NULL）。
 * 它们出现在帮会成员、组队成员、举报列表、审计流水、账号角色数这些「展示用 join」上，
 * 若也算违规，光靠豁免条目就得好几十条，而真正的漏点会被淹没在噪音里。
 *
 * **判据必须「全部引用都是装饰」才算数**：只要方法体里还有一处 `FROM roles` 是裸查
 * （`SELECT * FROM roles WHERE id = ?`、`SELECT id FROM roles WHERE name = ?`），照旧违规。
 */
const ROLE_REF = /\b(?:FROM|JOIN)\s+roles\b/gi;
const ROLE_PINNED = [
  /\(\s*SELECT\b[^()]*\bFROM\s+roles\s+(?:AS\s+)?([a-z_]\w*)[^()]*\bWHERE\s+\1\.id\s*=/gi,
  /\bJOIN\s+roles\s+(?:AS\s+)?([a-z_]\w*)\s+ON\s+\1\.id\s*=/gi,
];
function rolesAreDecorative(body) {
  const refs = (body.match(ROLE_REF) || []).length;
  if (refs === 0) return false;
  const pinned = ROLE_PINNED.reduce((total, re) => total + (body.match(re) || []).length, 0);
  return pinned === refs;
}

const HAS_ZONE_PARAM = /\bzone(?:Id)?\s*[?:]/;

for (const name of ZONE_SCOPED_REPOS) {
  const file = path.join(REPOS, name);
  const source = read(file);
  if (!source) {
    problem("repo-signature", file, 0, name, "zone-scoped 仓储文件不见了 —— 挪走就要同步改本审计（别让它静默失守）");
    continue;
  }
  for (const method of methodsOf(source)) {
    if (!WATCHED_METHODS.includes(method.name)) continue;
    if (HAS_ZONE_PARAM.test(method.params)) continue;
    report(
      "repo-signature",
      file,
      method.line,
      method.name,
      `${method.name}(…) 没有区形参 —— 调用方可以在编译期就「不带区查」。改成 zone 在前（findById(zoneId, id)），删掉单参版本，漏过滤就变成 tsc 报错`,
    );
  }
}

// ---------------------------------------------------------------------------
// 四、已带 zone_id 的表：SQL 必须真的过滤 zone（规则 3）
// ---------------------------------------------------------------------------
for (const file of walk(REPOS)) {
  const source = read(file);
  if (!source) continue;
  for (const method of methodsOf(source)) {
    const tables = tablesIn(method.body);
    let offending = TABLES_WITH_ZONE.filter((table) => tables.has(table));
    // `roles` 只当展览架（按主键取一行拼名字）时不算跨区读 —— 见 rolesAreDecorative
    if (offending.includes("roles") && rolesAreDecorative(method.body)) {
      offending = offending.filter((table) => table !== "roles");
    }
    if (offending.length === 0) continue;
    // 区感知的三种写法：WHERE 里过滤 / INSERT 自己写了 zone_id 列 / upsert 主键含 zone_id
    const zoneAware =
      /zone_id\s*(?:=|\bIN\b)/i.test(method.body) ||
      /INSERT\s+INTO\s+[a-z_]+\s*\([^)]*\bzone_id\b/i.test(method.body) ||
      /ON\s+CONFLICT\s*\([^)]*\bzone_id\b/i.test(method.body);
    if (zoneAware) continue;
    report(
      "repo-sql",
      file,
      method.line,
      method.name,
      `读写 ${offending.join(" / ")} 却没有 zone_id 过滤 —— 这条查询会把别的区的行也算进来`,
    );
  }
}

// ---------------------------------------------------------------------------
// 四·补、区可空的表：写入口必须自己写 zone_id（漏写 = 静默变全服）
// ---------------------------------------------------------------------------
for (const file of walk(REPOS)) {
  const source = read(file);
  if (!source) continue;
  for (const method of methodsOf(source)) {
    for (const table of TABLES_WITH_NULLABLE_ZONE) {
      // 只看**这条 SQL 自己**写的列：方法体里出现 `zone_id` 不算（后面的注释 / 别的语句也会提到它，
      // 一开始就写成「body 里有 zone_id 就放行」，结果漏写的 insert 因为下一段的注释而被放过）
      const insertCols = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)`, "i").exec(method.body);
      const updateSet = new RegExp(`UPDATE\\s+${table}\\s+SET\\s+([\\s\\S]*?)\\bWHERE\\b`, "i").exec(method.body);
      const writes = Boolean(insertCols || updateSet);
      if (!writes) continue;
      const written = `${insertCols ? insertCols[1] : ""} ${updateSet ? updateSet[1] : ""}`;
      if (/\bzone_id\b/.test(written)) continue;
      report(
        "repo-sql",
        file,
        method.line,
        method.name,
        `写 ${table} 却没有写 zone_id 列 —— 这条会静默把行落成「全服」（NULL），影响面从本区变成所有区`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 五、schema 漂移：表已经加了 zone_id，清单却没登记
// ---------------------------------------------------------------------------
{
  const schema = read(SCHEMA);
  if (!schema) {
    problem("schema", SCHEMA, 0, "database.service.ts", "读不到建表语句 —— 审计无法确认哪些表已有 zone_id，先修这个");
  } else {
    const blocks = new Map();
    const re = /CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\(([\s\S]*?)\n\s*\);/g;
    let m;
    while ((m = re.exec(schema))) blocks.set(m[1], m[2]);

    // 清单里的表必须真的还有 zone_id（被删列了就要同步改审计）
    for (const table of TABLES_WITH_ZONE) {
      if (!blocks.has(table)) {
        problem("schema", SCHEMA, 0, table, `${table} 在审计清单里，但建表语句里找不到它 —— 表被改名/删了？同步改本审计`);
      } else if (!/\bzone_id\b/.test(blocks.get(table))) {
        problem("schema", SCHEMA, 0, table, `${table} 在审计清单里，但建表语句里已经没有 zone_id 了 —— 清单与 schema 对不上`);
      }
    }

    // 盯着「将来要加列」的几张：加了就必须同时纳入审计（否则新列白加，SQL 照旧不过滤）
    for (const table of TABLES_BECOMING_ZONE_SCOPED) {
      if (!blocks.has(table) || !/\bzone_id\b/.test(blocks.get(table))) continue;
      if (TABLES_WITH_ZONE.includes(table)) continue;
      problem(
        "schema",
        SCHEMA,
        0,
        table,
        `${table} 已经有 zone_id 列：把它补进 TABLES_WITH_ZONE 让它的 SQL 开始受检，并清掉白名单里对应的租（加列那一刀必须同时做这一步）`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 六、白名单自身：条目必须命中，且必须写清 issue / reason
// ---------------------------------------------------------------------------
for (const entry of allowlist.entries ?? []) {
  if (!entry.rule || !entry.file || !entry.key) {
    problems.push({ rule: "allowlist", file: path.relative(ROOT, ALLOWLIST_FILE), line: 0, key: "?", hint: "白名单条目缺 rule / file / key 三件套" });
    continue;
  }
  if (!entry.issue || !entry.reason) {
    problems.push({
      rule: "allowlist",
      file: path.relative(ROOT, ALLOWLIST_FILE),
      line: 0,
      key: `${entry.file}#${entry.key}`,
      hint: "白名单条目必须写 issue（谁清）与 reason（为什么留）—— 没有归属的豁免三个月后没人敢删",
    });
    continue;
  }
  const id = allowKey(entry.rule, entry.file, entry.key);
  if (!usedAllowlistKeys.has(id)) {
    problems.push({
      rule: "allowlist",
      file: path.relative(ROOT, ALLOWLIST_FILE),
      line: 0,
      key: `${entry.file}#${entry.key}`,
      hint: `这条豁免已经不再命中任何违规（${entry.rule} / ${entry.file} / ${entry.key}）—— 代码改好了就删掉它，别让白名单只增不减`,
    });
    continue;
  }
  // 同一 (规则, 文件, 名字) 命中多处 = 又长出来一个同名方法被豁免顺带盖住了
  const hits = allowHitCount.get(id) ?? 0;
  if (hits > 1) {
    problems.push({
      rule: "allowlist",
      file: path.relative(ROOT, ALLOWLIST_FILE),
      line: 0,
      key: `${entry.file}#${entry.key}`,
      hint: `同一处豁免盖住了 ${hits} 处违规 —— 豁免是按名字给的，同名方法新长出来一个也算在内。请把名字改掉或拆分方法`,
    });
  }
}

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  const allowed = (allowlist.entries ?? []).length;
  console.log(
    `✓ 区边界：玩家侧零 zone 入参（controller / dto / service 三层）；` +
      `zone-scoped 仓储（${ZONE_SCOPED_REPOS.join(" / ")}）的按 id 查询无新增无区签名；` +
      `已带 zone_id 的表（${TABLES_WITH_ZONE.join(" / ")}）SQL 均过滤 zone；` +
      `存量豁免 ${allowed} 条（全部有 issue 与理由，清完请删）`,
  );
  process.exit(0);
}

console.error(`✗ 区边界：${problems.length} 处问题（区只能由服务端推导，详情见 docs/39 §2.4）\n`);
for (const item of problems) {
  // 把 key（方法名 / 白名单条目）也打出来：只说「某文件有问题」等于让人自己 grep，
  // 「同一处豁免盖住了 N 处」这类问题不点名是哪条豁免根本没法修
  const where = `${item.file}${item.line ? `:${item.line}` : ""}`;
  console.error(`  [${item.rule}] ${where}${item.key && item.key !== "?" ? ` · ${item.key}` : ""}`);
  console.error(`    ${item.hint}`);
}
process.exit(1);
