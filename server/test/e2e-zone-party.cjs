#!/usr/bin/env node
/**
 * 组队带区 e2e（server/test/e2e-zone-party.cjs，issue #958 / docs/39 §3.4）
 *
 * 盯的不变量：
 * 一、跨区邀请被拒（`PARTY_ZONE_MISMATCH` 50149），且**不会顺手建一支空队** ——
 *     区检查在建队之前
 * 二、同区邀请 / 同意照旧（邀请帧带发起人的区，同意时再比一次）
 * 三、两个区各自组队互不影响（二区的两人能正常组起来）
 * 四、经验分成按**房号**（`zone:map:slot`）：跨区同队已经不可能（见一），
 *     「同区同房照旧分」由 `e2e-party` 第九组覆盖 —— 这里不再重复造战斗
 *
 * 为什么单独一条：`e2e-party` 只有一个区，「跨区邀请」这条路它走不到。
 * 而这条路正是 #958 之前最现成的跨区入口（`existsById` 当时是全库查）。
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具

const failures = [];
let passed = 0;
let failed = 0;

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

//#endregion

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

async function waitFor(label, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  console.log(`  [..] 等待超时：${label}`);
  return null;
}

async function startServer(dbPath) {
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
      JWT_SECRET: "e2e-zone-party-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-party-admin-code",
      // 门槛压成 1 级：本套验的是区边界，不是等级门槛（那条由 e2e-party 第十一组覆盖）
      PARTY_MIN_LEVEL: "1",
      MONSTER_AI_POS_STALE_MS: "60000",
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

/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
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
  return body;
}

async function preparePlayer(baseUrl, username, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token, roleId: created.data && created.data.id, zoneId: created.data && created.data.zoneId };
}

/** 库里现在有几支队伍（「被拒的邀请不能留下空队」只能这样验） */
function countParties(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT COUNT(1) AS total FROM parties").get().total;
  } finally {
    db.close();
  }
}

/** 一条收集 party / partyInvite / error 帧的 WS 连接 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    welcomes: [],
    parties: [],
    invites: [],
    errors: [],
    worlds: 0,
    send(type, data) {
      session.socket.send(JSON.stringify({ type, data }));
    },
    partyAction(action, roleId) {
      session.send("party", { action, roleId });
    },
  };
  socket.on("open", () => {});
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "party") session.parties.push(frame.data);
      if (frame.type === "partyInvite") session.invites.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
      if (frame.type === "world") session.worlds += 1;
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {});
  return session;
}

/**
 * 先记下快照条数，再发动作，然后等**这一条之后**的新快照
 *
 * 组队动作成功 = 发起人收到自己的一份最新快照（客户端只认快照，不自己推状态）。
 * 必须按「动作之后的增量」取：`slice(-1)[0]` 会撞上动作之前的旧快照，断言就变成假绿。
 */
