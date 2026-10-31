#!/usr/bin/env node
/**
 * 排行榜专项 e2e（server/test/e2e-rank.cjs，issue #400）
 *
 * 盯的不变量（改排行口径 / 名次规则 / 物化节奏后必须全绿）：
 * 一、等级榜：名次与数值逐个精确对；**并列同分同名次**（1、2、2、4）
 * 二、战力榜：低等级高养成的人排在前面 —— 证明这一榜读的是存档里的养成项，不是照抄等级
 * 三、击杀榜：直插的击杀数逐个对，并列规则与等级榜一致
 * 四、分页：翻页切片 / 最后一页不足 / size 超上榜条数被夹 / size·page 非法是 40000
 * 五、me：榜内 / 榜外（名次仍真实）/ 没有在线角色（rank=0）/ 未登录（401）
 * 六、快照语义：`LEADERBOARD_REFRESH_MS=0` 时改了等级榜不动、computedAt 不变
 * 七、非法榜与隐私：未知 board 是 40000；条目只有 8 个字段，不带 accountId / data / 在线状态
 * 八、定时重算：第二台服务（300ms 周期）改完等级等一拍，榜与名次跟着变、computedAt 变大
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:rank
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 上榜条数压到 4：六个角色就足够同时测「截断」与「me 在榜外但名次真实」 */
const TOP_N = 4;
/** 第二台服务的重算周期（毫秒）：够短才测得动「定时重算」，够长才不至于在断言之间乱跳 */
const REFRESH_MS = 300;

//#region 断言小工具（与 e2e-party / e2e-chat 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 56;
/** 管理端注册邀请码（改等级走运营侧 PATCH，见「六、快照语义」） */
const ADMIN_CODE = "e2e-rank-admin";

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

function assertExpectedCount() {
  if (passed === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passed + failed}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（make audit 会比对）");
  process.exitCode = 1;
}

//#endregion

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 起一台服务（文件库）；`extraEnv` 用来压上榜条数与重算周期 */
async function startServer(dbPath, extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-rank-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 默认这台是「快照语义」用：不起定时器，只在首次请求时算一次
      LEADERBOARD_REFRESH_MS: "0",
      LEADERBOARD_TOP_N: String(TOP_N),
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回唯一包裹体（code / message / data） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** 只取 data（成功路径上的断言用） */
async function data(baseUrl, method, route, options = {}) {
  const { body } = await api(baseUrl, method, route, options);
  return body && body.data;
}

/** 一份最小可建号的角色文档（e2e-party 同款）；`extra` 用来塞养成项造战力 */
function roleData(id, name, level, extra = {}) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills: {}, ...extra };
}

/** 注册账号 + 建一个在线角色 */
async function preparePlayer(baseUrl, username, roleId, roleName, level, extra = {}) {
  const registered = await data(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered && registered.token;
  await api(baseUrl, "POST", "roles", { token, body: { data: roleData(roleId, roleName, level, extra) } });
  return { token, roleId, name: roleName };
}

/** 注册并登录一个管理员（改等级要 `ROLE_WRITE`：等级是服务端写点，#550 起存档改不动它） */
async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { username, password } });
  return login.body && login.body.data && login.body.data.token;
}

/** 直插击杀数（造数：被测的是「榜怎么排名」，不是「击杀怎么记」——后者在 e2e-combat 里盯） */
function seedKills(dbPath, kills) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const update = db.prepare("UPDATE roles SET kills = ? WHERE id = ?");
  for (const [roleId, count] of Object.entries(kills)) update.run(count, roleId);
  db.close();
}

/** 榜的摘要（断言失败时打出来，别让人只看到 false） */
function snap(page) {
  if (!page) return "null";
  return `total=${page.total} ${page.list.map((entry) => `#${entry.rank}${entry.name}(Lv${entry.level}/C${entry.combat}/K${entry.kills})`).join(" ")}`;
}

/** 排名序列（断言并列规则用） */
function ranksOf(page) {
  return page ? page.list.map((entry) => entry.rank).join(",") : "";
}

