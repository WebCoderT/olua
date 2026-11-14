#!/usr/bin/env node
/**
 * 世界 tick 专项 e2e（server/test/e2e-world-tick.cjs，#849 ~ #852）
 *
 * 盯的不变量（改世界 tick / 刷怪配置后必须全绿）：
 * 一、**密度播种**（#852）：空图按「目标数」播种，不认识的 key 跳过；同一份配置下
 *     目标 = max × 时段系数 × 人数系数；
 * 二、**改配置 1 秒内生效**（#852 / #669 的根）：改 `max` 之后 tick 按差量补 / 裁，
 *     不用等分域卸载；补有上限（每次最多 2 只）；
 * 三、**密度系数**（#852）：低谷系数 0 → 这一区被裁空；高峰系数 2 → 目标翻倍；
 * 四、**越界钳制**（#850）：整块在图外的刷怪区不再把怪刷到图外（落点钳在图内）；
 * 五、**落盘节流**（#849）：`worldPersistMs` 是节流间隔 —— 受击后短时间内库里还是旧值，
 *     关服时 `flushAll` 一定把最后一次变化写进去（丢的只是「进程被硬杀」的那点窗口）；
 * 六、**代际作废**（#851）：`world_meta.epoch` 变了 → 有人看的分域按库重载并广播，
 *     客户端**不用再发 worldJoin** 就能拿到新实例表（旧 instanceId 不会一直悬着）。
 *
 * 与其他 e2e 的差别：用**文件库**（节流与重启恢复只有文件库能验），并且第一次启动把
 * `WORLD_PERSIST_MS` 调到很大 —— 「没到点就不写库」这条只有把节流窗口拉长才测得准
 * （默认 5s 的窗口里，任何一次读库都可能刚好撞上 flush，断言会偶发假红）。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const MAP_ID = "1";
/** 第一次启动的节流间隔：大到整段测试都不会自己 flush（只有关服 flushAll 会写） */
const HUGE_PERSIST_MS = 600_000;
const TICK_MS = 200;

//#region 断言小工具（与 e2e-world 同款口径）

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

const waitFor = async (label, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  return last;
};

/** 直接改库（服务端正在写，必须等锁；与 place-role.cjs 同一取向） */
function withDb(dbPath, run) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * 三个刷怪区，各喂一种「要验的形态」（必须在服务端就绪之后写：#655 起空库首启会用
 * `config-sync.sql` 把配置表整表灌一遍，启动前写进来的行会被整表替换掉）
 *
 * | 区 | 怪物 | max | 位置 | 用来验什么 |
 * |---|---|---|---|---|
 * | 甲区 | 1 | 3 | 图内 | 播种数量、改大补、改小裁 |
 * | 乙区 | 3 | 2 | 图内 | 密度系数（低谷 0 / 高峰 2） |
 * | 丙区 | 5 | 2 | **整块在图外**（y 全为正） | #850 落点钳制 |
 */
