#!/usr/bin/env node
/**
 * 区服维护 / 关闭 e2e（server/test/e2e-zone-maintenance.cjs，issue #961）
 *
 * 盯的不变量（区状态机 open ⇄ maintenance → closed）：
 *
 * 一、维护广播：区转 `maintenance` 后，**在区里的人**收到一次 `zoneMaintenance`
 *    （带 `inMs` 倒计时），这段时间里照常收手打完这一只；倒计时到点服务端主动断开，
 *    关闭码必须是 `MAINTENANCE`（4001）—— 客户端据此整页回登录、**不再自动重连**
 * 二、维护是「新人进不来」而不是「世界冻结」：在线连接的权威进图闸门（worldJoin）
 *    立刻回 `mapEnterResult { ok:false, field:"zone" }`；注册也不落维护区
 * 三、恢复不踢人、但要重新广播：转回 `open` 后已广播的倒计时作废（人还在），
 *    下次再转维护要重新发一帧 —— 否则客户端计时器永远停在上一轮的残值
 * 四、关闭不可逆：`closed` 之后选不到、进不去、也不接注册；再想 `open` 回来被拒
 *    （允许关→开 = 允许把一批老玩家拉回一个世界已经很久没落盘的区）
 * 五、恢复后可进：二区维护 → 拒登录 → 恢复 open → 登录 + 进图成功（落在二区世界）
 *
 * 时序口径（见 workbuddy memory「只校验代码，不校验数据」）：
 * - 倒计时的**秒数**不进断言之外的判断（它是 `ZONE_MAINTENANCE_KICK_MS` 的回显，
 *   这里起服时钉成 2000ms，断言只验「帧里带了这个值 + 到点真的断了」）；
 * - 断开不靠 sleep 猜：`waitFor` 等 `close` 事件；
 * - 怪物只数「有没有」，不数「几只」（刷怪区是运营数据）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 维护倒计时（毫秒）：够长到能验「倒计时期间还能收到帧、还能被拒进图」，够短到不拖测试 */
const KICK_MS = 2000;
/** 区状态巡检间隔：远小于 KICK_MS，倒计时的起止都不会被轮询粒度吃掉 */
const POLL_MS = 100;

//#region 断言小工具（与其他 e2e 同款口径）

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

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
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

/** 预先插刷怪区（与世界 e2e 同一份：地图 1 两个有效区），进图段才有怪可看 */
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
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  insert.run("1", "1号怪物", "1", 0, 1, 100, 200, 400, 400, now);
  insert.run("1", "2号怪物", "3", 0, 1, 300, 400, 400, 400, now);
  db.close();
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
      JWT_SECRET: "e2e-zone-maintenance-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-admin-code",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1500",
      WORLD_MAP_IDLE_MS: "0",
      // 被测的两条巡检参数：钉死，别让 60 秒的出厂值把测试拖成分钟级
      ZONE_STATUS_POLL_MS: String(POLL_MS),
      ZONE_MAINTENANCE_KICK_MS: String(KICK_MS),
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

/** 管理端请求所在的区（#960）：管理端请求统一带它（这里只是「在哪个区里干活」，不影响全局操作的可见性） */
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
  return body;
}

