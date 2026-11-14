#!/usr/bin/env node
/**
 * 合区（合并区）e2e（server/test/e2e-zone-merge.cjs，issue #961）
 *
 * 合并区是**搬玩家数据**的运营操作，一个事务里六件事，任何一件漏了都会在线上表现为
 * 「玩家数据丢了一部分」—— 而且多半是几天后才有人报。这套 e2e 逐件盯：
 *
 * 一、**搬角色**：`roles.zone_id` 改挂目标区；同账号在两边有同名角色时自动改名
 *    （后缀 = 源区名），改名清单进合并报告 —— 运营事后对账全靠它
 * 二、**搬帮会**：`guilds.zone_id` 跟着搬（#958 起帮会绑区）
 * 三、**重排世界发牌**：源区怪物实例改挂目标区、instanceId 换区段、**序号接着目标区
 *    往后排**（全服不重号），总量不丢
 * 四、**清残留**：源区待执行的重载请求置 failed（留着会给死区重新播种，合并等于白做）、
 *    监控投影与角色位置删掉（`role_positions` 没有 zone_id，只能在搬角色**之前**反查删除）
 * 五、**只 bump 参与的区**：`zone_world_meta` 里源区与目标区各 +1，**其他区一格不动**
 *    （以前是全服 epoch+1，合并一次所有图都白重建）
 * 六、**死区不再播种**：合并后源区 `world_monsters` 不新增（没人看 → 惰性；有人看 →
 *    按库重载，库里没有就不播 —— 两种路径都不该复活它）
 * 七、**在线玩家被踢**：收到 `zoneMerged` 帧（带并入去向）后断线，关闭码 4002
 *
 * 口径：只验「状态机 / 存在性 / 唯一性 / 方向」，不验「几只怪掉多少血」这类运营数据。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 区状态巡检间隔：合并踢线靠它，压到 100ms 免得等 */
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

/** 预先插刷怪区（与世界 e2e 同一份）：源区进图后才有实例可搬 */
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
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  insert.run("1", "1号怪物", "1", 0, 1, 100, 200, 400, 400, now);
  insert.run("1", "2号怪物", "3", 0, 1, 300, 400, 400, 400, now);
  db.close();
}

/**
 * 往库里塞「合并要清理 / 要搬走」的四类残留（准备段造的状态不是被测逻辑）
 *
 * 为什么直写库而不是走接口：这四类分别属于「实时投影（监控）」「运维队列（重载）」
 * 「运行时位置（role_positions）」「帮会（要建帮流程）」—— 为了验「合并会清掉它们」
 * 先去把它们的生产链路跑一遍，测的就变成那些链路了。
 *
 * @returns {{guildId: string, roleName: string}} 造出来的帮会 id 与源区角色名
 */
