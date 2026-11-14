#!/usr/bin/env node
/**
 * 分区榜 e2e（server/test/e2e-zone-leaderboard.cjs，issue #959 / docs/39 §3.6）
 *
 * 盯的不变量（榜从「全服混排」收成「分区榜」之后必须全绿）：
 * 一、一区榜只含一区的角色（总数、名字、条目上的 zoneId 三者都要对）
 * 二、二区榜只含二区的角色 —— 两个区同名次互不挤占
 * 三、`me` 用**在线角色所在区**算名次（跨区看着别的地方也拿不到错的名次）
 * 四、空区返回空榜（`list = []` / `total = 0`），不是 500 也不是 404
 * 五、管理端 `GET /admin/leaderboards/:board` 按 `X-Zone-Id` 切区；缺头 / 无效头 → 400 `ZONE_REQUIRED`
 * 六、玩家侧**不收** `?zoneId=`：带别区的 id 与不带逐字节一致
 * 七、`topN` **按区各截一次**（不是全服截完再分组 —— 那样小区永远上不了榜）
 *
 * 为什么单独一条：`e2e-rank` 验的是「名次怎么算」（并列 / 分页 / 快照 / 定时重算），
 * 它只有一个区，**区这一维永远覆盖不到**；而「榜是跨区信息泄露最容易的出口」
 * 恰恰是这一维决定的（全服榜上能直接看到别区的名字、等级、战力）。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：`npm run test:e2e:zone-leaderboard`
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理端注册邀请码（提级要走 `PATCH /admin/roles/:id`） */
const ADMIN_CODE = "e2e-zone-leaderboard-admin";
/** 第一台服务：上榜条数给足（三个角色都要能看见），不起定时器（快照语义，别在断言之间乱跳） */
const TOP_N = 10;

//#region 断言小工具（与 e2e-rank / e2e-zone-chat 同款口径）

const failures = [];
let passed = 0;
let failed = 0;

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
      JWT_SECRET: "e2e-zone-leaderboard-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LEADERBOARD_REFRESH_MS: "0",
      LEADERBOARD_TOP_N: String(TOP_N),
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

/** 发一次请求，返回 { status, body }（唯一包裹体：code / message / data） */
/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
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

/** 注册 + 建角（可选先切区）；`level` 不是 1 时由管理端提级
 *
 * 建号入参的 `level` 从 #554 起被钉成出厂值 1，所以「造一个 9 级号」必须两步：
 * 建号 → 管理端 PATCH（等级是服务端权威字段，唯一正规写点）。
 */
