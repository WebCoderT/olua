#!/usr/bin/env node
/**
 * 双进程形态专项 e2e（server/test/e2e-dual.cjs，issue #175 / #37 拆进程②）
 *
 * 与其他 e2e 的根本差别：**起两个进程** ——
 * - 存档进程（`dist/main.js`，`REALTIME_EMBEDDED=false`）：HTTP API 全量，实时模块不装载；
 * - 实时进程（`dist/main.realtime.js`）：WS 通道 + 取票 + 世界权威 + 结算。
 *   两进程**共享同一个临时文件库**（WAL + busy_timeout 由 DatabaseService 打开）。
 *
 * 盯的不变量（改进程拆分后必须全绿）：
 * 一、形态拆分：存档进程没有实时接口（取票 404）；实时进程的守卫拿同一份库校验令牌
 *     （跨进程「你是谁」成立，取票 → WS → welcome 一路通）
 * 二、实时进程业务：worldJoin 播种、cast 结算（读库里的角色与技能）都在实时进程跑通；
 *     落盘节流过后，测试进程**以第三方读者身份**打开库文件看到 world_monsters 有行
 *     —— 实时进程的写对其他进程可见（WAL 承接跨进程写的证据）
 * 三、踢下线跨进程：管理端在**存档进程**清在线角色标记，实时进程巡检在间隔内断开
 *     连接（close 4000）—— 跨进程没有推送通道，轮询库标记是唯一通路
 * 四、令牌作废跨进程：管理端重置密码（token_version +1），旧令牌在**实时进程**取票被拒
 *     —— 守卫每次对库比对版本号，天然跨进程
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const MAIN_ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const REALTIME_ENTRY = path.join(SERVER_DIR, "dist", "main.realtime.js");

//#region 断言小工具（与 e2e-world 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 14;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
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

/** 取一个空闲端口（避免与开发中的服务撞端口） */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(25);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 起一台服务（共享 env 的公共部分在这里收口）
 * - 存档进程：REALTIME_EMBEDDED=false —— 本套件的被测形态
 * - 实时进程：巡检间隔调小（100ms），踢下线段才不用干等 3 秒
 */
async function startProcess(entry, label, env, portEnv = "PORT") {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      API_PREFIX: "api",
      JWT_SECRET: "e2e-dual-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ...env,
      [portEnv]: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label}提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error(`等待${label}启动超时\n${chunks.join("")}`);
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

/** 一条会话化的 WS 连接（welcome / world / settle 分类收集，close 带码记录） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    closeCode: null,
    welcomes: [],
    settles: [],
    worlds: [],
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", (code) => {
    session.closed = true;
    session.closeCode = code;
  });
  return session;
}

/**
 * 预先往共享库里插刷怪区（#295）：地图 1 一区一只怪物 1，与旧播种计划等价。
 * 表先建好再插行，服务端启动时的建表与空表 seed 都不会动它。
 */