async function expectSnapshot(session, action, label) {
  const mark = session.parties.length;
  action();
  return waitFor(label, async () => (session.parties.length > mark ? session.parties[session.parties.length - 1] : null));
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-party-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：一区 A/B、二区 C/D，四个人都在「1 图」

    group("准备：一区 A/B、二区 C/D —— 四人都在「1 图」");
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_party_super", password: "super-pass-1", registerCode: "zone-party-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id, "开一个二区", JSON.stringify(zone2.data));

    const A = await preparePlayer(baseUrl, "zp_player_a", "队甲");
    const B = await preparePlayer(baseUrl, "zp_player_b", "队乙");
    const C = await preparePlayer(baseUrl, "zp_player_c", "队丙");
    const D = await preparePlayer(baseUrl, "zp_player_d", "队丁");
    check(!!(A.roleId && B.roleId && C.roleId && D.roleId), "四个账号都建好在线角色");

    // C / D 切到二区再建角（切区会清在线角色，所以先切再建）
    for (const player of [C, D]) {
      await api(baseUrl, "POST", "zones/select", { token: player.token, body: { zoneId: zone2Id } });
    }
    const cRole = await api(baseUrl, "POST", "roles", { token: C.token, body: { name: "队丙二区", occupation: "1", sex: "1" } });
    const dRole = await api(baseUrl, "POST", "roles", { token: D.token, body: { name: "队丁二区", occupation: "1", sex: "1" } });
    check(!!(cRole.data && cRole.data.id) && !!(dRole.data && dRole.data.id), "C / D 在二区建好角色");
    checkEqual(cRole.data && cRole.data.zoneId, zone2Id, "C 的角色属于二区");
    C.roleId = cRole.data && cRole.data.id;
    D.roleId = dRole.data && dRole.data.id;

    placeRolesAt(dbPath, "1", ["队甲", "队乙", "队丙二区", "队丁二区"]);

    const tickets = await Promise.all(
      [A, B, C, D].map((player) => api(baseUrl, "POST", "realtime/ticket", { token: player.token })),
    );
    check(tickets.every((ticket) => ticket.data && ticket.data.ticket), "四个账号都取到实时票据");
    const wsBase = baseUrl.replace("http", "ws");
    const [sA, sB, sC, sD] = tickets.map((ticket) =>
      connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`),
    );
    const welcomed = await waitFor("四条连接都收到 welcome", async () =>
      [sA, sB, sC, sD].every((session) => session.welcomes.length > 0) ? true : null,
    );
    check(!!welcomed, "四条实时连接都握手成功");

    for (const session of [sA, sB, sC, sD]) {
      session.send("worldJoin", { mapId: "1" });
      session.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    }
    const joined = await waitFor("四个会话都拿到所在图快照", async () =>
      [sA, sB, sC, sD].every((session) => session.worlds > 0) ? true : null,
    );
    check(!!joined, "四个人都进了「1 图」（两个区各一份世界，同 mapId）");

    //#endregion

    //#region 一、跨区邀请被拒

    group("一、跨区邀请：拒 50149，且不留下空队");
    sA.errors = [];
    sA.partyAction("invite", C.roleId);
    const crossInvite = await waitFor("跨区邀请被拒", async () =>
      sA.errors.find((error) => error.code === 50149) || null,
    );
    check(!!crossInvite, "一区的 A 邀请二区的 C → 50149 PARTY_ZONE_MISMATCH", JSON.stringify(sA.errors));
    checkEqual(
      crossInvite && crossInvite.message,
      "不同区服之间不能组队",
      "文案直接说清原因（不是「找不到这个角色」）",
    );
    await sleep(200);
    checkEqual(sC.invites.length, 0, "被拒的邀请不会送达（二区的 C 一条邀请帧都没收到）");
    // 「不建空队」只能看库：`worldJoin` 时服务端会推一份**空快照**，帧的条数证明不了任何事
    checkEqual(countParties(dbPath), 0, "被拒的邀请不会顺手建一支空队（区检查在建队之前）");

    //#endregion

    //#region 二、同区照旧

    group("二、同区邀请 / 同意照旧");
    sB.invites = [];
    sA.partyAction("invite", B.roleId);
    const inviteB = await waitFor("B 收到同区邀请", async () => sB.invites[0] || null);
    check(!!inviteB, "一区的 A 邀请一区的 B 正常送达");
    checkEqual(inviteB && inviteB.fromRoleId, A.roleId, "邀请帧带发起人 roleId");

    const snapB = await expectSnapshot(sB, () => sB.partyAction("accept"), "B 入队后的快照");
    check(!!snapB && snapB.members.length === 2, "B 同意后 2 人在队（同区组队没有被区边界误伤）");
    check(
      !!snapB && snapB.members.every((member) => member.roleId !== C.roleId),
      "队伍里没有二区的角色",
      JSON.stringify(snapB && snapB.members.map((member) => member.roleId)),
    );
    checkEqual(snapB && snapB.isLeader, false, "B 不是队长（队是 A 建的）");

    //#endregion

    //#region 三、两个区的队伍互不影响

    group("三、二区内部照常组队（两个区的队伍互相独立）");
    sC.invites = [];
    sC.partyAction("invite", D.roleId);
    const inviteD = await waitFor("D 收到二区的邀请", async () => sD.invites[0] || null);
    check(!!inviteD, "二区的 C 邀请同区的 D 正常送达");
    const snapD = await expectSnapshot(sD, () => sD.partyAction("accept"), "D 入队后的快照");
    check(!!snapD && snapD.members.length === 2, "二区的两人组成一支 2 人队");
    check(
      !!snapD && snapD.members.every((member) => member.roleId !== A.roleId && member.roleId !== B.roleId),
      "二区的队伍里没有一区的角色",
    );

    // 反方向：二区邀请一区，同样拒
    sC.errors = [];
    sC.partyAction("invite", A.roleId);
    const crossFromZone2 = await waitFor("二区邀请一区被拒", async () =>
      sC.errors.find((error) => error.code === 50149) || null,
    );
    check(!!crossFromZone2, "二区的 C 邀请一区的 A 同样 50149（双向都拦）");

    // 不存在的 roleId：仍然走「找不到这个角色」（与跨区分开报）
    sA.errors = [];
    sA.partyAction("invite", "no_such_role");
    const missing = await waitFor("不存在的角色被拒", async () =>
      sA.errors.find((error) => error.code === 50109) || null,
    );
    check(!!missing, "邀请一个不存在的 roleId → 50109（与 50149 区分：先查存在，再比区）");

    for (const session of [sA, sB, sC, sD]) session.socket.close();

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 组队带区 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 组队带区 e2e：${passed} 条全绿`);
  }
})();