/** 名字序列（断言顺序用） */
function namesOf(page) {
  return page ? page.list.map((entry) => entry.name).join(",") : "";
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-rank-"));
  const mainDb = path.join(dir, "main.db");
  const freshDb = path.join(dir, "fresh.db");
  let server = null;
  let refresher = null;

  try {
    server = await startServer(mainDb);
    const { baseUrl } = server;
    // 管理员：改等级要用它（等级是服务端写点，#550 起存档改不动）
    const adminToken = await registerAdmin(baseUrl, "rank_admin", "Rank#123456");
    check(!!adminToken, "准备：管理员已登录（改等级 / 造等级变化要用）");

    //#region 准备：六个角色（等级两两一组，丁戊己带养成项）

    group("准备：六个角色（甲10 / 乙8 / 丙8 / 丁5 / 戊3 / 己1，戊与己靠养成项堆战力）");

    const A = await preparePlayer(baseUrl, "rank_player_a", "rank_role_a", "甲十级", 10);
    const B = await preparePlayer(baseUrl, "rank_player_b", "rank_role_b", "乙八级", 8);
    const C = await preparePlayer(baseUrl, "rank_player_c", "rank_role_c", "丙八级", 8);
    const D = await preparePlayer(baseUrl, "rank_player_d", "rank_role_d", "丁五级", 5);
    // 戊 / 己：等级最低但战魂 / 称号 / 军衔拉满 —— 战力榜必须把它们排到前面（否则这一榜就是等级榜的复制）
    const E = await preparePlayer(baseUrl, "rank_player_e", "rank_role_e", "戊三级", 3, { soulOfWar: 30, title: 10, rank: 10 });
    const F = await preparePlayer(baseUrl, "rank_player_f", "rank_role_f", "己一级", 1, { soulOfWar: 30, title: 10, rank: 10 });
    check(
      [A, B, C, D, E, F].every((player) => !!player.token),
      "六个账号都注册并建好在线角色",
    );

    // 击杀数直插：甲30 / 乙20 / 丙20 / 丁10 / 戊5 / 己0（乙丙并列，用来验击杀榜的并列规则）
    seedKills(mainDb, { rank_role_a: 30, rank_role_b: 20, rank_role_c: 20, rank_role_d: 10, rank_role_e: 5, rank_role_f: 0 });
    // 再注册一个**不建角色**的账号：`me` 在没有在线角色时必须是 rank=0，而不是报错
    const idle = await data(baseUrl, "POST", "auth/register", { body: { username: "rank_player_idle", password: "pass1234" } });
    check(!!(idle && idle.token), "第七个账号注册成功（故意不建角色，用于 me 的「没有在线角色」）");

    //#endregion

    //#region 一、等级榜

    group("一、等级榜：名次与数值逐个对，并列同分同名次");

    const level1 = await data(baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    checkEqual(level1 && level1.total, TOP_N, `上榜条数被 LEADERBOARD_TOP_N 截断`);
    checkEqual(namesOf(level1), "甲十级,乙八级,丙八级,丁五级", "等级降序，六个角色只留前四");
    checkEqual(ranksOf(level1), "1,2,2,4", "并列同分同名次（1、2、2、4，跳过被占的 3）");
    checkEqual(level1 && level1.list[0].level, 10, "第一名等级 10");
    checkEqual(level1 && level1.list[1].level, 8, "第二名等级 8");
    checkEqual(level1 && level1.list[2].level, 8, "第三名等级也是 8（与第二名同分）");
    checkEqual(level1 && level1.list[3].level, 5, "第四名等级 5");

    //#endregion

    //#region 二、战力榜

    group("二、战力榜：读的是存档里的养成项，不是照抄等级");

    const combat1 = await data(baseUrl, "GET", "leaderboards/combat?size=10", { token: A.token });
    checkEqual(combat1 && combat1.total, TOP_N, "战力榜同样截断到上榜条数");
    checkEqual(namesOf(combat1), "戊三级,己一级,甲十级,乙八级", "低等级高养成的人排在前面（战力与等级不是同一个序）");
    checkEqual(ranksOf(combat1), "1,2,3,4", "战力两两不同，名次连续");
    check(
      !!combat1 && combat1.list.every((entry, index) => index === 0 || combat1.list[index - 1].combat >= entry.combat),
      "战力序列单调不增",
      combat1 && combat1.list.map((entry) => entry.combat).join(" >= "),
    );
    check(!!combat1 && combat1.list.every((entry) => entry.combat > 0), "每个上榜角色的战力都算得出来（不是一片 0）");
    check(
      !!combat1 && combat1.list[0].combat > combat1.list[2].combat,
      "戊三级（Lv3）的战力高过甲十级（Lv10）—— 战魂 / 称号 / 军衔都算进去了",
      combat1 && `${combat1.list[0].combat} > ${combat1.list[2].combat}`,
    );

    //#endregion

    //#region 三、击杀榜

    group("三、击杀榜：直插的击杀数逐个对，并列规则与等级榜一致");

    const kills1 = await data(baseUrl, "GET", "leaderboards/kills?size=10", { token: A.token });
    checkEqual(kills1 && kills1.total, TOP_N, "击杀榜同样截断到上榜条数");
    checkEqual(namesOf(kills1), "甲十级,乙八级,丙八级,丁五级", "击杀数降序");
    checkEqual(ranksOf(kills1), "1,2,2,4", "乙丙同为 20 杀 → 并列第 2，丁是第 4");
    checkEqual(kills1 && kills1.list[0].kills, 30, "榜首 30 杀");
    checkEqual(kills1 && kills1.list[3].kills, 10, "第四名 10 杀");

    //#endregion

    //#region 四、分页

    group("四、分页：切片 / 最后一页不足 / size 超上限被夹 / 非法参数");

    const page1 = await data(baseUrl, "GET", "leaderboards/level?page=1&size=2", { token: A.token });
    checkEqual(ranksOf(page1), "1,2", "第一页两条：名次 1、2");
    checkEqual(page1 && page1.total, TOP_N, "total 是上榜总条数，与 size 无关");

    const page2 = await data(baseUrl, "GET", "leaderboards/level?page=2&size=2", { token: A.token });
    checkEqual(ranksOf(page2), "2,4", "第二页接上并列的第 2 与第 4（切片而不是重新排名）");

    const page3 = await data(baseUrl, "GET", "leaderboards/level?page=3&size=2", { token: A.token });
    check(Array.isArray(page3 && page3.list) && page3.list.length === 0, "翻过最后一页返回空数组（不是 null / 不是报错）");

    const oversized = await data(baseUrl, "GET", "leaderboards/level?size=50", { token: A.token });
    checkEqual(oversized && oversized.size, TOP_N, `size 超过上榜条数被夹到 ${TOP_N}`);
    checkEqual(oversized && oversized.list.length, TOP_N, "夹完之后拿到的就是整个榜");

    const badSize = await api(baseUrl, "GET", "leaderboards/level?size=0", { token: A.token });
    checkEqual(badSize.body && badSize.body.code, 40000, "size=0 是参数错误 40000");
    const badPage = await api(baseUrl, "GET", "leaderboards/level?page=0", { token: A.token });
    checkEqual(badPage.body && badPage.body.code, 40000, "page=0 是参数错误 40000");

    //#endregion

    //#region 五、me

    group("五、me：榜内 / 榜外（名次仍真实）/ 没有在线角色 / 未登录");

    const selfLevel = await data(baseUrl, "GET", "leaderboards/level/me", { token: F.token });
    checkEqual(selfLevel && selfLevel.rank, 6, "己一级在等级榜第 6 名（榜只留 4 条，名次仍在全量里算）");
    check(!!(selfLevel && selfLevel.entry) && selfLevel.entry.name === "己一级", "榜外的人也能拿到自己那一条");
    checkEqual(selfLevel && selfLevel.entry && selfLevel.entry.level, 1, "自己那一条的等级是 1");

    const selfCombat = await data(baseUrl, "GET", "leaderboards/combat/me", { token: F.token });
    checkEqual(selfCombat && selfCombat.rank, 2, "同一个角色在战力榜是第 2 名（名次按榜各自算）");

    const selfKills = await data(baseUrl, "GET", "leaderboards/kills/me", { token: F.token });
    checkEqual(selfKills && selfKills.rank, 6, "己一级在击杀榜第 6 名（0 杀也是榜上的一员）");
    checkEqual(selfKills && selfKills.entry && selfKills.entry.kills, 0, "自己那一条的击杀数是 0");

    const idleSelf = await data(baseUrl, "GET", "leaderboards/level/me", { token: idle.token });
    checkEqual(idleSelf && idleSelf.rank, 0, "没有在线角色时 rank=0（不是 404）");
    check(!!idleSelf && idleSelf.entry === null, "没有在线角色时 entry=null");

    const anonymous = await api(baseUrl, "GET", "leaderboards/level/me");
    checkEqual(anonymous.status, 401, "未登录访问 me 是 401");

    //#endregion

    //#region 六、快照语义

    group("六、快照语义：REFRESH_MS=0 时改了等级榜不动（名次延迟是设计，不是 bug）");

    const beforeSnapshot = await data(baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    // 等级是服务端写点（#550 起存档里的上报值会被回填）：造「等级变了但快照还没重算」走运营侧 PATCH
    const raised = await data(baseUrl, "PATCH", "admin/roles/rank_role_a", { token: adminToken, body: { level: 20 } });
    checkEqual(raised && raised.level, 20, "甲的角色等级已改成 20（管理端 PATCH）");

    const afterSnapshot = await data(baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    checkEqual(afterSnapshot && afterSnapshot.list[0].level, 10, "榜上还是 10 级 —— 快照没重算");
    checkEqual(afterSnapshot && afterSnapshot.computedAt, beforeSnapshot && beforeSnapshot.computedAt, "computedAt 没变（还是同一份快照）");
    const selfAfter = await data(baseUrl, "GET", "leaderboards/level/me", { token: A.token });
    checkEqual(selfAfter && selfAfter.rank, 1, "me 也还是旧名次（它和列表读的是同一份快照）");

    //#endregion

    //#region 七、非法榜与隐私

    group("七、非法榜与隐私：未知 board 是 40000；条目不带 accountId / data / 在线状态");

    const badBoard = await api(baseUrl, "GET", "leaderboards/nope", { token: A.token });
    checkEqual(badBoard.body && badBoard.body.code, 40000, "未知榜单是参数错误 40000");
    check(
      !!(badBoard.body && badBoard.body.message && badBoard.body.message.includes("level")),
      "错误信息里列出可选的榜（不是干巴巴一句「参数错误」）",
      badBoard.body && badBoard.body.message,
    );

    const entryKeys = Object.keys((afterSnapshot && afterSnapshot.list[0]) || {}).sort().join(",");
    checkEqual(entryKeys, "combat,kills,level,name,occupation,rank,roleId,zoneId", "条目恰好八项");
    check(!entryKeys.includes("accountId") && !entryKeys.includes("account"), "条目不带账号 id（对外数据不暴露关联键）");
    check(!entryKeys.includes("data"), "条目不带整份存档");
    check(!entryKeys.includes("online"), "条目不带在线状态（在线状态会让人蹲点）");
    checkEqual(afterSnapshot && afterSnapshot.list[0].zoneId, 1, "条目带归属区服（用于展示「来自 X 区」）");

    //#endregion

    //#region 八、定时重算（第二台服务）

    group("八、定时重算：300ms 周期下改完等级，等一拍就变新");

    refresher = await startServer(freshDb, { LEADERBOARD_REFRESH_MS: String(REFRESH_MS), LEADERBOARD_TOP_N: "10" });
    const freshA = await preparePlayer(refresher.baseUrl, "rank_fresh_a", "rank_fresh_a", "先锋", 5);
    const freshB = await preparePlayer(refresher.baseUrl, "rank_fresh_b", "rank_fresh_b", "后进", 7);

    const freshBefore = await data(refresher.baseUrl, "GET", "leaderboards/level", { token: freshA.token });
    checkEqual(namesOf(freshBefore), "后进,先锋", "第一次查询就把榜算出来了（惰性首算，不需要预热）");

    const freshAdmin = await registerAdmin(refresher.baseUrl, "rank_fresh_admin", "Rank#12345");
    await data(refresher.baseUrl, "PATCH", "admin/roles/rank_fresh_a", { token: freshAdmin, body: { level: 12 } });
    const freshRight = await data(refresher.baseUrl, "GET", "leaderboards/level", { token: freshA.token });
    checkEqual(namesOf(freshRight), "后进,先锋", "改完立刻查还是旧顺序（快照期内不跳名）");

    const freshAfter = await waitForBoard(refresher.baseUrl, freshA.token, (page) => namesOf(page) === "先锋,后进" && page);
    check(!!freshAfter, `等过 ${REFRESH_MS}ms 的周期后榜自己变新（先锋升到 12 级排到第一）`, snap(freshAfter));
    checkEqual(freshAfter && freshAfter.list[0].level, 12, "重算后的等级是 12");
    check(
      !!(freshAfter && freshBefore && freshAfter.computedAt > freshBefore.computedAt),
      "computedAt 变大了（客户端据此知道「榜刷新过」）",
      freshAfter && `${freshBefore.computedAt} → ${freshAfter.computedAt}`,
    );

    const freshSelf = await data(refresher.baseUrl, "GET", "leaderboards/level/me", { token: freshA.token });
    checkEqual(freshSelf && freshSelf.rank, 1, "me 跟着重算变成第 1 名");

    check(!!(freshB.token), "第二个角色也在（榜上的对照项）");

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push("脚本异常");
    console.log(`\n[!!] 脚本异常：${error && error.stack ? error.stack : error}`);
    if (server) console.log("主服务日志尾部：\n" + server.logs().split("\n").slice(-20).join("\n"));
    if (refresher) console.log("第二台服务日志尾部：\n" + refresher.logs().split("\n").slice(-20).join("\n"));
  } finally {
    if (server) server.child.kill();
    if (refresher) refresher.child.kill();
  }

  console.log(`\n${failed === 0 ? "✔" : "✘"} ${passed} 通过 / ${failed} 失败`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const label of failures) console.log(`  - ${label}`);
  }
  assertExpectedCount();
  if (failed > 0) process.exitCode = 1;
})();

/** 轮询等榜变成期望的样子（定时重算要等一拍） */
async function waitForBoard(baseUrl, token, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await data(baseUrl, "GET", "leaderboards/level", { token });
    const result = probe(page);
    if (result) return result;
    await sleep(60);
  }
  return null;
}