function seedMergeFixtures(dbPath, fromZoneId) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    const role = db.prepare("SELECT id, name FROM roles WHERE zone_id = ? ORDER BY created_at ASC LIMIT 1").get(fromZoneId);
    if (!role) throw new Error(`源区 ${fromZoneId} 没有角色，准备段不成立`);
    const now = Date.now();
    const guildId = "g-merge-e2e";
    db.prepare(
      `INSERT INTO guilds (id, zone_id, name, notice, leader_id, level, funds, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 1, 0, ?, ?)`,
    ).run(guildId, fromZoneId, "合并测试帮", role.id, now, now);
    db.prepare(
      `INSERT INTO map_monitor_state (zone_id, map_id, slot, payload, updated_at) VALUES (?, '1', '0', ?, ?)`,
    ).run(fromZoneId, JSON.stringify({ monsters: [], players: [], sampledAt: now }), now);
    db.prepare(
      `INSERT INTO map_monitor_events (zone_id, map_id, at, kind, payload) VALUES (?, '1', ?, 'kill', ?)`,
    ).run(fromZoneId, now, JSON.stringify({ monsterKey: "1" }));
    db.prepare(
      `INSERT INTO world_reload_requests (zone_id, map_id, slot, mode, requested_by, requested_at, force_at, status)
       VALUES (?, '1', '0', 'force', 'e2e', ?, ?, 'pending')`,
    ).run(fromZoneId, now, now + 60_000);
    db.prepare(
      `INSERT INTO role_positions (role_id, map_id, x, y, updated_at) VALUES (?, '1', 100, 200, ?)
       ON CONFLICT(role_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(role.id, now);
    return { guildId, roleName: role.name };
  } finally {
    db.close();
  }
}

/** 读一份库里与合并相关的事实（每次新开连接，避免读到旧快照） */
function readMergeFacts(dbPath, fromZoneId, toZoneId) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    const count = (sql, args = []) => Number(db.prepare(sql).get(...args).total);
    return {
      rolesOfFrom: db.prepare("SELECT name FROM roles WHERE zone_id = ? ORDER BY name ASC").all(fromZoneId).map((row) => row.name),
      rolesOfTo: db.prepare("SELECT name FROM roles WHERE zone_id = ? ORDER BY name ASC").all(toZoneId).map((row) => row.name),
      guildZones: db.prepare("SELECT id, zone_id FROM guilds WHERE id = 'g-merge-e2e'").all().map((row) => row.zone_id),
      monitorStates: count("SELECT COUNT(1) AS total FROM map_monitor_state WHERE zone_id = ?", [fromZoneId]),
      monitorEvents: count("SELECT COUNT(1) AS total FROM map_monitor_events WHERE zone_id = ?", [fromZoneId]),
      pendingReloads: count("SELECT COUNT(1) AS total FROM world_reload_requests WHERE zone_id = ? AND status = 'pending'", [
        fromZoneId,
      ]),
      failedReloads: count("SELECT COUNT(1) AS total FROM world_reload_requests WHERE zone_id = ? AND status = 'failed'", [
        fromZoneId,
      ]),
      leftoverPositions: count("SELECT COUNT(1) AS total FROM role_positions p WHERE p.role_id IN (SELECT id FROM roles WHERE zone_id = ?)", [
        fromZoneId,
      ]),
      monstersOfFrom: count("SELECT COUNT(1) AS total FROM world_monsters WHERE zone_id = ?", [fromZoneId]),
      monsterIds: db.prepare("SELECT instance_id, zone_id FROM world_monsters ORDER BY instance_id ASC").all(),
      epochs: db.prepare("SELECT zone_id, epoch FROM zone_world_meta ORDER BY zone_id ASC").all(),
    };
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
      JWT_SECRET: "e2e-zone-merge-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-admin-code",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1500",
      WORLD_MAP_IDLE_MS: "0",
      ZONE_STATUS_POLL_MS: String(POLL_MS),
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

/** 管理端请求所在的区（#960） */
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

/** 一条会话化连接：记所有帧与关闭码（`zoneMerged` 是服务端主动推的） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: null,
    frames: [],
    async waitFrame(type, timeoutMs = 8_000) {
      return waitFor(`等待 ${type} 帧`, async () => session.frames.find((frame) => frame.type === type) ?? null, timeoutMs);
    },
    async joinWorld(mapId, timeoutMs = 8_000) {
      const from = session.frames.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
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

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-merge-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：三个区 + 一个「两区同名角色」的账号 + 源区在线连接

    group("准备：开三个区（源 / 目标 / 旁观）并在源区造齐四类残留");
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "mg_super", password: "super-pass-1", registerCode: "zone-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    check(!!adminToken, "超级管理员已注册", adminReg.message);

    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const fromZoneId = zone2.data && zone2.data.id;
    const zone3 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "三区" } });
    const bystanderZoneId = zone3.data && zone3.data.id;
    check(!!fromZoneId && !!bystanderZoneId && fromZoneId !== bystanderZoneId, "开了二区（源）与三区（旁观）", `from=${fromZoneId} bystander=${bystanderZoneId}`);

    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "mg_player", password: "pass1234" } });
    const tokenB = regB.data && regB.data.token;
    // 目标区（一区）先建一个「双面人」：合并时源区的同名角色才会被改名
    const roleTarget = await api(baseUrl, "POST", "roles", { token: tokenB, body: { name: "双面人", occupation: "1", sex: "1" } });
    check(!!(roleTarget.data && roleTarget.data.id), "目标区建角色「双面人」", roleTarget.message);
    // 切到源区再建一个同名角色（唯一索引是 (account_id, zone_id, name)，跨区同名允许）
    await api(baseUrl, "POST", "zones/select", { token: tokenB, body: { zoneId: fromZoneId } });
    const roleSource = await api(baseUrl, "POST", "roles", { token: tokenB, body: { name: "双面人", occupation: "1", sex: "1" } });
    check(!!(roleSource.data && roleSource.data.id), "源区也建了同名角色「双面人」（撞名的前提）", roleSource.message);
    placeRolesAt(dbPath, "1");

    // 源区进图：播种源区的世界（合并要搬的就是这一份），同时留一条在线连接验踢线
    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: tokenB });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));
    const joined = await session.joinWorld("1");
    const joinedOk = joined && joined.type === "world";
    check(joinedOk, "源区玩家进图成功（播出一份源区世界）", joined && joined.type);
    const sourceMonsters = joinedOk ? joined.data.monsters || [] : [];
    check(
      sourceMonsters.length > 0 && sourceMonsters.every((monster) => /_z\d+_/.test(monster.instanceId)),
      "源区世界有实例可搬",
      JSON.stringify(sourceMonsters.slice(0, 3).map((monster) => monster.instanceId)),
    );

    seedMergeFixtures(dbPath, fromZoneId);
    // 播种先进内存，落盘要等一次 persist tick（`WORLD_PERSIST_MS`）。合并搬的是**库里的行**，
    // 所以这里要等它真的写下去 —— 等「行出现了」而不是 sleep 一个固定窗口（快慢机差一截）
    const persisted = await waitFor("源区世界落盘", async () => {
      const current = readMergeFacts(dbPath, fromZoneId, ADMIN_ZONE);
      return current.monstersOfFrom > 0 ? current : null;
    });
    check(!!persisted, "源区世界已落盘（合并搬的就是这份行）", persisted && `monsters=${persisted.monstersOfFrom}`);
    const before = persisted || readMergeFacts(dbPath, fromZoneId, ADMIN_ZONE);
    checkEqual(before.pendingReloads, 1, "准备：源区有 1 条待执行重载请求");
    checkEqual(before.monitorStates >= 1, true, "准备：源区有监控投影");
    checkEqual(before.guildZones[0], fromZoneId, "准备：帮会暂挂源区");

    //#endregion

    //#region 一、预检 → 合并 → 报告

    group("一、合区预检与合并报告");
    const precheck = await api(baseUrl, "GET", `admin/zones/merge/precheck?fromZoneId=${fromZoneId}&toZoneId=${ADMIN_ZONE}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!precheck.data && precheck.data.ok === true && precheck.data.blockers.length === 0,
      "预检通过（ok=true，blockers 为空）",
      JSON.stringify(precheck.data && precheck.data.blockers),
    );
    check(
      precheck.data && precheck.data.roleCount >= 1 && precheck.data.guildCount === 1 && precheck.data.monsterCount > 0,
      "预检报出「会搬多少」（角色 / 帮会 / 世界实例）",
      JSON.stringify({ roles: precheck.data && precheck.data.roleCount, guilds: precheck.data && precheck.data.guildCount, monsters: precheck.data && precheck.data.monsterCount }),
    );
    checkEqual(precheck.data && precheck.data.guildConflicts.length, 0, "帮会撞名恒为空（帮会名全服唯一）");

    const precheckSame = await api(baseUrl, "GET", `admin/zones/merge/precheck?fromZoneId=${ADMIN_ZONE}&toZoneId=${ADMIN_ZONE}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!precheckSame.data && precheckSame.data.ok === false && precheckSame.data.blockers.length > 0,
      "预检也能否掉（同区 → ok=false 且给出原因）",
      JSON.stringify(precheckSame.data && precheckSame.data.blockers),
    );

    const merged = await api(baseUrl, "POST", "admin/zones/merge", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { fromZoneId, toZoneId: ADMIN_ZONE },
    });
    const report = merged.data || {};
    checkEqual(report.toZoneId, ADMIN_ZONE, "合并报告指向目标区");
    checkEqual(report.roleCount, precheck.data && precheck.data.roleCount, "报告里的角色数与预检同源（不是另算一遍）");
    check(
      Array.isArray(report.renamedRoles) && report.renamedRoles.length === 1 && report.renamedRoles[0].name === "双面人",
      "同账号同名角色被自动改名，清单进报告",
      JSON.stringify(report.renamedRoles),
    );
    check(
      /^双面人·二区$/.test((report.renamedRoles[0] && report.renamedRoles[0].renamed) || ""),
      "改名后缀是源区名（双面人·二区）",
      report.renamedRoles[0] && report.renamedRoles[0].renamed,
    );
    checkEqual(report.guildCount, 1, "报告：搬走 1 个帮会");
    check(report.monsterCount > 0, "报告：搬走世界实例", `monsterCount=${report.monsterCount}`);
    checkEqual(report.failedReloads, 1, "报告：作废 1 条待执行重载");

    //#endregion

    //#region 二、库里的六件事

    group("二、库里逐件核对：角色 / 帮会 / 实例 / 残留 / 代际");
    const after = readMergeFacts(dbPath, fromZoneId, ADMIN_ZONE);
    checkEqual(after.rolesOfFrom.length, 0, "源区不再有角色（roles.zone_id 全搬走）");
    check(
      after.rolesOfTo.includes("双面人") && after.rolesOfTo.includes("双面人·二区"),
      "目标区同时有原名与改名后的两个角色（不是覆盖）",
      JSON.stringify(after.rolesOfTo),
    );
    checkEqual(after.guildZones[0], ADMIN_ZONE, "帮会改挂目标区");
    checkEqual(after.pendingReloads, 0, "源区不再有待执行重载（留着会给死区重新播种）");
    checkEqual(after.failedReloads, 1, "那条重载被置为 failed（不是删行，运营还能看到它）");
    checkEqual(after.monitorStates, 0, "源区监控快照已清");
    checkEqual(after.monitorEvents, 0, "源区监控事件流已清");
    checkEqual(after.leftoverPositions, 0, "源区角色位置行已清（role_positions 没有 zone_id，只能搬角色前反查）");

    const ids = after.monsterIds.map((row) => row.instance_id);
    checkEqual(new Set(ids).size, ids.length, "世界实例 id 全服唯一（重排发牌没撞号）");
    check(
      after.monsterIds.every((row) => row.zone_id === ADMIN_ZONE),
      "所有实例都挂在目标区",
      JSON.stringify(after.monsterIds.map((row) => row.zone_id).slice(0, 5)),
    );
    check(
      after.monsterIds.every((row) => !/_z2_/.test(row.instance_id)),
      "源区区段（z2）在 instanceId 里彻底消失",
      JSON.stringify(ids.filter((id) => /_z2_/.test(id))),
    );
    check(
      after.monsterIds.length === before.monsterIds.length,
      "实例总量不丢（合并前后行数一致）",
      `${before.monsterIds.length} → ${after.monsterIds.length}`,
    );

    // 代际：只动参与的两个区。三区（旁观）连行都不该多出来
    const epochBefore = new Map(before.epochs.map((row) => [row.zone_id, row.epoch]));
    const epochAfter = new Map(after.epochs.map((row) => [row.zone_id, row.epoch]));
    check(
      (epochAfter.get(ADMIN_ZONE) ?? 0) > (epochBefore.get(ADMIN_ZONE) ?? 0) &&
        (epochAfter.get(fromZoneId) ?? 0) > (epochBefore.get(fromZoneId) ?? 0),
      "参与合并的两个区代际都 +1（内存世界作废）",
      JSON.stringify({ before: before.epochs, after: after.epochs }),
    );
    checkEqual(
      epochAfter.get(bystanderZoneId) ?? 0,
      epochBefore.get(bystanderZoneId) ?? 0,
      "旁观区（三区）代际一格没动（合并不再惊动全服）",
    );

    //#endregion

    //#region 三、在线玩家被踢 + 死区不再播种

    group("三、在线玩家收到 zoneMerged 并断线；源区不再播种");
    const mergedFrame = await session.waitFrame("zoneMerged");
    check(
      !!mergedFrame && mergedFrame.data.zoneId === fromZoneId && mergedFrame.data.mergedInto === ADMIN_ZONE,
      "源区在线玩家收到 zoneMerged（带并入去向）",
      JSON.stringify(mergedFrame && mergedFrame.data),
    );
    checkEqual(mergedFrame && mergedFrame.data.mergedIntoName, "一区", "帧里带目标区名（客户端提示文案直接用）");
    const closed = await session.waitClose();
    checkEqual(closed && closed.code, 4002, "连接被断开，关闭码 = ZONE_MERGED 4002");

    // 等两轮 tick：源区的内存房间会被代际巡检作废；作废后「库里没有就不播」——
    // 这一条是合并最容易复活死区的地方（ensure 的空房播种会原样播一份回来）
    await sleep(1200);
    const settled = readMergeFacts(dbPath, fromZoneId, ADMIN_ZONE);
    checkEqual(settled.monstersOfFrom, 0, "源区 world_monsters 一行都没有（死区没被重新播种）");
    checkEqual(settled.monsterIds.length, after.monsterIds.length, "总量在此期间没有增生（没多播一份）");

    //#endregion

    //#region 四、合并后的边界

    group("四、合并后的边界：不能再当源 / 目标，选服被拒");
    const mergeAgain = await api(baseUrl, "POST", "admin/zones/merge", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { fromZoneId, toZoneId: bystanderZoneId },
    });
    checkEqual(mergeAgain.code, 50026, "已合并的区不能再当源区（ZONE_MERGED 50026）", mergeAgain.message);

    const precheckAfter = await api(baseUrl, "GET", `admin/zones/merge/precheck?fromZoneId=${fromZoneId}&toZoneId=${bystanderZoneId}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!precheckAfter.data && precheckAfter.data.ok === false,
      "预检也挡住（已合并的区 ok=false）",
      JSON.stringify(precheckAfter.data && precheckAfter.data.blockers),
    );

    const selectMerged = await api(baseUrl, "POST", "zones/select", { token: tokenB, body: { zoneId: fromZoneId } });
    checkEqual(selectMerged.code, 50026, "玩家选已合并的区被拒（50026）", selectMerged.message);

    const rolesNow = await api(baseUrl, "GET", "roles", { token: tokenB });
    check(
      Array.isArray(rolesNow.data) && rolesNow.data.length === 2 && rolesNow.data.every((row) => row.zoneId === ADMIN_ZONE),
      "玩家侧 GET /roles 只剩目标区的两个角色（源区视角已无角色）",
      JSON.stringify((rolesNow.data || []).map((row) => [row.name, row.zoneId])),
    );

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 合区 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 合区 e2e 全绿（${passed} 条断言）`);
  }
})();
