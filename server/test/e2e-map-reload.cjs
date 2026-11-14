#!/usr/bin/env node
/**
 * 服务端 e2e：单图热重载（#809，收 #669）
 *
 * ## 这一套在测什么
 *
 * 改完刷怪区，图里的人要继续看到**旧**的怪，直到重载发生 —— 而且重载只该动**这一个房间**。
 * 这正是 #669 的核心：以前「改配置 → 生效」只有一条路（等所有人都出去、内存卸载、重新进图），
 * 运营改完区域去图里看，看到的还是旧的，于是以为没保存。
 *
 * 现在有三条路，这一套逐条钉住：
 *
 * ```
 * 1. 不重载      下次有人进图才按新区域播种（图里的人是旧世界）
 * 2. reload      立刻整份重播（连 AI 运行时一起重建），图里的人看到怪整体刷新
 * 3. respawn     房里没人就立刻重播；有人则排队等空窗，最多等到 forceAt 强制
 * ```
 *
 * ## 为什么用「改怪物 key」当探针
 *
 * 数量这个探针测不出重载：密度对齐（`alignDensity`）每个 tick 都会把区里数量补到目标值，
 * 改大改小自己就跟上了。**换怪物 key 才是只有重载能做的事** —— 区域 id 没变、数量没变，
 * 密度对齐认为「什么都不用做」，只有整份重播才会换成新 key 的怪。
 *
 * ## 八条主线
 *
 * 1. **重载前不变**：改了刷怪区的怪 key 之后等两个 tick，图里还是旧 key（不是「悄悄变了」）；
 * 2. **reload 立刻生效**：提交后一个轮询周期内，房间实例整批换成新 key，数量 = Σmax；
 * 3. **别的房间不受影响**：另一张图（另一间房）的实例 id 一个都不变（#669 的验收核心）；
 * 4. **请求有始有终**：`world_reload_requests` 那行变 `done`，`detail` 里有删几只 / 播几只，
 *    不残留 pending；
 * 5. **排队**：`mode=respawn` 且房里有人 → 不动手，留在 pending 等空窗；
 * 6. **强制**：再点一次带 `forceAfterMs=0` → **合并到同一条**请求（不新增行）并立刻执行；
 * 7. **地图规则**：`GET/PATCH /admin/maps/:id/rules` 的「一行不存在 = 全默认」语义
 *    （`inherited` 从 true 变 false），落库后读回来一致；
 * 8. **文档契约**：三个新 operation 与它们的权限点。
 *
 * ## 与其他 e2e 的差别
 *
 * - 用**临时文件库**：主线 4 / 5 要直接读 `world_reload_requests`（那一行是跨进程的一问一答，
 *   没有管理端列表接口）；
 * - `WORLD_TICK_MS = 200`：重载的轮询节拍跟着它（见 `RoomReloadService.pollMs`），
 *   否则每个用例都要多等一秒。
 *
 * 用法：npm run test:e2e:map-reload（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "map-reload-code";

/** 被重载的图（新手村，1 级可进） */
const HOME_MAP = "0";
/** 对照组（雪域高原，同样 1 级可进）—— 重载不许影响它 */
const AWAY_MAP = "3";
/** 两个怪物 key（出厂 monsters 表里都有）：换 key 是只有重载能做到的事 */
const MONSTER_A = "1";
const MONSTER_B = "3";
const ZONE = 1;

//#region 断言小工具（与其余几套同一骨架）

let passed = 0;
let failed = 0;
const failures = [];

