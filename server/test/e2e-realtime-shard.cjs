#!/usr/bin/env node
/**
 * 实时按区分片 e2e（server/test/e2e-realtime-shard.cjs，issue #770 / docs/28 §2.4）
 *
 * 拓扑：**一个存档进程 + 两个实时进程**（`REALTIME_SHARD_COUNT=2`，index 0/1），
 * 三个进程共享同一个 SQLite 文件 —— 与 compose 里的形态一致，只是没有 nginx：
 * 测试自己按「票里给的 shard」选端口，等价于 nginx 按 `/api/realtime/s<k>` 分流。
 *
 * 盯的不变量：
 * 一、**票里带分片**：区 1 的玩家 `1 % 2 = 1` → `shard: 1`；区 2 的玩家 → `shard: 0`
 * 二、**连错分片被拒**：421 + `50150` + `data.shard` 指向正确的片（不是 404「接口不存在」）
 * 三、**连对分片能进图**：welcome + `worldJoin` 拿得到 `world` 帧
 * 四、**票据是一次性的**：同一张票第二次连被拒（401 / `40101`）
 * 五、**跨进程解票**：在 shard 0 上取的票，拿去 shard 1 连**能成** ——
 *    这是分片的核心（票不再是「发票进程的内存」）；1 片部署里不可能发生这种组合
 * 六、**隔离性**：拔掉 shard 1，shard 0 上的连接照常收发（一个片挂了不带走另一个片的人）
 * 七、**纯函数口径**：`shardOf` / `ownsZone` 的边界（0 / 负数 / 越界 index）
 *
 * 用法：`npm run test:e2e:realtime-shard`（前置 `npm run build`）
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ARCHIVE_ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const REALTIME_ENTRY = path.join(SERVER_DIR, "dist", "main.realtime.js");
const { shardOf, ownsZone, shardSegment } = require(path.join(SERVER_DIR, "dist", "common", "utils", "shard.util.js"));

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

/** 起一个进程并等它健康（三个进程共用这一个函数，只有入口与端口不同） */
async function startProcess(label, entry, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      API_PREFIX: "api",
      PORT: String(port),
      REALTIME_PORT: String(port),
      LOG_REQUESTS: "false",
      JWT_SECRET: "e2e-realtime-shard-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: "shard-admin-code",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
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
  return body;
}

/**
 * 用一个 Upgrade 请求直接问「这个片接不接这张票」
 *
 * 用裸 HTTP 而不是 WebSocket 构造函数：**要断言的是拒连时的状态码与响应体**，
 * 而浏览器的 WebSocket 拿不到这些（`onerror` 只有一句 "connection failed"）。
 * 成功时也走这条（101 就说明握手成了），只是随后把 socket 关掉。
 */
