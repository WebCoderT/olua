#!/usr/bin/env node
/**
 * 世界权威专项 e2e（server/test/e2e-world.cjs，issue #35）
 *
 * 盯的不变量（改世界层后必须全绿）：
 * 一、进图播种：worldJoin 创建实例并以 world 帧下发权威状态（instanceId 服务端发牌 /
 *     满血起算 / 重复 join 不翻倍）；第二个账号 join 同图看到**同一份**实例（世界跨账号共享）
 * 二、结算落世界：cast 的扣血直接写世界实例（快照如实反映）；打死由服务端判，快照带重生倒计时
 * 三、tick 重生：死亡满 respawn 阈值后由 tick 复活（满血回出生点），观看者收到 world 广播帧
 * 四、优雅关闭与重启恢复：SIGTERM 正常退出（exitCode 0）、状态已落盘；
 *     同库重启后 join 拿回扣过血的实例，卸载期间到期的重生被一次性补上
 *
 * 与其他 e2e 的关键差别：**用临时文件库**（不是 `:memory:`）—— 重启恢复那条只有文件库能验。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-combat 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 22;

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
 * 起一台服务（**文件库**：重启恢复的前提）；tick/落盘/重生阈值都调小，重生段才不用干等 30 秒
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
      JWT_SECRET: "e2e-world-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
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

/**
 * 一条会话化的 WS 连接（worldJoin / cast 的公共口）
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    settles: [],
    worlds: [],
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 只等 join 之后到达的 world 帧（广播与应答同形，按发送时刻切分） */
    async joinWorld(mapId, spawnPlan, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId, spawnPlan } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 等「join 之后到达」的新 world 帧（重生广播用） */
    async waitForNewWorld(baseline, mapId, timeoutMs = 15_000) {
      return waitFor(`mapId=${mapId} 的新 world 广播`, async () => {
        const hits = session.worlds.slice(baseline).filter((frame) => frame.mapId === mapId);
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
  socket.on("close", () => {
    session.closed = true;
  });
  return session;
}

/** 一份最小可建号的角色文档（e2e-combat 同款口径） */
function roleData(id, name, level, skills) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-world-${Date.now()}.db`);
  let server = await startServer(dbPath);
  try {
    // 重启段会换新端口：baseUrl 必须 let，connectAs 闭包每次读当前值
    let { baseUrl } = server;

    //#region 准备：两个账号 / 角色 / 连接（世界是跨账号共享的，要两个视角）

    group("准备：账号、角色与实时连接");
    const playerA = await api(baseUrl, "POST", "auth/register", { body: { username: "world_player_a", password: "pass1234" } });
    const playerB = await api(baseUrl, "POST", "auth/register", { body: { username: "world_player_b", password: "pass1234" } });
    const tokenA = playerA.data && playerA.data.token;
    const tokenB = playerB.data && playerB.data.token;
    check(!!tokenA && !!tokenB, "准备：两个玩家账号已注册", playerA.message || playerB.message);
    await api(baseUrl, "POST", "roles", { token: tokenA, body: { data: roleData("world_ra", "斩世界A", 1, { 1000: 1 }) } });
    await api(baseUrl, "POST", "roles", { token: tokenB, body: { data: roleData("world_rb", "斩世界B", 1, {}) } });

    const connectAs = async (token) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor("握手成功", async () => (session.opened ? session : null));
      return session;
    };
    let sessionA = await connectAs(tokenA);
    const sessionB = await connectAs(tokenB);
    check(sessionA.opened && sessionB.opened, "准备：两条实时连接已建立");

    /** 发一次 cast（castId 每条会话独立计数） */
    const makeCast = () => {
      let castSeq = 0;
      return (session_, body) => {
        castSeq += 1;
        const id = castSeq;
        session_.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
        return { id, promise: session_.waitForSettle(id) };
      };
    };
    const castA = makeCast();

    //#endregion

    //#region 一、进图播种与跨账号共享

    group("一、进图播种：权威快照下发，重复 join 不翻倍，跨账号共享");
    const plan = [
      { monsterKey: "1", x: 100, y: 200 },
      { monsterKey: "3", x: 300, y: 400 },
    ];
    const worldA1 = await sessionA.joinWorld("1", plan);
    check(!!(worldA1 && worldA1.monsters.length === 2), "播种后拿到 2 只权威实例", JSON.stringify(worldA1 && worldA1.monsters.length));
    const wA1 = worldA1.monsters[0];
    const wA2 = worldA1.monsters[1];
    check(/^m1_\d+$/.test(wA1.instanceId) && /^m1_\d+$/.test(wA2.instanceId) && wA1.instanceId !== wA2.instanceId, "实例 id 由服务端发牌且互不相同", `${wA1.instanceId} / ${wA2.instanceId}`);
    check(wA1.monsterKey === "1" && wA1.hp === 65 && wA1.maxHp === 65 && wA1.alive === true, "实例按服务端表的满血起算（怪物 1 maxHp 65）", `hp=${wA1.hp}`);
    check(wA1.x === 100 && wA1.y === 200, "实例位置 = 播种计划的出生点");

    const worldA2 = await sessionA.joinWorld("1", plan);
    check(!!(worldA2 && worldA2.monsters.length === 2), "重复 worldJoin 不翻倍（播种只补缺）", JSON.stringify(worldA2 && worldA2.monsters.length));

    const worldB = await sessionB.joinWorld("1", []);
    const shared = worldB.monsters.find((m) => m.instanceId === wA1.instanceId);
    check(!!(worldB && worldB.monsters.length === 2) && !!shared, "账号 B 看到同一份实例（世界跨账号共享，不按账号各发一份）", shared && shared.instanceId);

    //#endregion

    //#region 二、结算落世界

    group("二、结算落世界：cast 的扣血写进共享实例");
    // 怪物 1：maxHp 65 / 物防 [4,6]；1 级角色物攻 [14,20]，技能 1 级倍率 1 → 伤害 ∈ [8, 16]
    const shot = castA(sessionA, { skillId: "1000", targetId: wA1.instanceId, monsterKey: "1" });
    const settle = await shot.promise;
    check(!!(settle && settle.ok) && settle.damage >= 8 && settle.damage <= 16, "出手结算成功且伤害落带内", JSON.stringify(settle));
    const afterShot = await sessionA.joinWorld("1", []);
    const damaged = afterShot.monsters.find((m) => m.instanceId === wA1.instanceId);
    check(!!damaged && damaged.hp === (settle.ok ? settle.hp : -1), "世界快照的血量 = settle 返回的血量（同一份状态，不是两本账）", damaged && `hp=${damaged.hp}`);
    const seenByB = await sessionB.joinWorld("1", []);
    const seenDamaged = seenByB.monsters.find((m) => m.instanceId === wA1.instanceId);
    check(!!seenDamaged && seenDamaged.hp === damaged.hp, "账号 B 看到的血量同步（共享世界）", seenDamaged && `hp=${seenDamaged.hp}`);

    // 打死另一只：killed 由服务端判，快照 alive=false 且带重生倒计时
    let killed = false;
    for (let i = 0; i < 30; i++) {
      const result = await castA(sessionA, { skillId: "1000", targetId: wA2.instanceId, monsterKey: "3" }).promise;
      if (!result || !result.ok) break;
      if (result.killed) {
        killed = true;
        break;
      }
    }
    check(killed, "连打怪物 3 直到被击杀（killed 恰好出现）");
    const afterKill = await sessionA.joinWorld("1", []);
    const corpse = afterKill.monsters.find((m) => m.instanceId === wA2.instanceId);
    check(!!corpse && corpse.alive === false && corpse.hp === 0 && typeof corpse.respawnInMs === "number", "死亡实例 alive=false 且带重生倒计时", JSON.stringify(corpse));

    //#endregion

    //#region 三、tick 重生

    group("三、tick 循环：到点重生并广播给观看者");
    const broadcastBaseline = sessionA.worlds.length;
    const revived = await sessionA.waitForNewWorld(broadcastBaseline, "1");
    const revivedMonster = revived ? revived.monsters.find((m) => m.instanceId === wA2.instanceId) : null;
    check(!!revivedMonster && revivedMonster.alive === true && revivedMonster.hp === revivedMonster.maxHp, "respawn 阈值后怪被 tick 复活（满血）并广播", JSON.stringify(revivedMonster));
    check(revivedMonster && revivedMonster.x === wA2.x && revivedMonster.y === wA2.y, "重生回到原出生点");

    //#endregion

    //#region 四、优雅关闭与重启恢复

    group("四、优雅关闭：SIGTERM 正常退出，状态已落盘");
    // 打一只留个伤口（重启后它应保持这份血量）；刚复活的怪物 3 会被留下满血状态
    const woundShot = castA(sessionA, { skillId: "1000", targetId: wA1.instanceId, monsterKey: "1" });
    const wound = await woundShot.promise;
    check(!!(wound && wound.ok), "重启前最后一次出手成功（留伤口）", JSON.stringify(wound));
    const hpBeforeRestart = wound && wound.ok ? wound.hp : -1;

    server.child.kill("SIGTERM");
    const exited = await waitFor(
      "服务进程在 SIGTERM 后退出",
      async () => (server.child.exitCode !== null || server.child.signalCode ? server.child : null),
    );
    check(!!exited && (server.child.exitCode === 0 || server.child.signalCode === "SIGTERM"), "优雅关闭：关闭序列走完后进程终止（Nest 收尾后按惯例重发 SIGTERM）", `code=${server.child.exitCode} signal=${server.child.signalCode}`);
    check(server.logs().includes("世界状态已全部落盘"), "关服前世界状态已全量落盘（服务端日志可见）");

    group("五、重启恢复：同库再起，世界状态不丢");
    server = await startServer(dbPath);
    ({ baseUrl } = server);
    sessionA = await connectAs(tokenA);
    const rejoined = await sessionA.joinWorld("1", plan);
    check(!!(rejoined && rejoined.monsters.length === 2), "重启后 worldJoin 恢复实例（不重新播种翻倍）", JSON.stringify(rejoined && rejoined.monsters.length));
    const restored = rejoined.monsters.find((m) => m.instanceId === wA1.instanceId);
    check(!!restored, "重启后实例 id 不变（服务端发牌跨重启稳定）", restored && restored.instanceId);
    check(!!restored && restored.hp === hpBeforeRestart, "重启前扣过的血原样恢复（hp = 关服前那次结算的值）", restored && `hp=${restored.hp}`);
    const restoredThree = rejoined.monsters.find((m) => m.instanceId === wA2.instanceId);
    check(!!restoredThree && restoredThree.alive === true, "关服期间已到期的重生在重新加载时被一次性补上（不连环重生、也不丢复活）", restoredThree && `alive=${restoredThree.alive}`);

    //#endregion

    assertExpectedCount();
    console.log(`\n${failed === 0 ? "✅" : "❌"} 世界权威：${passed} 条通过 / ${failed} 条失败`);
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
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
