#!/usr/bin/env node
/**
 * 区服专项 e2e（server/test/e2e-zone.cjs，issue #295 阶段二）
 *
 * 盯的不变量（改区服模型后必须全绿）：
 * 一、注册选区：公共 GET /zones 只列活区；注册带 zoneId 落对应区（省略落一区），
 *     不存在 / 已合并的区拒注册；账号归属区在 me 里如实返回
 * 二、合并区边界：from=to / from 不存在 / 目标已合并 / from 已合并，各自拒绝码正确；
 *     合并后的区从活区列表消失（管理端列表仍可见，带 mergedInto 标记）
 * 三、世界按区隔离：两个区进同一张图各播一份怪（instanceId 带各自区段、互不相同），
 *     各区扣血只影响自己的实例；拿别的区的实例 id 出手被拒（unknown_target）
 * 四、合并区生效：事务内搬账号（me.zoneId 变了）、世界实例改牌（z2 行清零、
 *     全部变成 z1 段且总量不丢）、被打过的怪血量如实保留、epoch 升级后旧连接
 *     重新 join 落在新世界的权威状态上
 *
 * 与 e2e-world 同款：**临时文件库**（合并区要验库里的行级改写）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-world 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 32;

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
 * 预先往临时库里插刷怪区（与世界 e2e 同一份：地图 1 两个有效区各 max 1 只），
 * 世界隔离段才有怪可看。表先建好再插行，服务端启动的空表 seed 不会动它。
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
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  insert.run("1", "1号怪物", "1", 0, 1, 100, 200, 400, 400, now);
  insert.run("1", "2号怪物", "3", 0, 1, 300, 400, 400, 400, now);
  db.close();
}

/** 起一台服务（文件库；ADMIN_REGISTER_CODE 让 e2e 能开超级管理员） */
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
      JWT_SECRET: "e2e-zone-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-admin-code",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1500",
      WORLD_MAP_IDLE_MS: "0",
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
  return body;
}