function seedAreas(dbPath) {
  withDb(dbPath, (db) => {
    db.exec(`DELETE FROM map_spawn_areas WHERE map_id = '${MAP_ID}'`);
    const insert = db.prepare(
      `INSERT INTO map_spawn_areas
         (map_id, name, monster_key, min, max, density_peak, density_off, peak_hours, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run(MAP_ID, "甲区", "1", 3, 2000, -2000, 400, 400, now);
    insert.run(MAP_ID, "乙区", "3", 2, 4000, -4000, 400, 400, now);
    insert.run(MAP_ID, "丙区", "5", 2, 2000, 800, 400, 400, now);
  });
}

async function startServer(dbPath, persistMs) {
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
      JWT_SECRET: "e2e-world-tick-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: String(TICK_MS),
      WORLD_PERSIST_MS: String(persistMs),
      // 重生拉到很长：本套要数「这一区现在几只」，重生插进来会把数量搅乱
      WORLD_RESPAWN_MS: "600000",
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

function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    settles: [],
    /** 此刻这张图的最新一份快照（广播 / 应答同形，取最后一条即可） */
    latest() {
      return session.worlds.length > 0 ? session.worlds[session.worlds.length - 1] : null;
    },
    countOf(monsterKey) {
      const frame = session.latest();
      return frame ? frame.monsters.filter((monster) => monster.monsterKey === monsterKey).length : -1;
    },
    async waitCount(monsterKey, expected, timeoutMs = 10_000) {
      await waitFor(`monsterKey=${monsterKey} 的数量变成 ${expected}`, async () => session.countOf(monsterKey) === expected, timeoutMs);
      return session.countOf(monsterKey);
    },
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    async waitNewWorld(baseline, timeoutMs = 8_000) {
      return waitFor(
        "新的 world 广播帧",
        async () => (session.worlds.length > baseline ? session.worlds[session.worlds.length - 1] : null),
        timeoutMs,
      );
    },
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.filter((frame) => frame.castId === castId);
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
      if (frame.type === "settle") session.settles.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 一个「跨零点安全」的时刻窗口：`HH:MM-HH:MM`，按给定偏移算 */
function windowAround(offsetMinutes, spanMinutes) {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const from = at.getHours() * 60 + at.getMinutes();
  const to = (from + spanMinutes) % (24 * 60);
  const text = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${text(from)}-${text(to)}`;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-world-tick-${Date.now()}.db`);
  let server = await startServer(dbPath, HUGE_PERSIST_MS);
  try {
    seedAreas(dbPath);
    let { baseUrl } = server;

    //#region 准备
    group("准备：账号、角色、实时连接");
    const player = await api(baseUrl, "POST", "auth/register", { body: { username: "world_tick_a", password: "pass1234" } });
    const token = player.data && player.data.token;
    check(!!token, "账号已注册", player.message);
    await api(baseUrl, "POST", "roles", { token, body: { name: "斩tick", occupation: "1", sex: "1" } });
    placeRolesAt(dbPath, MAP_ID);
    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    let session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    check(session.opened, "实时连接已建立");
    //#endregion

    //#region 一、播种与落点钳制
    group("一、密度播种：按目标数播种，越界区域落点被钳进图内（#850 / #852）");
    const first = await session.joinWorld(MAP_ID);
    check(!!(first && first.monsters.length === 7), "三个区按目标数播种出 7 只（3 + 2 + 2）", JSON.stringify(first && first.monsters.length));
    checkEqual(session.countOf("1"), 3, "甲区 3 只（max 3，无密度系数）");
    checkEqual(session.countOf("3"), 2, "乙区 2 只（max 2）");
    const clamped = first.monsters.filter((monster) => monster.monsterKey === "5");
    checkEqual(clamped.length, 2, "丙区 2 只（整块在图外也照刷，只是落点钳制）");
    check(
      clamped.every((monster) => monster.y === 0 && monster.x >= 0 && monster.x <= 8192),
      "越界区的落点被钳到图内（y 轴向上，图上方即 y = 0）",
      JSON.stringify(clamped.map((monster) => [Math.round(monster.x), Math.round(monster.y)])),
    );
    check(
      first.monsters.every((monster) => monster.x >= 0 && monster.x <= 8192 && monster.y >= -8192 && monster.y <= 0),
      "全部实例都落在图内（钳制对每个落点都生效）",
    );
    //#endregion

    //#region 二、改配置 1 秒内生效
    group("二、改 max 之后 tick 按差量对齐（#852 / #669 的根）");
    withDb(dbPath, (db) => db.prepare(`UPDATE map_spawn_areas SET max = 8 WHERE map_id = ? AND name = '甲区'`).run(MAP_ID));
    const grown = await session.waitCount("1", 8, 8_000);
    checkEqual(grown, 8, "甲区 max 3 → 8，补到 8 只（不用等分域卸载）");

    withDb(dbPath, (db) => db.prepare(`UPDATE map_spawn_areas SET max = 1 WHERE map_id = ? AND name = '甲区'`).run(MAP_ID));
    const shrunk = await session.waitCount("1", 1, 8_000);
    checkEqual(shrunk, 1, "甲区 max 8 → 1，多出来的 7 只被裁掉");
    checkEqual(session.countOf("3"), 2, "裁剪只动超标的区（乙区仍是 2 只）");
    //#endregion

    //#region 三、密度系数
    group("三、密度系数按「时段 × 人数」缩放目标（#852）");
    // 低谷系数 0 + 一个不包含此刻的时段 → 这一区目标 0
    withDb(dbPath, (db) =>
      db
        .prepare(`UPDATE map_spawn_areas SET density_off = 0, peak_hours = ? WHERE map_id = ? AND name = '乙区'`)
        .run(windowAround(180, 60), MAP_ID),
    );
    const emptied = await session.waitCount("3", 0, 8_000);
    checkEqual(emptied, 0, "低谷系数 0 → 乙区被裁空");

    // 高峰系数 2 + 包含此刻的时段 → 目标 = max 2 × 2 = 4
    withDb(dbPath, (db) =>
      db
        .prepare(`UPDATE map_spawn_areas SET density_peak = 2, density_off = 1, peak_hours = ? WHERE map_id = ? AND name = '乙区'`)
        .run(windowAround(-2, 4), MAP_ID),
    );
    const peaked = await session.waitCount("3", 4, 8_000);
    checkEqual(peaked, 4, "高峰系数 2 → 乙区目标 4 只（max × peak 是上限）");
    //#endregion

    //#region 四、落盘节流
    group("四、落盘节流：worldPersistMs 是间隔，关服才全量落盘（#849）");
    const shot = (() => {
      const id = 1;
      const promise = (async () => {
        await paceCast();
        session.socket.send(JSON.stringify({ type: "cast", data: { castId: id, skillId: "1000", targetId: session.latest().monsters.find((monster) => monster.monsterKey === "1").instanceId, monsterKey: "1" } }));
        return session.waitForSettle(id);
      })();
      return { promise };
    })();
    const settle = await shot.promise;
    check(!!(settle && settle.ok), "出手结算成功（打甲区那只）", JSON.stringify(settle));
    const targetId = session.latest().monsters.find((monster) => monster.monsterKey === "1").instanceId;

    // 节流窗口还没到：这一行要么还没落过库（播种也是脏数据），要么还是满血 —— 都不能反映这次伤害
    const stale = withDb(dbPath, (db) => db.prepare("SELECT hp, max_hp FROM world_monsters WHERE instance_id = ?").get(targetId));
    check(
      !stale || stale.hp === stale.max_hp,
      "受击后立刻读库：这一行还没被写过（或仍是满血）—— 节流窗口没到，tick 不写库",
      stale ? JSON.stringify(stale) : "库里还没有这一行",
    );

    server.child.kill("SIGTERM");
    const exited = await waitFor("SIGTERM 后进程退出", async () =>
      server.child.exitCode !== null || server.child.signalCode ? server : null,
    );
    check(!!exited, "优雅关闭完成", `code=${server.child.exitCode} signal=${server.child.signalCode}`);
    check(server.logs().includes("世界状态已全部落盘"), "关服前世界状态已全量落盘（日志可见）");
    const flushed = withDb(dbPath, (db) => db.prepare("SELECT hp FROM world_monsters WHERE instance_id = ?").get(targetId));
    check(!!flushed && flushed.hp === settle.hp, "关服落盘把最后一次受击写进去了（节流只影响硬杀时丢几秒）", JSON.stringify(flushed));
    //#endregion

    //#region 五、代际作废：重载 + 通知
    group("五、世界代际变化：当场按库重载并广播，不用再 worldJoin（#851）");
    // 乙区的密度是上一段的临时值，重置回「无密度」，重启后的目标才是可预期的 1 + 2 + 2
    withDb(dbPath, (db) =>
      db.prepare(`UPDATE map_spawn_areas SET density_peak = NULL, density_off = NULL, peak_hours = NULL WHERE map_id = ? AND name = '乙区'`).run(MAP_ID),
    );
    server = await startServer(dbPath, 500);
    ({ baseUrl } = server);
    const ticket2 = await api(baseUrl, "POST", "realtime/ticket", { token });
    session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket2.data.ticket)}`);
    await waitFor("第二次握手成功", async () => (session.opened ? session : null));
    const rejoined = await session.joinWorld(MAP_ID);
    check(!!rejoined, "重启后 worldJoin 拿回快照");
    // 上一段把乙区抬到 4 只（密度也写进了库），这一段按「无密度」开局 —— tick 会在 1 秒内裁回 2 只。
    // 先等它收敛，再断言总数与实例 id（不然比的是「重启瞬间」那份还没对齐的帧）
    checkEqual(await session.waitCount("3", 2, 8_000), 2, "重启后乙区按无密度配置裁回 2 只");
    const settledFrame = session.latest();
    checkEqual(settledFrame.monsters.length, 5, "对齐后共 5 只（甲 1 / 乙 2 / 丙 2）");
    const idsBefore = settledFrame.monsters.map((monster) => monster.instanceId).sort();
    check(idsBefore.every((instanceId) => instanceId.startsWith(`m${MAP_ID}_z1_`)), "实例 id 的区段没有漂移（z1）", idsBefore[0]);

    const baseline = session.worlds.length;
    withDb(dbPath, (db) => db.prepare("UPDATE world_meta SET epoch = epoch + 1 WHERE id = 1").run());
    const pushed = await session.waitNewWorld(baseline, 8_000);
    check(!!pushed, "代际变了之后收到主动下发的 world 帧（没有发 worldJoin）");
    const idsAfter = pushed ? pushed.monsters.map((monster) => monster.instanceId).sort() : [];
    check(
      pushed && pushed.monsters.length === 5 && JSON.stringify(idsAfter) === JSON.stringify(idsBefore),
      "重载后的实例表与库里一致（数量与 instanceId 都对得上）",
      JSON.stringify(idsAfter),
    );
    // 日志走 stdout 管道、世界帧走 WS —— 两条通道的到达顺序不保证（机器负载高时帧会先到）。
    // 所以这一条等一会儿再说，别当场断言：`make e2e-all` 串行跑满 60 多套时曾偶发红在这里
    const reloadLogged = await waitFor(
      "「已按库重载并通知观看者」日志",
      async () => (server.logs().includes("已按库重载并通知观看者") ? true : null),
      3_000,
    );
    check(!!reloadLogged, "日志点明「重载 + 通知」这条收口（排障时能一眼看到）");
    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 世界 tick：#849~#852 —— ${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
    }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