function seedSpawnAreas(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS map_spawn_areas (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id      TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        monster_key TEXT    NOT NULL,
        min         INTEGER NOT NULL DEFAULT 0,
        max         INTEGER NOT NULL DEFAULT 0,
        cx          REAL    NOT NULL,
        cy          REAL    NOT NULL,
        w           REAL    NOT NULL,
        h           REAL    NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );`);
  db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("1", "1号怪物", "1", 0, 1, 100, 200, 100, 100, Date.now());
  db.close();
}

/** 一份最小可建号的角色文档（e2e-combat 同款口径） */
function roleData(id, name, level, skills) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-dual-${process.pid}-${Date.now()}.db`);
  // 预插刷怪区（#295：播种来源 = map_spawn_areas，客户端不再上报计划）；
  // 库本来就是先建的文件（双进程共享的前提），起进程前把表和种子插好
  seedSpawnAreas(dbPath);
  // 两个进程共享同一个库文件；实时进程的巡检间隔调小，踢下线段才不用干等
  const shared = {
    DB_PATH: dbPath,
    REALTIME_KICK_POLL_MS: "100",
    WORLD_PERSIST_MS: "500",
    ADMIN_REGISTER_CODE: "dual-admin-code",
  };
  const main = await startProcess(MAIN_ENTRY, "存档进程", { ...shared, REALTIME_EMBEDDED: "false" });
  const realtime = await startProcess(REALTIME_ENTRY, "实时进程", shared, "REALTIME_PORT");
  try {
    const { baseUrl } = main;
    const { baseUrl: rtUrl } = realtime;

    //#region 准备：账号 / 角色（全在存档进程）

    group("准备：账号与角色（存档进程）");
    const player = await api(baseUrl, "POST", "auth/register", { body: { username: "dual_player", password: "pass1234" } });
    const token = player.body.data && player.body.data.token;
    check(!!token, "准备：注册玩家拿到令牌", player.body.message);
    const accountId = player.body.data && player.body.data.account && player.body.data.account.id;

    // 先建不带技能的空号，再 PUT 补技能（与 e2e-combat 同一条已验证的建号路径）
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleData("dual_r1", "双进程斗士", 5, {}) } });
    check(created.body.code === 0 && created.body.data.online === true, "准备：角色已创建并自动在线", created.body.message);
    const roleId = created.body.data && created.body.data.id;
    const saved = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: roleData("dual_r1", "双进程斗士", 5, { 1000: 1 }) } });
    checkEqual(saved.body.code, 0, "准备：角色补上技能 1000", saved.body.message);

    //#endregion

    //#region 一、形态拆分

    group("一、存档进程没有实时接口；实时进程凭同一份库校验令牌");

    const mainTicket = await fetch(`${baseUrl}/api/realtime/ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    checkEqual(mainTicket.status, 404, "存档进程（REALTIME_EMBEDDED=false）取票接口 404（实时模块确实没装载）");

    const ticket = await api(rtUrl, "POST", "realtime/ticket", { token });
    const ticketValue = ticket.body.data && ticket.body.data.ticket;
    check(ticket.body.code === 0 && !!ticketValue, "实时进程取票成功（守卫拿同一份库校验了令牌）", ticket.body.message);

    const wsUrl = `${rtUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticketValue)}`;
    const session = connect(wsUrl);
    await waitFor("握手成功", async () => (session.welcomes.length > 0 ? session : null));
    check(session.opened && session.welcomes.length === 1, "实时连接已建立并收到 welcome");

    //#endregion

    //#region 二、实时进程业务与跨进程写

    group("二、播种与结算在实时进程跑通；写库对第三方读者可见");

    const world = await session.joinWorld("1");
    const mob = world && world.monsters && world.monsters[0];
    check(mob && /^m1_\d+$/.test(mob.instanceId), "worldJoin 播种 1 只怪（服务端发牌）", JSON.stringify(world));

    session.socket.send(JSON.stringify({ type: "cast", data: { castId: 1, skillId: "1000", targetId: mob ? mob.instanceId : "m1_1", monsterKey: "1" } }));
    const settle = await session.waitForSettle(1);
    check(settle && settle.ok === true, "cast 结算成功（实时进程读同一份库里的角色与技能）", JSON.stringify(settle));

    // 落盘节流（500ms）过后，测试进程以「另一个读者」身份开库看 world_monsters：
    // 实时进程写、其他进程可见 —— WAL 承接跨进程写的直接证据
    await sleep(1200);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM world_monsters").get();
    db.close();
    check(rows && rows.n >= 1, "world_monsters 已落盘（测试进程开只读连接可见）", `rows=${rows && rows.n}`);

    //#endregion

    //#region 三、踢下线跨进程

    group("三、存档进程踢下线，实时进程巡检断连");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "dual_super", password: "super-pass-1", registerCode: "dual-admin-code" },
    });
    const adminToken = adminReg.body.data && adminReg.body.data.token;
    check(!!adminToken, "准备：超管已在存档进程注册", adminReg.body.message);

    const kick = await api(baseUrl, "POST", `admin/accounts/${accountId}/offline`, { token: adminToken });
    checkEqual(kick.body.code, 0, "存档进程踢下线成功（清 online_role_id）", kick.body.message);

    const closed = await waitFor("连接被巡检断开", async () => (session.closed ? session : null), 5_000);
    check(closed && closed.closeCode === 4000, "实时进程在巡检间隔内断开连接（close 4000）", `code=${closed && closed.closeCode}`);

    //#endregion

    //#region 四、令牌作废跨进程

    group("四、存档进程重置密码，旧令牌在实时进程被拒");

    const reset = await api(baseUrl, "PATCH", `admin/accounts/${accountId}/password`, { token: adminToken, body: { password: "new-pass-99" } });
    checkEqual(reset.body.code, 0, "存档进程重置密码成功（token_version +1）", reset.body.message);

    const stale = await api(rtUrl, "POST", "realtime/ticket", { token });
    check(stale.body.code !== 0, "旧令牌在实时进程取票被拒（守卫对库比对版本号）", stale.body.message);

    //#endregion
  } finally {
    for (const server of [realtime, main]) {
      if (!server.child.signalCode && server.child.exitCode === null) server.child.kill("SIGTERM");
    }
    // 给两个进程一点优雅退出时间，然后清理临时库
    await sleep(500);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* 本来就不在 */
      }
    }
  }

  console.log(`\n===== e2e-dual：${passed} 通过 / ${failed} 失败 =====`);
  assertExpectedCount();
  if (failures.length > 0) {
    console.log("\n失败明细：");
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("\n[e2e-dual] 套件异常：", error && error.message);
  process.exitCode = 1;
});