/**
 * 一条会话化的 WS 连接
 *
 * 比 e2e-zone 那份多记两样：**所有帧的原文**（维护 / 合并是服务端主动推的，不是请求的
 * 回包）与 **关闭码**（4001 维护 / 4002 合并的判据只有它）。
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: null,
    frames: [],
    /** 某类帧的 data 列表 */
    ofType(type) {
      return session.frames.filter((frame) => frame.type === type).map((frame) => frame.data);
    },
    /** 等某一类帧（可带判据）；`from` 是起始下标，用来等「再来一帧」 */
    async waitFrame(type, from = 0, predicate = () => true, timeoutMs = 8_000) {
      return waitFor(`等待 ${type} 帧`, async () => {
        for (const frame of session.frames.slice(from)) {
          if (frame.type === type && predicate(frame.data)) return frame;
        }
        return null;
      }, timeoutMs);
    },
    /** 发 worldJoin 并等它的结果（world 快照 = 放行；mapEnterResult = 被拒） */
    async joinWorld(mapId, timeoutMs = 8_000) {
      const from = session.frames.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的进图结果`, async () => {
        for (const frame of session.frames.slice(from)) {
          if ((frame.type === "world" || frame.type === "mapEnterResult") && frame.data && frame.data.mapId === mapId) return frame;
        }
        return null;
      }, timeoutMs);
    },
    async waitClose(timeoutMs = 10_000) {
      return waitFor("连接被服务端断开", async () => session.closed, timeoutMs);
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      session.frames.push(JSON.parse(raw.toString()));
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("close", (code, reason) => {
    session.closed = { code, reason: reason.toString() };
  });
  socket.on("error", () => {});
  return session;
}

/** 开一条实时连接并进图；返回会话（失败时断言已经记过了，调用方只需看它是不是 null） */
async function enterWorld(baseUrl, token, mapId) {
  const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
  if (!ticket || !ticket.data) return null;
  const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  await waitFor("实时连接握手", async () => (session.opened ? true : null));
  const result = await session.joinWorld(mapId);
  return { session, result };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-maintenance-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "mt_super", password: "super-pass-1", registerCode: "zone-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    check(!!adminToken, "准备：超级管理员已注册", adminReg.message);

    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;
    checkEqual(zone2.data && zone2.data.status, "open", "准备：新区「二区」是 open");

    const regA = await api(baseUrl, "POST", "auth/register", { body: { username: "mt_player_a", password: "pass1234" } });
    const tokenA = regA.data && regA.data.token;
    const mineA = await api(baseUrl, "GET", "zones/mine", { token: tokenA });
    const currentA = (mineA.data || []).find((zone) => zone.current);
    checkEqual(currentA && currentA.id, 1, "准备：新账号落在第一个开放区（一区）");
    check(currentA && currentA.status === "open", "准备：GET /zones/mine 带 status（客户端据此置灰）", JSON.stringify(currentA));
    await api(baseUrl, "POST", "roles", { token: tokenA, body: { name: "维护甲", occupation: "1", sex: "1" } });
    // #859：没有位置记录的角色只准进新手村；这里要进 10 级图，先按「他本来就在那张图」摆位
    placeRolesAt(dbPath, "1");

    const first = await enterWorld(baseUrl, tokenA, "1");
    const firstOk = !!(first && first.result && first.result.type === "world");
    check(firstOk, "准备：open 时进图成功（world 帧）", first && first.result && first.result.type);
    const sessionA = first && first.session;
    const monstersBefore = firstOk ? first.result.data.monsters || [] : [];
    check(monstersBefore.length > 0, "准备：进图后场上有怪（刷怪区播出来的）", `共 ${monstersBefore.length} 只`);

    //#endregion

    //#region 一、维护广播 → 倒计时 → 断开

    group("一、维护广播：倒计时 / 权威进图闸门 / 恢复不踢 / 到点断线");
    const toMaintenance = await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "maintenance", reason: "e2e 例行维护" },
    });
    checkEqual(toMaintenance.data && toMaintenance.data.status, "maintenance", "一区转 maintenance 成功");

    const announce = await sessionA.waitFrame("zoneMaintenance");
    check(
      !!announce && announce.data.zoneId === 1 && announce.data.zoneName === "一区" && announce.data.inMs === KICK_MS,
      "在线玩家收到 zoneMaintenance 帧（区 id / 区名 / 倒计时 = 配置值）",
      JSON.stringify(announce && announce.data),
    );
    const framesAfterAnnounce = sessionA.frames.length;

    // 权威闸门：维护中直发 worldJoin 被拒，且拒绝理由是「区」不是「等级 / 地图」
    const joinBlocked = await sessionA.joinWorld("1");
    check(
      !!joinBlocked && joinBlocked.type === "mapEnterResult" && joinBlocked.data.ok === false && joinBlocked.data.field === "zone",
      "维护中再进图被拒（mapEnterResult.ok=false，field=zone）",
      JSON.stringify(joinBlocked && joinBlocked.data),
    );

    // 注册不落维护区：新号应该落在唯一还 open 的二区
    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "mt_player_b", password: "pass1234" } });
    const tokenB = regB.data && regB.data.token;
    const mineB = await api(baseUrl, "GET", "zones/mine", { token: tokenB });
    const currentB = (mineB.data || []).find((zone) => zone.current);
    checkEqual(currentB && currentB.id, zone2Id, "维护中的区不接新账号（新号落到二区）");
    const zone1InMine = (mineB.data || []).find((zone) => zone.id === 1);
    checkEqual(zone1InMine && zone1InMine.status, "maintenance", "GET /zones/mine 里一区状态是 maintenance（下拉框置灰依据）");

    // 恢复：倒计时作废，人还在（这一条很容易漏 —— 忘了清 announcedAt 就变成「恢复也照踢」）
    const toOpen = await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "open" },
    });
    checkEqual(toOpen.data && toOpen.data.status, "open", "一区恢复 open");
    await sleep(KICK_MS + 300);
    check(sessionA.closed === null, "恢复后倒计时作废：过了原定断开时刻，连接仍在", JSON.stringify(sessionA.closed));

    // 再转维护：要**重新广播**（一帧都不能少），然后到点断开
    await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "maintenance", reason: "e2e 第二轮" },
    });
    const reannounce = await sessionA.waitFrame("zoneMaintenance", framesAfterAnnounce);
    check(!!reannounce, "恢复后再转维护会重新广播倒计时（不是沿用上一轮的残值）", JSON.stringify(reannounce && reannounce.data));

    const closed = await sessionA.waitClose();
    checkEqual(closed && closed.code, 4001, "倒计时到点被断开，关闭码 = MAINTENANCE 4001");
    check(!!closed && /维护/.test(String(closed.reason)), "断开原因里写明是维护（客户端提示文案的来源）", closed && closed.reason);

    const loginBlocked = await api(baseUrl, "POST", "auth/login", { body: { username: "mt_player_a", password: "pass1234" } });
    checkEqual(loginBlocked.code, 50030, "维护中登录被拒（ZONE_UNAVAILABLE 50030）", loginBlocked.message);
    check(!loginBlocked.data && loginBlocked.data === null, "失败响应 data 恒 null", JSON.stringify(loginBlocked.data));

    const selectBlocked = await api(baseUrl, "POST", "zones/select", { token: tokenA, body: { zoneId: 1 } });
    checkEqual(selectBlocked.code, 50030, "维护中选服被拒（ZONE_UNAVAILABLE 50030）", selectBlocked.message);

    //#endregion

    //#region 二、关闭不可逆

    group("二、关闭不可逆：选不到 / 进不去 / 不能回头开");
    const toClosed = await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "closed", reason: "e2e 关区" },
    });
    checkEqual(toClosed.data && toClosed.data.status, "closed", "维护中可以直接转 closed");

    const reopen = await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "open" },
    });
    checkEqual(reopen.code, 50031, "已关闭的区不能再转 open（ZONE_STATUS_INVALID 50031）", reopen.message);

    const unknownStatus = await api(baseUrl, "POST", "admin/zones/1/status", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "sleeping" },
    });
    checkEqual(unknownStatus.code, 50031, "未知状态被拒（取值域在主 service 收，不靠 DTO 字符串）", unknownStatus.message);

    const selectClosed = await api(baseUrl, "POST", "zones/select", { token: tokenA, body: { zoneId: 1 } });
    checkEqual(selectClosed.code, 50030, "已关闭的区选不到（ZONE_UNAVAILABLE 50030）", selectClosed.message);

    const loginClosed = await api(baseUrl, "POST", "auth/login", { body: { username: "mt_player_a", password: "pass1234" } });
    checkEqual(loginClosed.code, 50030, "当前浏览区已关闭时登录被拒（50030）", loginClosed.message);

    const zonesPublic = await api(baseUrl, "GET", "zones");
    const zone1Public = (zonesPublic.data || []).find((zone) => zone.id === 1);
    checkEqual(zone1Public && zone1Public.status, "closed", "公共 GET /zones 里一区仍列出但状态是 closed（客户端置灰）");
    const adminZones = await api(baseUrl, "GET", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      Array.isArray(adminZones.data) && adminZones.data.length === 2,
      "管理端列表仍看得见已关闭的区（不是删行，是状态）",
      JSON.stringify(adminZones.data && adminZones.data.map((zone) => [zone.id, zone.status])),
    );

    // 登录时指定另一个区：顺带把「当前浏览区」切过去（#961 之前的死路就是这里 ——
    // 当前区关了以后，玩家连选服页都进不去）
    const loginSwitch = await api(baseUrl, "POST", "auth/login", {
      body: { username: "mt_player_a", password: "pass1234", zoneId: zone2Id },
    });
    const tokenA2 = loginSwitch.data && loginSwitch.data.token;
    check(!!tokenA2, "登录时指定 zoneId=二区 可以进去（登录即切区）", loginSwitch.message);
    const mineA2 = await api(baseUrl, "GET", "zones/mine", { token: tokenA2 });
    const currentA2 = (mineA2.data || []).find((zone) => zone.current);
    checkEqual(currentA2 && currentA2.id, zone2Id, "登录切区后 /zones/mine 的 current 已是二区");

    //#endregion

    //#region 三、维护恢复后可进

    group("三、恢复后可进：二区维护 → 恢复 → 登录并进图");
    const makeRole2 = await api(baseUrl, "POST", "roles", { token: tokenA2, body: { name: "维护乙", occupation: "1", sex: "1" } });
    check(!!(makeRole2.data && makeRole2.data.id), "在二区建一个角色（后续进图用它）", makeRole2.message);
    placeRolesAt(dbPath, "1");

    await api(baseUrl, "POST", `admin/zones/${zone2Id}/status`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "maintenance", reason: "e2e 二区维护" },
    });
    const loginZone2Blocked = await api(baseUrl, "POST", "auth/login", { body: { username: "mt_player_a", password: "pass1234" } });
    checkEqual(loginZone2Blocked.code, 50030, "二区维护中登录被拒（当前浏览区在二区）", loginZone2Blocked.message);

    await api(baseUrl, "POST", `admin/zones/${zone2Id}/status`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { status: "open" },
    });
    const loginBack = await api(baseUrl, "POST", "auth/login", { body: { username: "mt_player_a", password: "pass1234" } });
    const tokenA3 = loginBack.data && loginBack.data.token;
    check(!!tokenA3, "二区恢复 open 后登录成功", loginBack.message);

    const enter2 = await enterWorld(baseUrl, tokenA3, "1");
    const enter2Ok = !!(enter2 && enter2.result && enter2.result.type === "world");
    check(enter2Ok, "恢复后能进图（world 帧）", enter2 && enter2.result && enter2.result.type);
    const monsters2 = enter2Ok ? enter2.result.data.monsters || [] : [];
    check(
      monsters2.length > 0 && monsters2.every((monster) => /_z2_/.test(monster.instanceId)),
      "进的是二区那份世界（instanceId 带区段 z2）",
      JSON.stringify(monsters2.map((monster) => monster.instanceId)),
    );
    if (enter2 && enter2.session) enter2.session.socket.close();

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 区服维护 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 区服维护 e2e 全绿（${passed} 条断言）`);
  }
})();