function check(condition, label, detail = "") {
  if (condition) {
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
  return check(
    actual === expected,
    `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
}

function group(title) {
  console.log(`\n▶ ${title}`);
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
      JWT_SECRET: "e2e-map-reload-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "200",
      WORLD_PERSIST_MS: "300",
      WORLD_RESPAWN_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const logs = () => chunks.join("");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return {
          baseUrl,
          logs,
          stop: async () => {
            if (child.exitCode !== null || child.signalCode) return;
            child.kill("SIGTERM");
            const until = Date.now() + 10_000;
            while (Date.now() < until && child.exitCode === null && !child.signalCode) await sleep(50);
            if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
          },
        };
      }
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
  return { status: response.status, body };
}

async function preparePlayer(baseUrl, username, roleName) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered.body && registered.body.data && registered.body.data.token;
  if (token) await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token };
}

async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return retry.body?.data?.token;
}

/** 一条会话化的 WS 连接（world 快照 + `world.reload` 通知各攒一份） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    worlds: [],
    reloads: [],
    types: [],
    errors: [],
    send(type, data) {
      socket.send(JSON.stringify({ type, data }));
    },
    async joinWorld(mapId, timeoutMs = 8_000) {
      const before = session.worlds.length;
      session.send("worldJoin", { mapId });
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((entry) => entry.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      session.types.push(frame.type);
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "world.reload") session.reloads.push(frame.data);
      if (frame.type === "error") session.errors.push(frame);
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

async function connectPlayer(baseUrl, player) {
  const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: player.token });
  const session = connect(
    `${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body.data.ticket)}`,
  );
  await waitFor("握手成功", async () => (session.opened ? session : null));
  return session;
}

function withDb(dbPath, fn) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** 一张图当前的刷怪区（管理端详情里的那一份） */
async function areasOf(baseUrl, token, mapId) {
  const detail = await api(baseUrl, "GET", `admin/maps/${mapId}`, { token });
  return detail.body?.data?.spawnAreas ?? [];
}

/** 房间实例的怪物 key（按 instanceId 排序，用来比对「整批换没换」） */
const keysOf = (monsters) =>
  (monsters || []).map((monster) => monster.monsterKey).sort();
const idsOf = (monsters) => (monsters || []).map((monster) => monster.instanceId).sort();

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-reload-${Date.now()}.db`);
  let server = null;
  try {
    server = await startServer(dbPath);
    const base = server.baseUrl;
    const adminToken = await registerAdmin(base, "reloadroot", "ReloadAdmin#1");
    check(Boolean(adminToken), "超管注册并登录成功");

    //#region 准备：清空新手村的出厂刷怪区，只留一个「3 只 A 怪」的区

    group("准备：新手村只留一个刷怪区（3 只），另一张图保持出厂配置当对照");
    const factoryAreas = await areasOf(base, adminToken, HOME_MAP);
    check(factoryAreas.length > 0, "新手村出厂就有刷怪区（配置快照灌的）", String(factoryAreas.length));
    for (const area of factoryAreas) {
      const removed = await api(base, "DELETE", `admin/maps/${HOME_MAP}/spawn-areas/${area.id}`, {
        token: adminToken, zoneId: ADMIN_ZONE,
      });
      if (removed.status !== 200) {
        check(false, `清空出厂刷怪区（id=${area.id}）`, JSON.stringify(removed.body));
        break;
      }
    }
    checkEqual((await areasOf(base, adminToken, HOME_MAP)).length, 0, "新手村的刷怪区已清空");

    const created = await api(base, "POST", `admin/maps/${HOME_MAP}/spawn-areas`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { name: "重载探针区", monsterKey: MONSTER_A, count: 3, cx: 400, cy: -400, w: 200, h: 200 },
    });
    const areaId = created.body?.data?.id;
    check(Boolean(areaId), "建一个「3 只 A 怪」的刷怪区", JSON.stringify(created.body?.data ?? created.body));

    const playerA = await preparePlayer(base, "reload_player_a", "重载甲");
    const playerB = await preparePlayer(base, "reload_player_b", "对照乙");
    const sessionA = await connectPlayer(base, playerA);
    const sessionB = await connectPlayer(base, playerB);

    const firstA = await sessionA.joinWorld(HOME_MAP);
    checkEqual((firstA?.monsters ?? []).length, 3, "甲进图：按刷怪区播 3 只");
    check(
      keysOf(firstA?.monsters).every((key) => key === MONSTER_A),
      `播出来的都是 A 怪（key=${MONSTER_A}）`,
      JSON.stringify(keysOf(firstA?.monsters)),
    );

    // #859：没有位置记录的角色只准进新手村。乙要当「另一张图」的对照，先让服务端认为
    // 他本来就在那儿（等价于管理端 `PATCH /admin/roles/:id { onMap }`），否则进图会被拒
    placeRolesAt(dbPath, AWAY_MAP, ["对照乙"]);
    const firstB = await sessionB.joinWorld(AWAY_MAP);
    if (!firstB) console.log("  B 收到的帧：", sessionB.types.join(","), JSON.stringify(sessionB.errors));
    const awayIdsBefore = idsOf(firstB?.monsters);
    check(awayIdsBefore.length > 0, "乙进另一张图（对照组），拿到自己的世界", String(awayIdsBefore.length));

    //#endregion

    //#region 一、不重载就不变

    group("一、改完刷怪区不重载：图里还是旧世界");
    const patched = await api(base, "PATCH", `admin/maps/${HOME_MAP}/spawn-areas/${areaId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { name: "重载探针区", monsterKey: MONSTER_B, count: 3, cx: 400, cy: -400, w: 200, h: 200 },
    });
    checkEqual(patched.status, 200, `把这一区的怪换成 B 怪（key=${MONSTER_B}）`);

    // 等两个 tick：密度对齐每拍都会跑，但它只数数量（数量没变 = 什么都不做）
    await sleep(600);
    const latestA1 = sessionA.worlds[sessionA.worlds.length - 1];
    check(
      keysOf(latestA1?.monsters).every((key) => key === MONSTER_A),
      "不重载的话图里仍是 A 怪（密度对齐只数数量，不换配置）",
      JSON.stringify(keysOf(latestA1?.monsters)),
    );

    //#endregion

    //#region 二、reload：立刻整份重播

    group("二、reload：一个轮询周期内整批换成新配置，并推新快照");
    const reloadMarks = sessionA.reloads.length;
    const requested = await api(base, "POST", `admin/maps/${HOME_MAP}/reload-world`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { mode: "reload", slot: "0" },
    });
    const items = requested.body?.data?.items ?? [];
    checkEqual(requested.status, 201, "提交重载请求成功（POST 回 201）");
    checkEqual(items.length, 1, "回执按存活区给：只有一个区，就一条");
    checkEqual(items[0]?.roomId, `${ZONE}:${HOME_MAP}:0`, "房号是 zone:map:slot 三键");
    checkEqual(items[0]?.plan, "immediate", "mode=reload 不等空窗（plan=immediate）");
    checkEqual(items[0]?.merged, false, "第一次请求不与任何 pending 合并");
    check(Boolean(items[0]?.requestId), "回执带请求行 id（运营要能对着日志查）", String(items[0]?.requestId));

    const reloadedFrame = await waitFor(
      "重载后的 world 快照（实例整批换新）",
      async () => {
        const latest = sessionA.worlds[sessionA.worlds.length - 1];
        const keys = keysOf(latest?.monsters);
        return keys.length === 3 && keys.every((key) => key === MONSTER_B) ? latest : null;
      },
      8_000,
    );
    check(!!reloadedFrame, "房间实例整批换成 B 怪，数量仍是 3（= Σmax）");
    check(
      keysOf(reloadedFrame?.monsters).length === 3,
      "重播不是叠加：删旧的、播新的，没有变成 6 只",
      JSON.stringify(keysOf(reloadedFrame?.monsters)),
    );

    const notice = await waitFor(
      "world.reload 通知帧",
      async () => (sessionA.reloads.length > reloadMarks ? sessionA.reloads[sessionA.reloads.length - 1] : null),
      8_000,
    );
    check(!!notice, "图里的人收到 world.reload 通知");
    checkEqual(notice?.roomId, `${ZONE}:${HOME_MAP}:0`, "通知带房号（多开时客户端据此判是不是自己这张图）");
    checkEqual(notice?.mapId, HOME_MAP, "通知带图 id");
    checkEqual(notice?.slot, "0", "通知带线");
    checkEqual(notice?.forced, false, "这次不是强制（房里没人等，直接执行）");

    //#endregion

    //#region 三、别的房间不受影响（#669 的核心验收）

    group("三、隔离：另一张图的房间一个实例都没动");
    const secondB = await sessionB.joinWorld(AWAY_MAP);
    checkEqual(
      idsOf(secondB?.monsters).join(","),
      awayIdsBefore.join(","),
      "对照组（另一张图）的实例 id 完全一致：重载只动它自己那间房",
    );
    const awayRows = withDb(dbPath, (db) =>
      Number(db.prepare("SELECT COUNT(1) AS total FROM world_monsters WHERE map_id = ?").get(AWAY_MAP).total),
    );
    checkEqual(awayRows, awayIdsBefore.length, "库里的对照组成例数也一致（没有被顺手清掉）");

    //#endregion

    //#region 四、请求有始有终

    group("四、请求表：执行完就是 done，不残留 pending");
    const rows = await waitFor(
      "请求行落成 done",
      async () => {
        const list = withDb(dbPath, (db) =>
          db.prepare("SELECT id, status, mode, slot, detail FROM world_reload_requests ORDER BY id").all(),
        );
        return list.some((row) => row.status === "done") ? list : null;
      },
      8_000,
    );
    check(
      rows.every((row) => row.status !== "pending"),
      "没有残留的 pending（残留会让实时进程每轮都重播一次）",
      JSON.stringify(rows.map((row) => `${row.id}:${row.status}`)),
    );
    const doneRow = rows.find((row) => String(row.id) === String(items[0].requestId));
    checkEqual(doneRow?.status, "done", "这一次请求的那一行是 done");
    checkEqual(doneRow?.slot, "0", "行上记着线（三键里的第三段）");
    let detail = null;
    try {
      detail = JSON.parse(doneRow?.detail ?? "null");
    } catch {
      detail = null;
    }
    check(
      detail && detail.seeded === 3,
      "detail 里记着重播了 3 只（运营回看「那次到底做了什么」）",
      JSON.stringify(detail),
    );

    //#endregion

    //#region 五、排队：房里有人就等空窗

    group("五、排队：mode=respawn 且房里有人时不动手");
    const backToA = await api(base, "PATCH", `admin/maps/${HOME_MAP}/spawn-areas/${areaId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { name: "重载探针区", monsterKey: MONSTER_A, count: 3, cx: 400, cy: -400, w: 200, h: 200 },
    });
    checkEqual(backToA.status, 200, "把这一区换回 A 怪");

    const queued = await api(base, "POST", `admin/maps/${HOME_MAP}/reload-world`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { mode: "respawn", slot: "0" },
    });
    const queuedItem = (queued.body?.data?.items ?? [])[0];
    checkEqual(queuedItem?.plan, "queued", "不传 forceAfterMs 就是「等空窗」（plan=queued）");
    check(
      Number(queuedItem?.forceAt) > Date.now(),
      "回执给了强制截止时刻（出厂 5 分钟后）",
      String(queuedItem?.forceAt),
    );

    await sleep(800);
    const watching = sessionA.worlds[sessionA.worlds.length - 1];
    check(
      keysOf(watching?.monsters).every((key) => key === MONSTER_B),
      "房里有人：排队期间一只怪都没换（不是「悄悄重播了」）",
      JSON.stringify(keysOf(watching?.monsters)),
    );
    const pendingRows = withDb(dbPath, (db) =>
      db.prepare("SELECT id, status FROM world_reload_requests WHERE status = 'pending'").all(),
    );
    checkEqual(pendingRows.length, 1, "库里躺着一条 pending（等空窗的请求不会自己消失）");

    //#endregion

    //#region 六、强制：合并到同一条，立刻执行一次

    group("六、强制：forceAfterMs=0 合并到同一条请求并立刻执行");
    const forcedMarks = sessionA.reloads.length;
    const forced = await api(base, "POST", `admin/maps/${HOME_MAP}/reload-world`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { mode: "respawn", slot: "0", forceAfterMs: 0 },
    });
    const forcedItem = (forced.body?.data?.items ?? [])[0];
    checkEqual(forcedItem?.merged, true, "与已有的 pending 合并（运营连点两下不该重播两次）");
    checkEqual(forcedItem?.requestId, queuedItem?.requestId, "合并到的是**同一条**请求");
    checkEqual(forcedItem?.plan, "immediate", "forceAfterMs=0 就是立刻强制");

    const forcedNotice = await waitFor(
      "强制重播的通知帧",
      async () => (sessionA.reloads.length > forcedMarks ? sessionA.reloads[sessionA.reloads.length - 1] : null),
      8_000,
    );
    checkEqual(forcedNotice?.forced, true, "这一帧标着 forced（客户端要据此飘字提醒）");
    const afterForce = await waitFor(
      "强制重播后的快照",
      async () => {
        const latest = sessionA.worlds[sessionA.worlds.length - 1];
        const keys = keysOf(latest?.monsters);
        return keys.length === 3 && keys.every((key) => key === MONSTER_A) ? latest : null;
      },
      8_000,
    );
    check(!!afterForce, "强制之后怪确实换回 A（等了 800ms 没动的那些，这一刻全换）");

    const doneCount = withDb(dbPath, (db) =>
      Number(db.prepare("SELECT COUNT(1) AS total FROM world_reload_requests WHERE status = 'done'").get().total),
    );
    checkEqual(doneCount, 2, "一共执行过 2 次（reload 一次 + 合并后的强制一次），合并没有多执行一遍");
    checkEqual(
      withDb(dbPath, (db) =>
        Number(db.prepare("SELECT COUNT(1) AS total FROM world_reload_requests WHERE status = 'pending'").get().total),
      ),
      0,
      "执行完不残留 pending",
    );

    //#endregion

    //#region 七、地图规则

    group("七、地图规则：一行不存在 = 全默认，保存后 inherited 变 false");
    const freshRules = await api(base, "GET", `admin/maps/${HOME_MAP}/rules`, { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(freshRules.status, 200, "读规则成功");
    checkEqual(freshRules.body?.data?.inherited, true, "新人村没配过规则：inherited=true（全是出厂默认）");
    checkEqual(freshRules.body?.data?.maxPlayersPerRoom, 30, "出厂单房间人数上限 30");
    checkEqual(freshRules.body?.data?.maxChannels, 1, "出厂不分线（maxChannels=1）");

    const saveRules = await api(base, "PATCH", `admin/maps/${HOME_MAP}/rules`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: {
        expRate: 1.5,
        dropRate: 2,
        moneyRate: 1,
        allowPk: true,
        allowAutoBattle: false,
        allowRecall: true,
        allowDrop: false,
        maxPlayersPerRoom: 12,
        maxChannels: 2,
        transferCostMoney: 500,
        transferCooldownMs: 3000,
        denyTransferInCombat: true,
        respawnMsOverride: 45000,
        simulateWhenEmpty: true,
      },
    });
    checkEqual(saveRules.status, 200, "保存规则成功");
    checkEqual(saveRules.body?.data?.inherited, false, "保存后不再是「继承默认」");
    checkEqual(saveRules.body?.data?.maxPlayersPerRoom, 12, "人数上限写进去了");
    checkEqual(saveRules.body?.data?.respawnMsOverride, 45000, "重生时长覆盖写进去了（null 与 0 是两件事）");
    checkEqual(saveRules.body?.data?.allowDrop, false, "开关关掉了（false 与「没传」必须能分开）");

    const reread = await api(base, "GET", `admin/maps/${HOME_MAP}/rules`, { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(reread.body?.data?.expRate, 1.5, "重新读回来是 1.5（落库了，不是只改了回执）");
    checkEqual(reread.body?.data?.updatedBy, "reloadroot", "落款记着谁改的");

    const tooBig = await api(base, "PATCH", `admin/maps/${HOME_MAP}/rules`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: {
        expRate: 1,
        dropRate: 1,
        moneyRate: 1,
        allowPk: false,
        allowAutoBattle: true,
        allowRecall: true,
        allowDrop: true,
        maxPlayersPerRoom: 5000,
        maxChannels: 1,
        transferCostMoney: 0,
        transferCooldownMs: 0,
        denyTransferInCombat: false,
        respawnMsOverride: null,
        simulateWhenEmpty: false,
      },
    });
    checkEqual(tooBig.status, 400, "人数上限 5000 被拒（40000 校验失败，不是静默存进去）");

    const audits = await api(base, "GET", "admin/audit-logs?targetType=map&size=20", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      (audits.body?.data?.list ?? []).some((row) => row.action === "adminMap.saveRules"),
      "保存规则进了审计日志（action=adminMap.saveRules）",
    );

    //#endregion

    //#region 八、文档契约 + 权限

    group("八、文档契约：三个新 operation 与它们的权限点");
    const doc = await (await fetch(`${base}/api-docs-json`)).json();
    const reloadPath = doc.paths?.["/api/admin/maps/{id}/reload-world"]?.post;
    check(Boolean(reloadPath), "文档里有 POST /admin/maps/{id}/reload-world");
    checkEqual(reloadPath?.operationId, "adminMap.reloadWorld", "operationId 落在 adminMap 模块下（生成物靠它取名）");
    checkEqual(reloadPath?.["x-olua-permissions"]?.join(","), "gameConfig:write", "重载要写权限（它会改世界状态）");
    checkEqual(
      reloadPath?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapReloadBatchDto",
      "响应类型是 MapReloadBatchDto（每个区一条）",
    );
    check(
      Boolean(doc.components?.schemas?.ReloadWorldDto) && Boolean(doc.components?.schemas?.MapReloadResultDto),
      "入参与单条回执的模型都在（生成物里前端能直接 import）",
    );

    const rulesPath = doc.paths?.["/api/admin/maps/{id}/rules"];
    check(Boolean(rulesPath?.get && rulesPath?.patch), "文档里有 GET / PATCH /admin/maps/{id}/rules");
    checkEqual(rulesPath?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "读规则只要读权限");
    checkEqual(rulesPath?.patch?.["x-olua-permissions"]?.join(","), "gameConfig:write", "改规则要写权限");
    check(
      Boolean(doc.components?.schemas?.MapRulesDto) && Boolean(doc.components?.schemas?.SaveMapRulesDto),
      "规则的读写模型都在",
    );

    const anonymous = await api(base, "POST", `admin/maps/${HOME_MAP}/reload-world`, { body: { mode: "reload" } });
    checkEqual(anonymous.status, 401, "没有令牌不能触发重载（它不是公开接口）");

    //#endregion
  } finally {
    if (server) await server.stop();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})()
  .then(() => {
    console.log(`\n${failed === 0 ? "✅" : "❌"} 单图热重载：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