async function preparePlayer(baseUrl, adminToken, username, roleName, level, zoneId) {
  const registered = await data(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered && registered.token;
  if (zoneId !== undefined) {
    const selected = await api(baseUrl, "POST", "zones/select", { token, body: { zoneId } });
    if (!selected.body || selected.body.code !== 0) {
      throw new Error(`切区失败 ${username} → ${zoneId}：${selected.body && selected.body.message}`);
    }
  }
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  const role = created.body && created.body.data;
  if (!role) throw new Error(`建角失败 ${username}：${created.body && created.body.message}`);
  if (level !== 1) {
    const raised = await api(baseUrl, "PATCH", `admin/roles/${role.id}`, { token: adminToken, zoneId: zoneId ?? ADMIN_ZONE, body: { level } });
    if (!raised.body || raised.body.code !== 0) {
      throw new Error(`提级失败 ${roleName} → ${level}：${raised.body && raised.body.message}`);
    }
  }
  return { token, roleId: role.id, zoneId: role.zoneId, name: roleName };
}

/** 名字序列（断言「榜上是谁」用） */
const namesOf = (page) => (page ? page.list.map((entry) => entry.name).join(",") : "");
/** 名次序列（断言「名次怎么排」用） */
const ranksOf = (page) => (page ? page.list.map((entry) => entry.rank).join(",") : "");
/** 条目上的区（断言「没有别区的行混进来」用） */
const zonesOf = (page) => (page ? page.list.map((entry) => entry.zoneId).join(",") : "");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-zone-leaderboard-"));
  const dbPath = path.join(dir, "world.db");
  const servers = [];

  try {
    const main = await startServer(dbPath);
    servers.push(main);
    const { baseUrl } = main;

    //#region 准备：一区 3 人 + 二区 3 人 + 一个空区

    group("准备：一区甲10/乙6/丙3、二区丁9/戊5/己1，另开一个没人角色的三区");

    const adminRegistered = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_board_admin", password: "Admin#1234", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "zone_board_admin", password: "Admin#1234" },
    });
    const adminToken = adminRegistered.body?.data?.token ?? adminLogin.body?.data?.token;
    check(!!adminToken, "管理员已登录（提级 / 后台看榜都要用）");

    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const zone2Id = zone2.body?.data?.id;
    const zone3 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "三区" } });
    const zone3Id = zone3.body?.data?.id;
    check(!!zone2Id && !!zone3Id, "开二区、三区（三区不建角色，用来验空榜）", `${zone2Id} / ${zone3Id}`);

    const A = await preparePlayer(baseUrl, adminToken, "zb_player_a", "区榜甲", 10);
    const B = await preparePlayer(baseUrl, adminToken, "zb_player_b", "区榜乙", 6);
    const C = await preparePlayer(baseUrl, adminToken, "zb_player_c", "区榜丙", 3);
    const D = await preparePlayer(baseUrl, adminToken, "zb_player_d", "区榜丁", 9, zone2Id);
    const E = await preparePlayer(baseUrl, adminToken, "zb_player_e", "区榜戊", 5, zone2Id);
    const F = await preparePlayer(baseUrl, adminToken, "zb_player_f", "区榜己", 1, zone2Id);
    check(
      [A, B, C].every((player) => player.zoneId === 1),
      "一区三个角色确实落在 1 区",
      [A, B, C].map((player) => player.zoneId).join(","),
    );
    check(
      [D, E, F].every((player) => player.zoneId === zone2Id),
      "二区三个角色确实落在二区（先选服再建角，不是搬家）",
      [D, E, F].map((player) => player.zoneId).join(","),
    );

    //#endregion

    //#region 一、二、两个区的榜各看各的

    group("一、一区榜：只有一区三个人，名次在区内算");

    const zone1Level = await data(baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    checkEqual(zone1Level && zone1Level.total, 3, "一区榜只有 3 条（不是全服的 6 条）");
    checkEqual(namesOf(zone1Level), "区榜甲,区榜乙,区榜丙", "一区榜是甲乙丙（等级降序）");
    checkEqual(ranksOf(zone1Level), "1,2,3", "名次在区内从 1 开始");
    checkEqual(zonesOf(zone1Level), "1,1,1", "每一条的 zoneId 都是 1（没有别区的行混进来）");
    check(
      !namesOf(zone1Level).includes("区榜丁"),
      "二区的角色一次都没出现在一区榜上",
      namesOf(zone1Level),
    );

    group("二、二区榜：同样只有本区，名次与一区互不挤占");

    const zone2Level = await data(baseUrl, "GET", "leaderboards/level?size=10", { token: D.token });
    checkEqual(zone2Level && zone2Level.total, 3, "二区榜也是 3 条（一区的人没有把二区挤掉）");
    checkEqual(namesOf(zone2Level), "区榜丁,区榜戊,区榜己", "二区榜是丁戊己");
    checkEqual(ranksOf(zone2Level), "1,2,3", "二区自己的名次也从 1 开始（不是接着一区往下编）");
    checkEqual(zonesOf(zone2Level), `${zone2Id},${zone2Id},${zone2Id}`, "每一条的 zoneId 都是二区");
    check(
      !namesOf(zone2Level).includes("区榜甲"),
      "一区的角色一次都没出现在二区榜上",
      namesOf(zone2Level),
    );
    check(
      !!zone2Level && zone2Level.list[0].level === 9,
      "二区榜首是 9 级（不是全服第一的 10 级）",
      zone2Level && String(zone2Level.list[0].level),
    );

    //#endregion

    //#region 三、me 按在线角色所在区取名次

    group("三、me：名次取自己在的那个区");

    const selfA = await data(baseUrl, "GET", "leaderboards/level/me", { token: A.token });
    checkEqual(selfA && selfA.rank, 1, "一区甲在自己的区是第 1 名");
    checkEqual(selfA && selfA.entry && selfA.entry.zoneId, 1, "自己那一条的区是 1");
    const selfC = await data(baseUrl, "GET", "leaderboards/level/me", { token: C.token });
    checkEqual(selfC && selfC.rank, 3, "一区丙在自己的区是第 3 名（区内名次，不是全服第 6）");
    const selfD = await data(baseUrl, "GET", "leaderboards/level/me", { token: D.token });
    checkEqual(selfD && selfD.rank, 1, "二区丁在**二区**是第 1 名（me 不按「谁在看」的区算，按角色的区算）");
    checkEqual(selfD && selfD.entry && selfD.entry.zoneId, zone2Id, "二区丁那一条的区是二区");
    const selfF = await data(baseUrl, "GET", "leaderboards/level/me", { token: F.token });
    checkEqual(selfF && selfF.rank, 3, "二区己是第 3 名（不是全服第 6）");

    //#endregion

    //#region 四、空区返回空榜

    group("四、空区：三区一个人都没有 —— 空榜，不是 500 / 不是 404");

    const G = await data(baseUrl, "POST", "auth/register", { body: { username: "zb_player_g", password: "pass1234" } });
    const gToken = G && G.token;
    const gSelect = await api(baseUrl, "POST", "zones/select", { token: gToken, body: { zoneId: zone3Id } });
    checkEqual(gSelect.body && gSelect.body.code, 0, "账号 G 切到三区（不建角色）");
    const emptyPlayer = await api(baseUrl, "GET", "leaderboards/level", { token: gToken });
    checkEqual(emptyPlayer.status, 200, "空区榜是 200");
    checkEqual(emptyPlayer.body && emptyPlayer.body.code, 0, "空区榜 code=0");
    checkEqual(emptyPlayer.body?.data?.total, 0, "空区榜 total=0");
    check(
      Array.isArray(emptyPlayer.body?.data?.list) && emptyPlayer.body.data.list.length === 0,
      "空区榜 list 是空数组（不是 null）",
      JSON.stringify(emptyPlayer.body?.data?.list),
    );
    check(
      typeof emptyPlayer.body?.data?.computedAt === "number" && emptyPlayer.body.data.computedAt > 0,
      "空榜照样有 computedAt（快照语义一致，客户端不用为它写分支）",
    );

    //#endregion

    //#region 五、管理端按 X-Zone-Id 切区

    group("五、管理端：同一个接口按 X-Zone-Id 出不同区的榜");

    const adminZone1 = await api(baseUrl, "GET", "admin/leaderboards/level?size=10", { token: adminToken, zoneId: 1 });
    checkEqual(adminZone1.body && adminZone1.body.code, 0, "后台看 1 区的榜成功");
    checkEqual(namesOf(adminZone1.body?.data), "区榜甲,区榜乙,区榜丙", "1 区后台榜是甲乙丙");
    const adminZone2 = await api(baseUrl, "GET", "admin/leaderboards/level?size=10", {
      token: adminToken,
      zoneId: zone2Id,
    });
    checkEqual(namesOf(adminZone2.body?.data), "区榜丁,区榜戊,区榜己", "切到二区后榜变成丁戊己（同一接口）");
    checkEqual(zonesOf(adminZone2.body?.data), `${zone2Id},${zone2Id},${zone2Id}`, "二区后台榜的条目区都是二区");
    const adminEmpty = await api(baseUrl, "GET", "admin/leaderboards/level", { token: adminToken, zoneId: zone3Id });
    checkEqual(adminEmpty.body?.data?.total, 0, "后台看空区也是空榜");

    // 刻意不带 X-Zone-Id（不传 zoneId 选项 → 请求上就没有这个头）
    const adminNoHeader = await api(baseUrl, "GET", "admin/leaderboards/level", { token: adminToken });
    checkEqual(adminNoHeader.status, 400, "不带 X-Zone-Id 是 400（管理端一次只在一个区里干活）");
    checkEqual(adminNoHeader.body && adminNoHeader.body.code, 50029, "不带 X-Zone-Id 的码是 ZONE_REQUIRED(50029)");
    const adminBadHeader = await api(baseUrl, "GET", "admin/leaderboards/level", { token: adminToken, zoneId: 9999 });
    checkEqual(adminBadHeader.body && adminBadHeader.body.code, 50029, "指向不存在的区同样是 50029（先选个区）");
    const adminBadBoard = await api(baseUrl, "GET", "admin/leaderboards/nope", { token: adminToken, zoneId: 1 });
    checkEqual(adminBadBoard.body && adminBadBoard.body.code, 40000, "未知榜名仍是 40000（区校验不掩盖参数校验）");
    const playerOnAdmin = await api(baseUrl, "GET", "admin/leaderboards/level", { token: A.token, zoneId: 1 });
    check(playerOnAdmin.status === 401 || playerOnAdmin.status === 403, "玩家令牌进不了后台榜单", String(playerOnAdmin.status));

    //#endregion

    //#region 六、玩家侧不收 zoneId

    group("六、玩家侧不收 ?zoneId=：带上别区的 id 与不带逐字节一致");

    const plain = await api(baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    const withParam = await api(baseUrl, "GET", `leaderboards/level?size=10&zoneId=${zone2Id}`, { token: A.token });
    check(
      JSON.stringify(plain.body && plain.body.data) === JSON.stringify(withParam.body && withParam.body.data),
      "带 ?zoneId=<二区> 与不带的数据完全一致（参数不读）",
    );
    checkEqual(namesOf(withParam.body?.data), "区榜甲,区榜乙,区榜丙", "带 ?zoneId=<二区> 拿到的仍是一区榜");

    //#endregion

    //#region 七、topN 按区各截一次

    group("七、topN 按区各截一次：第二台服务把上榜条数压到 2");

    const limited = await startServer(dbPath, { LEADERBOARD_TOP_N: "2" });
    servers.push(limited);
    const zone1Limited = await data(limited.baseUrl, "GET", "leaderboards/level?size=10", { token: A.token });
    checkEqual(zone1Limited && zone1Limited.total, 2, "一区榜截到 2 条");
    checkEqual(namesOf(zone1Limited), "区榜甲,区榜乙", "一区留下的是一区的头两名");
    const zone2Limited = await data(limited.baseUrl, "GET", "leaderboards/level?size=10", { token: D.token });
    checkEqual(zone2Limited && zone2Limited.total, 2, "二区榜也各自截到 2 条（不是全服截完再分组）");
    checkEqual(namesOf(zone2Limited), "区榜丁,区榜戊", "二区留下的是二区自己的头两名");

    //#endregion
  } finally {
    for (const server of servers) {
      try {
        server.child.kill();
      } catch {
        /* 已退出 */
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 分区榜 e2e ${failed === 0 ? "全绿" : "有失败"}（${passed} 通过 / ${failed} 失败）`);
  if (failed > 0) {
    console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
})();
