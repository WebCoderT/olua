#!/usr/bin/env node
/**
 * 服务端 e2e：房号三键 `zone:mapId:slot` 与实例 id 的线段（#809）
 *
 * ## 这一套在测什么
 *
 * #809 之前「世界」的键是 `zone:mapId`（两段）—— 一张图在一个区里只有一份世界，
 * 分线与副本没有落脚点。改造后键是三段 `zone:mapId:slot`：
 *
 * ```
 * roomId = <zoneId>:<mapId>:<slot>
 *          1:0:0        一区 · 新手村 · 公共线（本刀只有这一种）
 *          3:12:2       三区 · 图 12 · 2 线
 *          1:5:i3       一区 · 图 5 · 第 3 个副本
 * ```
 *
 * 键一旦散落成「谁需要谁拼一遍」，改起来就要逐处找（改造前 `player-presence` 自己
 * 又写了一份 `worldKey()`）。所以本刀把拼 / 拆收进 `common/utils/room-key.util.ts`，
 * 这一套先钉死那份纯函数的口径，再钉服务端真的按它发牌与落库。
 *
 * ## 五条主线
 *
 * 1. **纯函数口径**：拼出来的键、拆回去的三段、老键（两段）等价于 `slot=0`、
 *    副本槽位不算分线号、实例 id 的四种格式；
 * 2. **服务端按新口径发牌**：进图拿到的 `instanceId` 是 `m<map>_z<zone>_c<slot>_<seq>`
 *    （不是改造前的 `m<map>_z<zone>_<seq>`），且 `world_monsters.slot = '0'`；
 * 3. **存量库批量改库**：把一行的 id 改回老格式、重启服务 → 自动补线段，
 *    同时 `world_meta.epoch + 1` 让在跑的实时进程把手上的旧 id 整份作废（#851 路径）。
 *    不 bump 的话那些进程手里的旧 id 在库里已经不存在，出手就是 20008；
 * 4. **监控按线取快照**：`GET /admin/maps/:id/monitor?slot=0` 的 `slot` / `slots`
 *    是这一条线的帧（不同线的帧不许互相顶替 —— 「切到 1 线看到 0 线的怪」比空图更糟）；
 * 5. **文档契约**：`slot` / `slots` 两个新字段进了 openapi。
 *
 * ## 与其他 e2e 的差别
 *
 * 用**临时文件库**：主线三要直接改库再重启（`:memory:` 做不到「关掉再开还在」）。
 * 主线一直接 require 构建产物 `dist/common/utils/room-key.util.js` —— 纯函数没有
 * 副作用，不必为了它起服务。
 *
 * 用法：npm run test:e2e:map-room-key（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "room-key-code";

/** 新手村（1 级可进，出厂有刷怪区） */
const HOME_MAP = "0";
/** 采集节拍：1000 会让「等一帧」变成等一秒，整套会慢到没法看 */
const MONITOR_MS = 200;

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

/** 起一台服务并等它就绪（返回句柄，`stop()` 之后同一份库可以再起一台） */
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
      JWT_SECRET: "e2e-map-room-key-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "200",
      WORLD_PERSIST_MS: "300",
      // 这一套不关心重生：别让血在断言之间自己变回来
      WORLD_RESPAWN_MS: "600000",
      MAP_MONITOR_MS: String(MONITOR_MS),
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

/** 发一次请求，返回 { status, body }（body 是唯一包裹体，数据在 body.data） */
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

/** 注册 + 建号 */
async function preparePlayer(baseUrl, username, roleName) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered.body && registered.body.data && registered.body.data.token;
  if (token) await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token };
}

