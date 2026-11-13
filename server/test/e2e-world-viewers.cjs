#!/usr/bin/env node
/**
 * 世界观看者集合专项 e2e（server/test/e2e-world-viewers.cjs，issue #821）
 *
 * ## 这一套在测什么
 *
 * 「谁在看这张图」是世界层唯一的一份名单（`world.viewers`）。它同时是四件事的依据：
 *
 * ```
 * 1. 广播收件人     viewersOf()  → monster-ai / world / 同图频道（#876 的 map）的投递对象
 * 2. 怪物 AI 驱动   viewedMaps() → 没人看的图不跑 AI（#323）
 * 3. 监控采样       viewedMaps() → 没人看的图不写 map_monitor_state（#665）
 * 4. 空闲卸载       emptySince   → 没人看满阈值就把实例从内存卸掉
 * ```
 *
 * 修之前 `join` 只往新集合里加人、`leave` 只在断线时调用 —— **换图不退出旧图**。于是
 * 一个人从图 A 走到图 B，图 A 的名单里还留着他：图 A 永远「有人看」，AI 一直跑、
 * 采样一直写、同图频道还在往一个不在那儿的人身上投递，内存只增不减，直到进程重启。
 *
 * ## 四条主线
 *
 * 1. **换图即退出旧图**：A 从图 0 换到图 3 后，图 0 的**同图频道**不再投递给 A（#876 起
 *    world 改全服在场者广播、不再按图投递，观看者名单最可观测的一面换 map 探针；
 *    投递对象就是那份名单）；B 在同一张图里说话仍是「同图可见」；
 * 2. **旧图不再被采样**：最后一个人离开后 `map_monitor_state` 的时间戳定住不动，
 *    同时另一张有人的图照常在走（对照组，避免把「采集器挂了」误判成修好了）；
 * 3. **旧图按空闲阈值卸载**：服务端日志出现「无人观看已空闲」，还有人在看的图不出现；
 * 4. **卸载不丢状态、人回来采样就回来**：再进图拿到的实例 id 与首次一致（从库恢复，
 *    没有重新播种），采样随即恢复。
 *
 * 另外钉住两件事：**断线**仍走同一条退出入口（日志第 2 次出现），**重复进同一张图**
 * 不会把自己退成「无人」（`join` 里先 `leave` 的副作用，幂等必须成立）。
 *
 * ## 与其他 e2e 的关键差别
 *
 * - 用**临时文件库**：`map_monitor_state` 要直接读（采集器只写不读，接口层要管理端令牌，
 *   而这一套验的是世界层的名单，不该为它拉一套 admin 认证进来）；
 * - `WORLD_MAP_IDLE_MS` 调到 1.2s：出厂值 10 分钟，等不起；
 * - **地图 0（新手村）与地图 3（雪域高原）都是 1 级可进** —— 换图要双向都过门槛，
 *   1 级的号进不了卧龙城（10 级）与王城（40 级）。
 *
 * 用法：npm run test:e2e:world-viewers（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 起点图（新手村）与换图目标（雪域高原）：两张都要求 1 级，换图双向都放行 */
const HOME_MAP = "0";
const AWAY_MAP = "3";
/** 空闲卸载阈值（毫秒）；比它多半拍就够看见日志了 */
const IDLE_MS = 1200;
/** 采集节拍（毫秒） */
const MONITOR_MS = 200;

//#region 断言小工具（与 e2e-world 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
  return ok;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
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
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 把起点图的刷怪区换成「一只怪」
 *
 * **必须在服务端就绪之后调用**：空库首启会用 `config-sync.sql` 把 32 张配置表整表灌一遍，
 * 启动前写进来的行会被整表替换掉（#655 的代价，`e2e-world` 踩过同一个坑）。
 * 只要一只，是为了让「卸载再加载没重新播种」这件事可数。
 */
function seedSpawnAreas(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
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
  db.exec(`DELETE FROM map_spawn_areas WHERE map_id = '${HOME_MAP}'`);
  db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(HOME_MAP, "观看者区", "1", 0, 1, 400, -400, 200, 200, Date.now());
  db.close();
}

/**
 * 读某张图最近一次监控采样的时刻（`map_monitor_state.updated_at`）
 *
 * 直接用库而不是管理端接口：这一套验的是「世界层还在不在采」，接口要一套 admin 认证
 * 才能问同一件事。返回 null = 这张图从来没被采过。
 */