/** 一条会话化的 WS 连接（worldJoin / cast 的公共口，e2e-world 同款） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
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
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 一份最小可建号的角色文档（e2e-world 同款口径） */
function roleData(id, name, level, skills) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 一、注册选区

    group("一、注册选区：活区列表 / 默认区 / 指定区 / 非法区");
    const zones0 = await api(baseUrl, "GET", "zones");
    check(Array.isArray(zones0.data) && zones0.data.length === 1 && zones0.data[0].id === 1 && zones0.data[0].name === "一区", "公共 GET /zones 初始只列一区（seed）", JSON.stringify(zones0.data));

    const regA = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_player_a", password: "pass1234" } });
    checkEqual(regA.data && regA.data.account.zoneId, 1, "注册不带 zoneId 落默认一区（老客户端兼容）");
    const tokenA = regA.data && regA.data.token;

    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_player_b", password: "pass1234", zoneId: 1 } });
    checkEqual(regB.data && regB.data.account.zoneId, 1, "注册显式带 zoneId=1 同样落一区");

    const regBad = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_player_bad", password: "pass1234", zoneId: 999 } });
    checkEqual(regBad.code, 50025, "注册选不存在的区被拒（ZONE_NOT_FOUND 50025）", regBad.message);

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", { body: { username: "zone_super", password: "super-pass-1", registerCode: "zone-admin-code" } });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, body: { name: "二区" } });
    check(!!(zone2.data && zone2.data.id >= 2), "开新区「二区」成功", JSON.stringify(zone2.data));
    const zone2Id = zone2.data && zone2.data.id;

    const regC = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_player_c", password: "pass1234", zoneId: zone2Id } });
    checkEqual(regC.data && regC.data.account.zoneId, zone2Id, "注册带新区的 zoneId 落二区");
    const tokenC = regC.data && regC.data.token;

    const zones1 = await api(baseUrl, "GET", "zones");
    check(Array.isArray(zones1.data) && zones1.data.length === 2 && zones1.data[0].id === 1 && zones1.data[1].id === zone2Id, "开区后活区列表变成两个（按开区顺序）", JSON.stringify(zones1.data && zones1.data.map((z) => z.id)));

    //#endregion

    //#region 二、合并区边界

    group("二、合并区边界：同区 / 不存在 / 目标已合并 / 源已合并");
    const mergeSelf = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: zone2Id, toZoneId: zone2Id } });
    checkEqual(mergeSelf.code, 50028, "from = to 被拒（ZONE_MERGE_SAME 50028）", mergeSelf.message);

    const mergeNoFrom = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: 99, toZoneId: 1 } });
    checkEqual(mergeNoFrom.code, 50025, "from 不存在被拒（ZONE_NOT_FOUND 50025）", mergeNoFrom.message);

    // 先开三区并并进二区，制造一个「已合并」的区给后面的边界用
    const zone3 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, body: { name: "三区" } });
    const zone3Id = zone3.data && zone3.data.id;
    const merge3to2 = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: zone3Id, toZoneId: zone2Id } });
    checkEqual(merge3to2.data && merge3to2.data.mergedInto, zone2Id, "三区并入二区成功（返回 mergedInto 标记）");

    const zonesAfter3to2 = await api(baseUrl, "GET", "zones");
    check(Array.isArray(zonesAfter3to2.data) && zonesAfter3to2.data.length === 2, "合并后三区从活区列表消失", JSON.stringify(zonesAfter3to2.data && zonesAfter3to2.data.map((z) => z.name)));

    const adminZones = await api(baseUrl, "GET", "admin/zones", { token: adminToken });
    const mergedRow = Array.isArray(adminZones.data) && adminZones.data.find((z) => z.id === zone3Id);
    check(!!mergedRow && mergedRow.mergedInto === zone2Id, "管理端列表仍看得到已合并的区（mergedInto 指向去向）", JSON.stringify(mergedRow));

    const mergeMergedFrom = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: zone3Id, toZoneId: 1 } });
    checkEqual(mergeMergedFrom.code, 50026, "已合并的区不能再当源区（ZONE_MERGED 50026）", mergeMergedFrom.message);

    const mergeMergedTo = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: 1, toZoneId: zone3Id } });
    checkEqual(mergeMergedTo.code, 50026, "已合并的区也不能当目标区（ZONE_MERGED 50026）", mergeMergedTo.message);

    // 边界段的合并已经把代际推过一轮：等一拍（> 2 个 tick）让世界服务巡检到并作废旧内存，
    // 基线追平后再进世界段 —— 否则这轮「欠着的」作废会在播种后立刻触发，把刚播的怪作废掉（未落盘），
    // 后面验的就成了重播种的世界而不是合并本身。
    await sleep(700);

    //#endregion

    //#region 三、世界按区隔离

    group("三、世界按区隔离：各播各的怪，互不串门");
    await api(baseUrl, "POST", "roles", { token: tokenA, body: { data: roleData("zone_ra", "破界A", 1, { 1000: 1 }) } });
    await api(baseUrl, "POST", "roles", { token: tokenC, body: { data: roleData("zone_rc", "破界C", 1, {}) } });

    const ticketA = await api(baseUrl, "POST", "realtime/ticket", { token: tokenA });
    const ticketC = await api(baseUrl, "POST", "realtime/ticket", { token: tokenC });
    const sessionA = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticketA.data.ticket)}`);
    const sessionC = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticketC.data.ticket)}`);
    await waitFor("两条实时连接握手", async () => (sessionA.opened && sessionC.opened ? true : null));

    const worldA = await sessionA.joinWorld("1");
    const aMonsters = (worldA && worldA.monsters) || [];
    check(aMonsters.length === 2 && aMonsters.every((m) => /^m1_z1_\d+$/.test(m.instanceId)), "一区玩家进图播出一区的世界（instanceId 带区段 z1）", JSON.stringify(aMonsters.map((m) => m.instanceId)));
    const aMob1 = aMonsters.find((m) => m.monsterKey === "1");
    check(!!aMob1 && aMob1.hp === 65 && aMob1.alive, "一区实例满血起算（怪物 1 maxHp 65）", aMob1 && `hp=${aMob1.hp}`);

    const worldC = await sessionC.joinWorld("1");
    const cMonsters = (worldC && worldC.monsters) || [];
    check(cMonsters.length === 2 && cMonsters.every((m) => /^m1_z2_\d+$/.test(m.instanceId)), "二区玩家进同一张图是另一份世界（区段 z2）", JSON.stringify(cMonsters.map((m) => m.instanceId)));

    const aIds = new Set(aMonsters.map((m) => m.instanceId));
    check(cMonsters.every((m) => !aIds.has(m.instanceId)), "两区的实例 id 完全不相交（各自发牌）");

    // 一区出手扣自己世界的血；二区的同 key 怪血量不动
    const targetA = aMonsters.find((m) => m.monsterKey === "1");
    const targetC = cMonsters.find((m) => m.monsterKey === "1");
    sessionA.socket.send(JSON.stringify({ type: "cast", data: { castId: 1, skillId: "1000", targetId: targetA.instanceId, monsterKey: "1" } }));
    const settleA = await sessionA.waitForSettle(1);
    check(!!(settleA && settleA.ok) && settleA.hp < 65, "一区出手结算成功并扣血", JSON.stringify(settleA && { hp: settleA.hp }));
    const worldC2 = await sessionC.joinWorld("1");
    const cStill = (worldC2.monsters || []).find((m) => m.instanceId === targetC.instanceId);
    check(!!cStill && cStill.hp === 65, "二区同 key 怪的血量纹丝不动（世界按区隔离）", cStill && `hp=${cStill.hp}`);

    // 拿别的区的实例 id 出手：结算拒绝（区归属对不上）
    sessionA.socket.send(JSON.stringify({ type: "cast", data: { castId: 2, skillId: "1000", targetId: targetC.instanceId, monsterKey: "1" } }));
    const settleCross = await sessionA.waitForSettle(2);
    check(!!settleCross && !settleCross.ok && settleCross.code === "unknown_target", "跨区出手被拒（unknown_target）", JSON.stringify(settleCross));

    //#endregion

    //#region 四、合并区生效

    group("四、合并区生效：搬账号 / 世界改牌 / 状态保留 / 代际失效");
    await sleep(1200); // 等一区那笔伤害落盘（persist 500ms），合并后才能断言「状态如实保留」
    const merged = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: zone2Id, toZoneId: 1 } });
    checkEqual(merged.data && merged.data.mergedInto, 1, "二区并入一区成功");

    const meC = await api(baseUrl, "GET", "auth/me", { token: tokenC });
    checkEqual(meC.data && meC.data.zoneId, 1, "二区玩家的账号已搬进一区（me.zoneId）");

    await sleep(1000); // 等 tick 巡检到 epoch 变化、作废旧内存（300ms 一轮，两轮足够）
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT instance_id, zone_id FROM world_monsters").all();
    db.close();
    const z2Rows = rows.filter((r) => r.zone_id !== 1 || /_z2_/.test(r.instance_id));
    checkEqual(z2Rows.length, 0, "库里的 z2 行已全部改写（zone_id 与 instanceId 都不再有二区痕迹）", JSON.stringify(z2Rows));
    checkEqual(rows.length, 4, "世界实例总量不丢（两区各 2 只，合并后 4 只全在一区）", JSON.stringify(rows.map((r) => r.instance_id)));

    // 二区玩家的旧连接重新 join：epoch 已作废旧内存，按账号新区（一区）重载
    const worldC3 = await sessionC.joinWorld("1");
    const c3 = (worldC3 && worldC3.monsters) || [];
    check(c3.length === 4 && c3.every((m) => /^m1_z1_\d+$/.test(m.instanceId)), "合并后的玩家重新进图落在一区世界（4 只全在）", JSON.stringify(c3.map((m) => m.instanceId)));
    const carriedDamage = c3.find((m) => m.instanceId === targetA.instanceId);
    check(!!carriedDamage && carriedDamage.hp === (settleA.ok ? settleA.hp : -1), "合并前打掉的血量如实保留（不是重播一份满血世界）", carriedDamage && `hp=${carriedDamage.hp}`);

    const zonesEnd = await api(baseUrl, "GET", "zones");
    check(Array.isArray(zonesEnd.data) && zonesEnd.data.length === 1 && zonesEnd.data[0].id === 1, "合并后活区列表只剩一区");
    const regMerged = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_player_late", password: "pass1234", zoneId: zone2Id } });
    checkEqual(regMerged.code, 50025, "注册选已合并的区被拒（同 ZONE_NOT_FOUND）", regMerged.message);

    const adminZonesEnd = await api(baseUrl, "GET", "admin/zones", { token: adminToken });
    const zone2Row = Array.isArray(adminZonesEnd.data) && adminZonesEnd.data.find((z) => z.id === zone2Id);
    const zone1Row = Array.isArray(adminZonesEnd.data) && adminZonesEnd.data.find((z) => z.id === 1);
    check(!!zone2Row && zone2Row.mergedInto === 1 && zone2Row.accountCount === 0, "管理端视角：二区已标记合并、账号数清零", JSON.stringify(zone2Row));
    check(!!zone1Row && zone1Row.accountCount === 3, "管理端视角：一区账号数 = 3（A/B/C 全在）", zone1Row && `count=${zone1Row.accountCount}`);

    //#endregion
  } finally {
    server.child.kill();
  }

  assertExpectedCount();
  if (failed > 0) {
    console.log(`\n❌ 区服 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 区服 e2e 全绿（${passed} 条断言）`);
  }
})();