/** 注册并登录一个管理员（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return retry.body?.data?.token;
}

/** 一条会话化的 WS 连接（只攒 world 帧：这一套的断点全在快照里） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    worlds: [],
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
      if (frame.type === "world") session.worlds.push(frame.data);
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

/** 直接读库（迁移与落库断言要看表，不走接口） */
function withDb(dbPath, fn) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-room-key-${Date.now()}.db`);
  let server = null;
  try {
    //#region 一、纯函数口径

    group("一、房号三键：拼 / 拆 / 老键兼容 / 实例 id 线段（纯函数）");
    const roomKeyUtil = require(path.join(SERVER_DIR, "dist", "common", "utils", "room-key.util.js"));
    const { roomKey, splitRoomKey, isInstanceSlot, channelOfSlot, instanceIdOf, parseInstanceSeq } = roomKeyUtil;

    checkEqual(roomKey(1, HOME_MAP), "1:0:0", "不传 slot 就是公共线（调用方不必到处写 '0'）");
    checkEqual(roomKey(3, "12", "2"), "3:12:2", "三键拼装：区 + 图 + 线");

    const three = splitRoomKey("3:12:2");
    check(
      three.zoneId === 3 && three.mapId === "12" && three.slot === "2",
      "三段拆回去：区 3 / 图 12 / 线 2（图 id 多字符不歧义）",
      JSON.stringify(three),
    );
    const legacy = splitRoomKey("1:0");
    check(
      legacy.zoneId === 1 && legacy.mapId === "0" && legacy.slot === "0",
      "老键（两段）等价于公共线：splitRoomKey('1:0').slot === '0'",
      JSON.stringify(legacy),
    );
    checkEqual(splitRoomKey("1:0").roomId, "1:0:0", "老键拆完再拼回来是规范化后的三键（下游只认一种形状）");

    check(isInstanceSlot("i3") && isInstanceSlot("i12"), "副本槽位是 i<seq>");
    check(!isInstanceSlot("0") && !isInstanceSlot("2"), "公共线与分线不是副本槽位");
    checkEqual(channelOfSlot("0"), 0, "公共线的分线号是 0");
    checkEqual(channelOfSlot("3"), 3, "分线号直接就是槽位数字");
    checkEqual(channelOfSlot("i3"), -1, "副本没有分线号（-1，不与 0 号公共线混淆）");

    checkEqual(instanceIdOf("1", 1, "0", 7), "m1_z1_c0_7", "公共线实例 id：m<map>_z<zone>_c0_<seq>");
    checkEqual(instanceIdOf("12", 3, "2", 5), "m12_z3_c2_5", "分线实例 id 带线号（c2）");
    checkEqual(instanceIdOf("1", 1, "i3", 2), "m1_z1_i3_2", "副本实例 id 用 i<seq> 段");
    checkEqual(parseInstanceSeq("m1_z1_c0_7"), 7, "序号能从 id 尾巴读回来（重播时接着发牌）");
    checkEqual(parseInstanceSeq("m1_z1_i3_2"), 2, "副本的序号同样在尾巴上");

    //#endregion

    server = await startServer(dbPath);

    //#region 二、服务端按新口径发牌与落库

    group("二、发牌与落库：id 带线段，行上有 slot");
    const adminToken = await registerAdmin(server.baseUrl, "roomroot", "RoomAdmin#1");
    check(Boolean(adminToken), "超管注册并登录成功");

    const player = await preparePlayer(server.baseUrl, "room_key_player", "看房的甲");
    check(Boolean(player.token), "玩家注册并建号成功");
    const session = await connectPlayer(server.baseUrl, player);

    const world = await session.joinWorld(HOME_MAP);
    const monsters = (world && world.monsters) || [];
    check(monsters.length > 0, "进图拿到权威快照（新手村出厂有刷怪区）", String(monsters.length));
    check(
      monsters.every((monster) => /^m0_z1_c0_\d+$/.test(monster.instanceId)),
      "实例 id 是 m0_z1_c0_N（新口径：区段 + 公共线段 + 序号）",
      JSON.stringify(monsters.map((monster) => monster.instanceId)),
    );

    const stored = await waitFor(
      "实例落库（落盘按 WORLD_PERSIST_MS 节流，不是播种当场就写）",
      async () => {
        const rows = withDb(dbPath, (db) =>
          db.prepare("SELECT instance_id, slot FROM world_monsters WHERE map_id = ?").all(HOME_MAP),
        );
        return rows.length > 0 ? rows : null;
      },
      8_000,
    );
    check(stored.length === monsters.length, "库里的实例数与快照一致", `${stored.length} / ${monsters.length}`);
    check(
      stored.every((row) => row.slot === "0"),
      "每一行的 slot 都是 '0'（公共线；不是空串也不是 NULL）",
      JSON.stringify(stored.map((row) => row.slot)),
    );

    //#endregion

    //#region 三、存量库批量改库（老格式 → 新格式 + 代际 +1）

    group("三、存量 id 迁移：重启时补齐线段，并让在跑的旧内存作废");
    const victim = stored[stored.length - 1];
    const legacyId = "m0_99";
    withDb(dbPath, (db) => {
      db.prepare("UPDATE world_monsters SET instance_id = ?, slot = '' WHERE instance_id = ?").run(
        legacyId,
        victim.instance_id,
      );
    });
    const epochBefore = withDb(dbPath, (db) => Number(db.prepare("SELECT epoch FROM world_meta WHERE id = 1").get().epoch));
    await server.stop();

    server = await startServer(dbPath);
    const migrated = withDb(dbPath, (db) =>
      db.prepare("SELECT instance_id, slot FROM world_monsters WHERE map_id = ?").all(HOME_MAP),
    );
    check(
      migrated.some((row) => row.instance_id === "m0_z1_c0_99"),
      "老格式 m0_99 被改写成 m0_z1_c0_99（重启时一次性补线段）",
      JSON.stringify(migrated.map((row) => row.instance_id)),
    );
    check(
      !migrated.some((row) => row.instance_id === legacyId),
      "老格式不再留在库里（否则实时进程出手就是 20008）",
    );
    check(
      migrated.filter((row) => row.instance_id === "m0_z1_c0_99").every((row) => row.slot === "0"),
      "改写时顺手把 slot 补成 '0'（空串不是合法槽位）",
    );
    const epochAfter = withDb(dbPath, (db) => Number(db.prepare("SELECT epoch FROM world_meta WHERE id = 1").get().epoch));
    check(epochAfter > epochBefore, "世界代际 +1（在跑的进程据此整份作废并重载）", `${epochBefore} → ${epochAfter}`);

    // 重启用的是**新端口**，旧连接已断：重连一次再问快照（客户端重连也是这个动作）
    const session2 = await connectPlayer(server.baseUrl, player);
    const rejoined = await session2.joinWorld(HOME_MAP);
    check(
      Boolean(rejoined) && (rejoined.monsters || []).some((monster) => monster.instanceId === "m0_z1_c0_99"),
      "重连后看到的就是改写后的 id（库是权威，内存跟着库走）",
      JSON.stringify(((rejoined && rejoined.monsters) || []).map((monster) => monster.instanceId)),
    );

    //#endregion

    //#region 四、监控按线取快照

    group("四、监控：按线取帧，不拿别的线顶替");
    const monitor = await waitFor(
      "公共线的监控快照（采集器每 200ms 一帧）",
      async () => {
        const response = await api(server.baseUrl, "GET", `admin/maps/${HOME_MAP}/monitor?slot=0`, {
          token: adminToken, zoneId: ADMIN_ZONE,
        });
        const data = response.body?.data;
        return data && data.sampledAt ? data : null;
      },
      10_000,
    );
    check(!!monitor, "拿到 slot=0 的监控帧");
    checkEqual(monitor && monitor.slot, "0", "回执里标着这是哪一条线");
    check(
      Array.isArray(monitor && monitor.slots) && monitor.slots.includes("0"),
      "slots 里至少包含公共线（页面据此画线选择器）",
      JSON.stringify(monitor && monitor.slots),
    );
    check(
      (monitor?.monsters ?? []).every((monster) => /^m0_z1_c0_\d+$/.test(monster.instanceId)),
      "监控里的实例 id 与快照同一口径",
      JSON.stringify((monitor?.monsters ?? []).map((monster) => monster.instanceId)),
    );

    // 不存在的线：**不许**退回公共线的帧（「切到 1 线看到 0 线的怪」比空图更糟）
    const otherLine = await api(server.baseUrl, "GET", `admin/maps/${HOME_MAP}/monitor?slot=7`, {
      token: adminToken, zoneId: ADMIN_ZONE,
    });
    const otherData = otherLine.body?.data;
    check(
      otherData && otherData.sampledAt === null && (otherData.monsters ?? []).length === 0,
      "没被采样过的线返回空帧（不是公共线的帧）",
      JSON.stringify({ sampledAt: otherData && otherData.sampledAt, monsters: (otherData?.monsters ?? []).length }),
    );
    checkEqual(otherData && otherData.slot, "7", "空帧也照实说「你问的是 7 线」");

    const badSlot = await api(server.baseUrl, "GET", `admin/maps/${HOME_MAP}/monitor?slot=abc`, {
      token: adminToken, zoneId: ADMIN_ZONE,
    });
    checkEqual(badSlot.status, 400, "非法线名（abc）被拒（40000 校验失败，不是静默当 0 线）");

    //#endregion

    //#region 五、文档契约

    group("五、文档契约：slot / slots 进了 openapi");
    const doc = await (await fetch(`${server.baseUrl}/api-docs-json`)).json();
    const monitorSchema = doc.components?.schemas?.MapMonitorDto?.properties ?? {};
    check(
      Boolean(monitorSchema.slot) && Boolean(monitorSchema.slots),
      "MapMonitorDto 有 slot 与 slots 两个新字段",
      Object.keys(monitorSchema).join(","),
    );
    checkEqual(
      (doc.components?.schemas?.MapMonitorQueryDto?.properties ?? {}).slot?.type,
      "string",
      "查询参数 slot 在文档里是字符串（线号不许被隐式转成数字 —— '1' 与 1 在 KV 里不等价）",
    );

    //#endregion
  } finally {
    if (server) await server.stop();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})()
  .then(() => {
    console.log(`\n${failed === 0 ? "✅" : "❌"} 房号三键：${passed} 条通过 / ${failed} 条失败`);
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
