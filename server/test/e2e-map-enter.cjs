#!/usr/bin/env node

/**
 * 服务端 e2e：进图门槛（#606）
 *
 * 判定从客户端搬到服务端之后要守住的不变量：
 *
 * 一、**登录不算换图**：服务端还没有位置记录（刚建号 / 老档第一次上线）时放行，
 *     并把「他在这张图」记下来（`data.mapAt`）
 * 二、**改包直发 worldJoin 换高级图被拒**：1 级角色直发 map 2（要求 40 级）→ 回
 *     `mapEnterResult { ok: false, field: level, need: 40 }`，**没有 world 帧**，位置不变
 * 三、**换图意图（mapEnter）**：与 worldJoin 同一套判据，够条件的放行、不够的给结构化原因；
 *     它只回答「能不能去」，不动世界状态
 * 四、**运营调高门槛不锁人**：已经站在那张图里的人（位置与目标一致）永远放行 ——
 *     这是 #573 的教训，不能因为后台点了一次保存就把人关在门外
 * 五、**位置客户端改不了**：`PUT /roles/:id` 里塞 `mapAt` 会被回填丢弃，
 *     所以「先改位置再重连」这条绕过路走不通
 *
 * 走的是 `dist/`，前置是 `npm run build`。
 * 用法：npm run test:e2e:map-enter
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（与 startServer 的 ADMIN_REGISTER_CODE 同值） */
const ADMIN_CODE = "e2e-map-enter-admin";

//#region 断言小工具（与其余 e2e 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

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

const checkEqual = (actual, expected, label) => check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

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