function probeUpgrade(port, pathname, ticket) {
  return new Promise((resolve) => {
    const request = require("http").request(
      {
        host: "127.0.0.1",
        port,
        path: `${pathname}?ticket=${encodeURIComponent(ticket)}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      },
      () => {},
    );
    // 101（升级成功）不会走 response 回调，而是触发 upgrade 事件
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: 101, code: 0, data: null });
    });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        resolve({ status: response.statusCode, code: body?.code ?? -1, data: body?.data ?? null });
      });
    });
    request.on("error", () => resolve({ status: -1, code: -1, data: null }));
    request.end();
  });
}

/** 一条真实 WS 连接（进图 / 心跳用）：收 welcome / world / pong，能发帧 */
function connect(port, pathname, ticket) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}?ticket=${encodeURIComponent(ticket)}`);
  const session = { socket, welcomes: [], worlds: [], errors: [], pongs: [], closed: null };
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
      if (frame.type === "pong") session.pongs.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", (code) => {
    session.closed = code;
  });
  return session;
}

async function waitFor(probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-realtime-shard-${Date.now()}.db`);

  // 存档进程**不挂实时模块**（独立进程形态）：实时只在那两个进程里
  const archive = await startProcess("存档进程", ARCHIVE_ENTRY, {
    DB_PATH: dbPath,
    REALTIME_EMBEDDED: "false",
  });

  const shardCount = 2;
  const shard0 = await startProcess("分片 0", REALTIME_ENTRY, {
    DB_PATH: dbPath,
    REALTIME_EMBEDDED: "false",
    REALTIME_SHARD_COUNT: String(shardCount),
    REALTIME_SHARD_INDEX: "0",
  });
  const shard1 = await startProcess("分片 1", REALTIME_ENTRY, {
    DB_PATH: dbPath,
    REALTIME_EMBEDDED: "false",
    REALTIME_SHARD_COUNT: String(shardCount),
    REALTIME_SHARD_INDEX: "1",
  });

  const children = [archive.child, shard0.child, shard1.child];
  try {
    const { baseUrl } = archive;

    //#region 一、准备：区 1 一个玩家、区 2 一个玩家

    group("一、准备：两个区各一个在线角色");

    const superReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "shard_super", password: "super-pass-1", registerCode: "shard-admin-code" },
    });
    const adminToken = superReg.data && superReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", {
      token: adminToken,
      zoneId: 1,
      body: { name: "二区" },
    });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id, "开一个二区", JSON.stringify(zone2.data));
    checkEqual(shardOf(1, shardCount), 1, "区 1 归分片 1（1 % 2）");
    checkEqual(shardOf(zone2Id, shardCount), 0, `区 ${zone2Id} 归分片 0`);

    const playerA = await api(baseUrl, "POST", "auth/register", { body: { username: "shard_a", password: "pass1234" } });
    const tokenA = playerA.data && playerA.data.token;
    const roleA = await api(baseUrl, "POST", "roles", { token: tokenA, body: { name: "分片甲", occupation: "1", sex: "1" } });
    check(!!(roleA.data && roleA.data.id), "区 1 的玩家建好在线角色", JSON.stringify(roleA.data));

    const playerB = await api(baseUrl, "POST", "auth/register", { body: { username: "shard_b", password: "pass1234" } });
    const tokenB = playerB.data && playerB.data.token;
    await api(baseUrl, "POST", "zones/select", { token: tokenB, body: { zoneId: zone2Id } });
    const roleB = await api(baseUrl, "POST", "roles", { token: tokenB, body: { name: "分片乙", occupation: "1", sex: "1" } });
    check(!!(roleB.data && roleB.data.id), "区 2 的玩家建好在线角色", JSON.stringify(roleB.data));

    //#endregion

    //#region 二、票里带分片（在任意一片上取，结论一致）

    group("二、票里带分片：区 1 → shard 1 / 区 2 → shard 0");

    // 取票接口在哪片上都该给出同一个结论（票是无状态加密票，与「谁封的」无关）
    const ticketA0 = await api(shard0.baseUrl, "POST", "realtime/ticket", { token: tokenA });
    const ticketA1 = await api(shard1.baseUrl, "POST", "realtime/ticket", { token: tokenA });
    checkEqual(ticketA0.data && ticketA0.data.shard, 1, "区 1 的玩家在 shard 0 上取票 → shard: 1");
    checkEqual(ticketA1.data && ticketA1.data.shard, 1, "区 1 的玩家在 shard 1 上取票 → shard: 1（与谁签的无关）");

    const ticketB0 = await api(shard0.baseUrl, "POST", "realtime/ticket", { token: tokenB });
    checkEqual(ticketB0.data && ticketB0.data.shard, 0, "区 2 的玩家 → shard: 0");

    //#endregion

    //#region 三、连错分片被拒（421 + 50150 + 正确的 shard）

    group("三、连错分片：421 / 50150 / data.shard 指向正确的片");

    const wrongPath = await probeUpgrade(shard0.port, `/api/realtime/${shardSegment(1)}`, ticketA0.data.ticket);
    checkEqual(wrongPath.status, 421, "在 shard 0 上点名 /s1 → 421（不是 404）");
    checkEqual(wrongPath.code, 50150, "业务码 50150（连错分片）");

    // 连对路径但票是别的区的：走「票据里的区不归我」这条
    const wrongTicket = await probeUpgrade(shard0.port, "/api/realtime", ticketA0.data.ticket);
    checkEqual(wrongTicket.status, 421, "shard 0 收到区 1 的票（不带分片段）→ 也是 421");
    checkEqual(wrongTicket.code, 50150, "业务码 50150");
    checkEqual(wrongTicket.data && wrongTicket.data.shard, 1, "响应体里告诉客户端该去 shard 1");

    //#endregion

    //#region 四、连对分片能进图 + 票据一次性

    group("四、连对分片能进图；同一张票第二次被拒");

    const sessionA = connect(shard1.port, `/api/realtime/${shardSegment(1)}`, ticketA1.data.ticket);
    const welcomeA = await waitFor(() => (sessionA.welcomes.length > 0 ? sessionA.welcomes[0] : null));
    check(!!welcomeA, "区 1 的玩家连上 shard 1 收到 welcome", JSON.stringify(welcomeA && welcomeA.userId));
    sessionA.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId: "0" } }));
    const worldFrame = await waitFor(() => (sessionA.worlds.length > 0 ? sessionA.worlds[0] : null));
    check(!!worldFrame, "worldJoin 拿到 world 帧（进图链路在分片形态下照旧）");

    const replay = await probeUpgrade(shard1.port, `/api/realtime/${shardSegment(1)}`, ticketA1.data.ticket);
    checkEqual(replay.status, 401, "同一张票再用一次 → 401（一次性）");
    checkEqual(replay.code, 40101, "业务码 40101（无效或已被使用）");

    //#endregion

    //#region 五、跨进程解票（分片的核心）

    group("五、跨进程解票：shard 0 签的票，shard 1 一样认");

    // ticketA0 是在 shard 0 上取的（它的内存里没有这张票的任何记录），但票里写着区 1 → shard 1
    const crossProcess = await probeUpgrade(shard1.port, `/api/realtime/${shardSegment(1)}`, ticketA0.data.ticket);
    checkEqual(crossProcess.status, 101, "shard 0 签发的票在 shard 1 上握手成功（票不再是进程内内存）");

    //#endregion

    //#region 六、隔离性：拔掉 shard 1，shard 0 上的连接照常

    group("六、隔离性：shard 1 死掉不影响 shard 0 上的玩家");

    const sessionB = connect(shard0.port, "/api/realtime", ticketB0.data.ticket);
    const welcomeB = await waitFor(() => (sessionB.welcomes.length > 0 ? sessionB.welcomes[0] : null));
    check(!!welcomeB, "区 2 的玩家连上 shard 0 收到 welcome");

    shard1.child.kill("SIGKILL");
    await sleep(500);

    sessionB.socket.send(JSON.stringify({ type: "ping", data: { t: Date.now() } }));
    const pong = await waitFor(() => (sessionB.pongs.length > 0 ? sessionB.pongs[0] : null), 4_000);
    check(!!pong, "shard 1 被杀之后，shard 0 上的连接仍然收发（ping 有 pong 回来）", JSON.stringify(pong));
    checkEqual(sessionB.closed, null, "shard 0 的连接没有被连带断开");
    // 反面：被杀那一片上的人确实掉了（隔离是「各走各的」，不是「谁都不掉」）
    const closedA = await waitFor(() => sessionA.closed !== null, 4_000);
    check(!!closedA, "shard 1 上那条连接随进程一起断了（隔离的另一半）", `close=${sessionA.closed}`);

    //#endregion

    //#region 七、纯函数口径（0 / 负数 / 越界 index）

    group("七、shardOf / ownsZone 的边界");

    checkEqual(shardOf(0, 2), 0, "区 0（不该存在的区）也给出确定答案，不是 NaN");
    checkEqual(shardOf(-1, 2), 1, "负数区按正模归一（-1 → 1），不是 -1");
    checkEqual(shardOf(3, 1), 0, "分片数 1 时永远 0（不分片形态）");
    check(ownsZone(2, 2, 0) && ownsZone(1, 2, 1), "ownsZone 与 shardOf 同口径");
    check(!ownsZone(1, 2, 0), "区 1 不归分片 0");

    //#endregion
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  if (failed === 0) {
    console.log(`\n✅ 实时按区分片：${passed} 条通过 / 0 条失败`);
    process.exit(0);
  }
  console.log(`\n❌ 实时按区分片：${passed} 条通过 / ${failed} 条失败`);
  for (const [index, label] of failures.entries()) console.log(`  ${index + 1}. ${label}`);
  process.exit(1);
})();