function sampledAtOf(dbPath, mapId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT MAX(updated_at) AS at FROM map_monitor_state WHERE map_id = ?").get(mapId);
    return row && row.at !== null ? Number(row.at) : null;
  } finally {
    db.close();
  }
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
      JWT_SECRET: "e2e-world-viewers-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "200",
      WORLD_PERSIST_MS: "500",
      // 重生拉远：这一套不关心重生，图里那点血别在断言之间自己变回来
      WORLD_RESPAWN_MS: "600000",
      WORLD_MAP_IDLE_MS: String(IDLE_MS),
      MAP_MONITOR_MS: String(MONITOR_MS),
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

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
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

/** 注册 + 建号（一个玩家从零到「能进图」的全部前置） */
async function preparePlayer(baseUrl, username, roleName) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered.body && registered.body.data && registered.body.data.token;
  if (token) await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token };
}

/**
 * 一条会话化的 WS 连接
 *
 * `worlds` / `chats` 都只攒 payload：这一套的断言全部落在「收到 / 没收到」上，
 * 帧的包裹形态由 realtime 的协议单测与其余 e2e 管。
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    worlds: [],
    chats: [],
    send(type, data) {
      socket.send(JSON.stringify({ type, data }));
    },
    /** 进图并把「我在这张图的某个点」报上去（聊天要用在场身份，pos 帧才有） */
    async joinWorld(mapId, timeoutMs = 8_000) {
      const before = session.worlds.length;
      session.send("worldJoin", { mapId });
      const frame = await waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((entry) => entry.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
      session.send("pos", { mapId, x: 400, y: -400, hp: 100, moving: false });
      return frame;
    },
    chatsSince(mark) {
      return session.chats.slice(mark);
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "chat") session.chats.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    session.closed = true;
  });
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-world-viewers-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;
    seedSpawnAreas(dbPath);

    //#region 准备：两个账号 / 角色 / 连接

    group("准备：两个账号、角色与实时连接");
    const A = await preparePlayer(baseUrl, "viewer_player_a", "看图的甲");
    const B = await preparePlayer(baseUrl, "viewer_player_b", "看图的乙");
    check(!!(A.token && B.token), "准备：两个玩家账号已注册并建好角色");

    const connectAs = async (player) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: player.token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body.data.ticket)}`);
      await waitFor("握手成功", async () => (session.opened ? session : null));
      return session;
    };
    const sessionA = await connectAs(A);
    const sessionB = await connectAs(B);
    check(sessionA.opened && sessionB.opened, "准备：两条实时连接已建立");

    //#endregion

    //#region 一、换图即退出旧图

    group("一、换图即退出旧图：旧图不再向离开的人投递");
    const homeA = await sessionA.joinWorld(HOME_MAP);
    check(!!(homeA && homeA.mapId === HOME_MAP), "A 进起点图，拿到权威快照");
    check(!!homeA && homeA.monsters.length === 1, "起点图按刷怪区播种出 1 只实例", JSON.stringify(homeA && homeA.monsters.length));
    const homeInstance = homeA && homeA.monsters[0] && homeA.monsters[0].instanceId;

    const homeB = await sessionB.joinWorld(HOME_MAP);
    check(!!homeB && homeB.monsters.some((monster) => monster.instanceId === homeInstance), "B 也进起点图，看到同一份实例（世界跨账号共享）");

    const awayA = await sessionA.joinWorld(AWAY_MAP);
    check(!!(awayA && awayA.mapId === AWAY_MAP), "A 换图到另一张图，拿到新图的权威快照");

    // 同图频道的收件人就是这份观看者名单（#876 起 world 改全服在场者，探针换 map）：
    // 还留在名单里 = 还会收到旧图的消息
    const probe = `换图探针 ${Date.now()}`;
    const markB = sessionB.chats.length;
    const markA = sessionA.chats.length;
    sessionB.send("chat", { channel: "map", text: probe });
    const echoB = await waitFor("B 收到自己的同图频道回显", async () =>
      sessionB.chatsSince(markB).find((entry) => entry.text === probe) || null,
    );
    check(!!echoB, "B 在起点图发的同图频道自己收到回显（探针本身有效）");
    await sleep(600);
    const leaked = sessionA.chatsSince(markA).filter((entry) => entry.text === probe);
    check(leaked.length === 0, "A 已不在起点图，收不到起点图的同图频道（换图时退出了旧图的观看者）", JSON.stringify(leaked.map((entry) => entry.text)));

    //#endregion

    //#region 二、旧图不再采样、空闲后被卸载

    group("二、旧图不再采样，空闲阈值后被卸载");
    const awayB = await sessionB.joinWorld(AWAY_MAP);
    check(!!(awayB && awayB.mapId === AWAY_MAP), "B 也换到新图 —— 起点图此刻无人观看");

    // 采样是「有人看的图」才跑：起点图的时间戳应当定住，新图照常走（对照组）
    await sleep(600);
    const homeAt1 = sampledAtOf(dbPath, HOME_MAP);
    const awayAt1 = sampledAtOf(dbPath, AWAY_MAP);
    check(!!homeAt1, "起点图在被观看期间留下过监控采样", `updated_at=${homeAt1}`);
    await sleep(700);
    const homeAt2 = sampledAtOf(dbPath, HOME_MAP);
    const awayAt2 = sampledAtOf(dbPath, AWAY_MAP);
    checkEqual(homeAt2, homeAt1, "最后一个人离开后起点图不再被采样（AI 与采集一起停）");
    check(!!awayAt2 && !!awayAt1 && awayAt2 > awayAt1, "同期新图仍在采样（不是采集器停了）", `${awayAt1} → ${awayAt2}`);

    // #809 起房间键是三键，日志文案跟着 RoomManager 走（房间 roomId（地图 / 区 / 线））
    const idleLine = `房间 1:${HOME_MAP}:0（地图 ${HOME_MAP} / 区 1 / 线 0）无人观看已空闲`;
    const reclaimed = await waitFor("起点图的空闲卸载日志", async () => (server.logs().includes(idleLine) ? true : null));
    check(!!reclaimed, "空闲满阈值后起点图从内存卸载（服务端日志可见）", idleLine);
    check(!server.logs().includes(`房间 1:${AWAY_MAP}:0（地图 ${AWAY_MAP} / 区 1 / 线 0）无人观看已空闲`), "还有人在看的新图没有被卸载");

    //#endregion

    //#region 三、卸载不丢状态、人回来采样就回来

    group("三、卸载不丢状态：再进图从库恢复，且重复进图不会把自己退成无人");
    const backA = await sessionA.joinWorld(HOME_MAP);
    check(!!(backA && backA.mapId === HOME_MAP), "A 从新图换回起点图（双向都过换图门槛）");
    check(!!backA && backA.monsters.length === 1, "重进不重新播种翻倍", JSON.stringify(backA && backA.monsters.length));
    checkEqual(backA && backA.monsters[0] && backA.monsters[0].instanceId, homeInstance, "实例 id 与首次一致（卸载只丢内存，状态在库）");

    await sleep(500);
    const homeAt3 = sampledAtOf(dbPath, HOME_MAP);
    check(!!homeAt3 && homeAt3 > homeAt2, "人回来采样就回来", `${homeAt2} → ${homeAt3}`);

    // join 里先 leave：同图重进必须幂等，否则第二次进图会把自己退掉、等一拍就被当无人卸载
    const againA = await sessionA.joinWorld(HOME_MAP);
    check(!!againA && againA.mapId === HOME_MAP, "同图再进一次（模拟重连）拿到快照");
    await sleep(IDLE_MS + 400);
    const homeAt4 = sampledAtOf(dbPath, HOME_MAP);
    check(!!homeAt4 && homeAt4 > homeAt3, "重复进图后仍在采样（先 leave 再 join 没有把自己退成无人）", `${homeAt3} → ${homeAt4}`);

    //#endregion

    //#region 四、断线仍是同一条退出入口

    group("四、断线退出：与换图共用同一个出口");
    const idleCountBefore = server.logs().split(idleLine).length - 1;
    sessionA.socket.close();
    await waitFor("A 的连接断开", async () => (sessionA.closed ? true : null));
    const idleCountAfter = await waitFor("断线后的空闲卸载日志（第 2 次）", async () => {
      const count = server.logs().split(idleLine).length - 1;
      return count > idleCountBefore ? count : null;
    });
    checkEqual(idleCountAfter, idleCountBefore + 1, "A 断线后起点图再次被判定无人观看（断线走的是同一条退出路径）");
    check(server.logs().split(idleLine).length - 1 === 2, "起点图一共被卸载两次（换图一次 + 断线一次），没有多余的回收");

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 世界观看者：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-40).join("\n"));
      process.exitCode = 1;
    }
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