const waitFor = async (label, predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(20);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 起一台服务（用临时**文件**库：位置要落库，重启后还得在）
 *
 * `WORLD_MAP_IDLE_MS=0` 让图立刻可回收（本套不关心世界存活）；
 * 重生阈值调小只是为了让测试结束得快（本套不打怪）。
 */
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
      JWT_SECRET: "e2e-map-enter-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
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
 * 一条会话化的 WS 连接
 *
 * 这里同时收两种帧：`world`（进图成功）与 `mapEnterResult`（换图判定，成功与拒绝同形）。
 * 断言「被拒后没有进图」靠的是**帧数不动**，所以两种帧都按到达顺序攒下来。
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    results: [],
    /** 发一条 worldJoin（不等应答） */
    sendJoin(mapId) {
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
    },
    /** 发一条换图意图（不等应答） */
    sendMapEnter(mapId) {
      socket.send(JSON.stringify({ type: "mapEnter", data: { mapId } }));
    },
    /** 只等「发出去之后到达」的 world 帧（广播与应答同形，按发送时刻切分） */
    async joinWorld(mapId, timeoutMs = 8_000) {
      const before = session.worlds.length;
      session.sendJoin(mapId);
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 等「这条消息之后」到达的换图判定（mapEnter 与 worldJoin 被拒共用同一帧） */
    async waitForResult(action, mapId, timeoutMs = 8_000) {
      const before = session.results.length;
      action();
      return waitFor(`mapId=${mapId} 的换图判定`, async () => {
        const hits = session.results.slice(before).filter((frame) => frame.mapId === mapId);
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
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "mapEnterResult") session.results.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-enter-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    //#region 准备：管理员 / 玩家 / 角色 / 连接

    group("准备：管理员、玩家、角色与实时连接");

    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "map_admin", password: "pass1234", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { username: "map_admin", password: "pass1234" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "map_player", password: "pass1234" } });
    const playerToken = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token: playerToken, body: { name: "门槛测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!roleId, "准备：1 级角色已建（建号位置 = 新手村 0）", created.message);

    const initial = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
    const initialData = (initial.data && initial.data.data) || {};
    checkEqual(initialData.onMap, "0", "准备：建号位置是 0（新手村）");
    checkEqual(initialData.mapAt, undefined, "准备：还没有服务端位置记录（mapAt 未写）");

    const connectAs = async (token) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor("握手成功", async () => (session.opened ? session : null));
      return session;
    };
    let session = await connectAs(playerToken);
    check(session.opened, "准备：实时连接已建立");

    const roleData = async () => {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
      return (detail.data && detail.data.data) || {};
    };

    //#endregion

    //#region 一、首次进图：没有位置记录 → 放行，并记下位置

    group("一、首次进图：服务端还没有位置记录，放行并落库");
    const firstWorld = await session.joinWorld("1");
    check(!!firstWorld && firstWorld.mapId === "1", "首次 worldJoin(1) 拿到 world 帧（1 级进不了 1 图，但还没有位置记录 → 不拦）");
    check(Array.isArray(firstWorld && firstWorld.monsters), "world 帧带怪物实例列表", JSON.stringify(firstWorld && firstWorld.monsters.length));
    const afterFirst = await roleData();
    checkEqual(afterFirst.mapAt, "1", "服务端记下位置：data.mapAt = 1");

    //#endregion

    //#region 二、改包直发 worldJoin 换高级图 → 被拒

    group("二、改包直发 worldJoin 换高级图（1 级 → 王城 40 级）");
    {
      const worldsBefore = session.worlds.length;
      const before = session.results.length;
      session.sendJoin("2");
      const rejected = await waitFor("mapId=2 的换图判定", async () => {
        const hits = session.results.slice(before).filter((frame) => frame.mapId === "2");
        return hits.length > 0 ? hits[hits.length - 1] : null;
      });
      check(!!rejected && rejected.ok === false, "worldJoin(2) 被拒（ok=false）", JSON.stringify(rejected));
      checkEqual(rejected && rejected.field, "level", "拒绝原因指向等级");
      checkEqual(rejected && rejected.need, 40, "要求等级 = 王城的 40");
      checkEqual(rejected && rejected.mapLabel, "王城", "带图名（提示要用）");
      // 被拒不该落地：没有 world 帧，观看者身份也没登记
      await sleep(600);
      checkEqual(session.worlds.length, worldsBefore, "被拒后没有收到 world 帧（世界层没被惊动）");
      checkEqual((await roleData()).mapAt, "1", "位置没有被改动（仍是 1）");
    }

    //#endregion

    //#region 三、换图意图 mapEnter：同一套判据，只回答「能不能去」

    group("三、换图意图 mapEnter：够条件的放行、不够的给结构化原因");
    {
      const rejected = await session.waitForResult(() => session.sendMapEnter("2"), "2");
      check(!!rejected && rejected.ok === false && rejected.field === "level" && rejected.need === 40, "mapEnter(2) 被拒且原因同 worldJoin", JSON.stringify(rejected));
      const allowed = await session.waitForResult(() => session.sendMapEnter("3"), "3");
      check(!!allowed && allowed.ok === true, "mapEnter(3) 放行（雪域高原只要 1 级）", JSON.stringify(allowed));
      const same = await session.waitForResult(() => session.sendMapEnter("1"), "1");
      check(!!same && same.ok === true, "mapEnter(当前图) 放行", JSON.stringify(same));
      checkEqual((await roleData()).mapAt, "1", "意图不落地：位置仍是 1（只有 worldJoin 才写位置）");
    }

    //#endregion

    //#region 四、运营摆位 / 门槛调高都不锁人

    group("四、运营把人摆进高级图 / 事后调高门槛：已经在那里的低等级角色永远放行");
    {
      // 运营摆位：PATCH onMap 同时承认这个位置（mapAt），否则「门槛认为他还在旧图」
      const placed = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { onMap: "2" } });
      check(placed.code === 0, "运营把 1 级角色摆到王城（PATCH onMap=2）", placed.message);
      const placedData = await roleData();
      checkEqual(placedData.mapAt, "2", "摆位同时写了服务端位置：mapAt = 2");

      const joined = await session.joinWorld("2");
      check(!!joined && joined.mapId === "2", "1 级角色进王城成功（位置与目标一致 → 不拦）");

      // 运营再把门槛调高：站在里面的人重连进来仍然不拦（#573 的教训）
      const mapTwo = await api(baseUrl, "GET", "admin/maps/2", { token: adminToken });
      const config = mapTwo.data;
      const raised = await api(baseUrl, "PATCH", "admin/maps/2", {
        token: adminToken,
        body: { label: config.label, type: config.type, level: 99, combat: config.combat, soulOfWar: config.soulOfWar },
      });
      check(raised.code === 0, "运营把王城进入等级调到 99", raised.message);

      // 换一条连接（模拟重新登录）：登录进的是脚下那张图，不能被自己的门槛挡住
      session.socket.close();
      session = await connectAs(playerToken);
      const relogin = await session.joinWorld("2");
      check(!!relogin && relogin.mapId === "2", "重连后 worldJoin(2) 仍然放行（运营调高门槛不锁人）", JSON.stringify(relogin && relogin.mapId));

      // 但此时去别的图就按新门槛判：10 图（桃花源溪 50 级）依然进不去，且 2 图的门槛确实生效
      const other = await session.waitForResult(() => session.sendMapEnter("10"), "10");
      check(!!other && other.ok === false && other.field === "level" && other.need === 50, "mapEnter(10) 被拒（50 级）", JSON.stringify(other));
    }

    //#endregion

    //#region 五、位置客户端改不了（mapAt 独占）

    group("五、客户端改不了位置：PUT 里塞 mapAt 会被回填丢弃");
    {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
      const data = { ...detail.data.data, mapAt: "10" };
      const saved = await api(baseUrl, "PUT", `roles/${roleId}`, { token: playerToken, body: { data, revision: detail.data.revision } });
      check(saved.code === 0, "存档推送成功（服务端不拒收，只回填）", saved.message);
      checkEqual((await roleData()).mapAt, "2", "mapAt 仍是 2（上报的 10 被丢弃）");

      const worldsBefore = session.worlds.length;
      const bypass = await session.waitForResult(() => session.sendJoin("10"), "10");
      check(!!bypass && bypass.ok === false, "改位置再直发 worldJoin(10) 仍被拒（绕不过去）", JSON.stringify(bypass));
      await sleep(600);
      checkEqual(session.worlds.length, worldsBefore, "被拒后依旧没有 world 帧");
    }

    //#endregion

    //#region 六、正常换图：够条件就放行，并更新位置

    group("六、正常换图：够条件放行，位置跟着走");
    {
      const allowed = await session.waitForResult(() => session.sendMapEnter("3"), "3");
      check(!!allowed && allowed.ok === true, "mapEnter(3) 放行（雪域高原 1 级）", JSON.stringify(allowed));
      const joined = await session.joinWorld("3");
      check(!!joined && joined.mapId === "3", "worldJoin(3) 成功", JSON.stringify(joined && joined.mapId));
      checkEqual((await roleData()).mapAt, "3", "位置更新为 3");
      // 位置变了，门槛就重新生效：2 图现在要 99 级，1 级角色从 3 回 2 应该被拒
      const back = await session.waitForResult(() => session.sendJoin("2"), "2");
      check(!!back && back.ok === false && back.need === 99, "位置变成 3 之后，worldJoin(2) 按新门槛被拒（99 级）", JSON.stringify(back));
    }

    //#endregion
  } finally {
    server.child.kill("SIGKILL");
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✔" : "✗"} 进图门槛：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log(failures.map((item) => `  - ${item}`).join("\n"));
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
