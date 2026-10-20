#!/usr/bin/env node
/**
 * 服务端 e2e：伤害结算（实时通道上的战斗指令）
 *
 * 这一套用**真实 WS 客户端**打真实服务（跑 dist/ 产物），覆盖 issue #34 服务端侧的全部验收：
 *
 * - 一次出手的伤害由服务端算出：cast（技能 / 目标）→ settle（伤害 / 剩余血量 / 是否击杀），
 *   血量算术自洽（hp = maxHp − damage 累计），且伤害落在公式允许的区间内
 * - 输入只认服务端那份权威：技能不存在 / 未学习、怪物 key 不存在、targetId 换了 key，全被拒
 * - **幂等**：同一 castId 重复投递不重复结算 —— 结果原样重发（duplicate: true），血量不扣两次
 * - 死亡由服务端判：血量到 0 恰好报一次 killed，之后的出手报 target_dead
 * - 换图清账：targetsReset 之后同一 targetId 按全新目标重新登记
 * - 断线清账：重连后同一 castId 视为新出手（结算上下文已随连接断开清掉）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:combat
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具

/**
 * 期望的断言条数（全绿时必须恰好这么多）
 * 改了断言就改这个数，并同步文档里的 e2e 总数（README.md / docs/resume.md；make audit 会比对）。
 */
const EXPECTED_ASSERTIONS = 32;

function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（make audit 会比对）");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
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

/** 起一台服务并等它就绪 */
async function startServer() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: ":memory:",
      JWT_SECRET: "e2e-combat-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
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

const waitFor = async (label, predicate, timeoutMs = 5_000) => {
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
 * 一条会话化的 WS 连接：cast 发出去，按 castId 等它自己的 settle 帧
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    closed: false,
    settles: [],
    worlds: [],
    /** 按 castId 等结算帧（幂等重发会来两帧，取最新的） */
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /**
     * 进图登记并等权威快照（#35 起实例 id 由服务端发牌，cast 之前必须先 join）
     * 只等 join 之后到达的 world 帧（别的推送不该被误当成这次 join 的应答）
     */
    async joinWorld(mapId, spawnPlan, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId, spawnPlan } }));
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
  socket.on("close", () => {
    session.closed = true;
  });
  socket.on("error", () => {});
  return session;
}

/** 一份最小可建号的角色文档（e2e-roles 的 roleData 同款口径） */
function roleData(id, name, level, skills) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills };
}

(async () => {
  const server = await startServer();
  try {
    const { baseUrl } = server;

    //#region 准备：账号 / 角色 / 实时连接

    group("准备：账号、角色与实时连接");
    const player = await api(baseUrl, "POST", "auth/register", { body: { username: "combat_player", password: "pass1234" } });
    const token = player.data && player.data.token;
    check(!!token, "准备：注册玩家拿到令牌", player.message);

    // 初始角色不带技能：先验证「未学习」被拒，再补上技能走正常结算
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleData("combat_r1", "斗战者", 1, {}) } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const wsUrl = `${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`;
    let session = connect(wsUrl);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    check(session.opened, "准备：实时连接已建立");

    /** 发一次 cast：返回 { id, promise }（id 是本次的 castId，promise 等它自己的 settle 帧） */
    let castSeq = 0;
    const cast = (session_, body) => {
      castSeq += 1;
      const id = castSeq;
      session_.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
      return { id, promise: session_.waitForSettle(id) };
    };

    /** 进图播种：地图 1 上两只怪（maxHp 65，物防 [4,6]），拿回服务端发的实例 id */
    const world = await session.joinWorld("1", [
      { monsterKey: "1", x: 100, y: 200 },
      { monsterKey: "1", x: 300, y: 400 },
    ]);
    check(world && world.monsters.length === 2, "准备：worldJoin 播种后拿到 2 只权威实例", JSON.stringify(world));
    const mobA = world && world.monsters[0];
    const mobB = world && world.monsters[1];
    check(!!mobA && /^m1_\d+$/.test(mobA.instanceId), "准备：实例 id 由服务端发牌（m1_N 形态）", mobA && mobA.instanceId);
    check(!!mobA && mobA.hp === 65 && mobA.maxHp === 65 && mobA.alive === true, "准备：实例以服务端表的满血起算");

    //#endregion

    //#region 一、输入只认服务端那份权威

    group("一、非法指令全被拒（不认识的技能 / 怪物 / 未学习）");

    const badShape = await cast(session, { skillId: 12345, targetId: "t1", monsterKey: "1" }).promise;
    check(badShape && badShape.ok === false && badShape.code === "bad_request", "cast 字段不合法被拒（bad_request）", JSON.stringify(badShape));

    const unknownSkill = await cast(session, { skillId: "9999", targetId: "t1", monsterKey: "1" }).promise;
    check(unknownSkill && unknownSkill.ok === false && unknownSkill.code === "unknown_skill", "不存在的技能被拒（unknown_skill）", JSON.stringify(unknownSkill));

    const unknownMonster = await cast(session, { skillId: "1000", targetId: "t1", monsterKey: "no_such_monster" }).promise;
    check(unknownMonster && unknownMonster.ok === false && unknownMonster.code === "unknown_target", "不存在的怪物 key 被拒（unknown_target）", JSON.stringify(unknownMonster));

    const fakeTarget = await cast(session, { skillId: "1000", targetId: "m1_999", monsterKey: "1" }).promise;
    check(fakeTarget && fakeTarget.ok === false && fakeTarget.code === "unknown_target", "不存在的实例 id 被拒（unknown_target，世界权威后 id 由服务端发牌）", JSON.stringify(fakeTarget));

    const notLearned = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
    check(notLearned && notLearned.ok === false && notLearned.code === "skill_not_learned", "未学习的技能被拒（skill_not_learned）", JSON.stringify(notLearned));

    //#endregion

    //#region 二、正常结算

    group("二、正常结算：伤害由服务端算出，血量算术自洽");
    const saved = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: roleData("combat_r1", "斗战者", 1, { 1000: 1 }) } });
    check(saved.code === 0, "准备：角色已学会技能 1000", saved.message);

    // 怪物 1：maxHp 65 / 物防 [4,6]；1 级角色物攻 [14,20]，技能 1 级倍率 1 → 伤害 ∈ [8, 16]
    const firstShot = cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" });
    const first = await firstShot.promise;
    check(!!(first && first.ok), "首次出手结算成功", JSON.stringify(first));
    const firstHp = first && first.ok ? first.hp : -1;
    check(first.ok && first.damage >= 8 && first.damage <= 16, "伤害落在公式区间 [8, 16] 内", `damage=${first.damage}`);
    check(first.ok && first.killed === false, "满血怪一击不死（killed = false）");
    check(first.ok && firstHp === 65 - first.damage, "血量算术自洽（hp = 65 − damage）", `hp=${firstHp}`);
    check(first.ok && first.duplicate === false, "首次结算 duplicate = false");

    const second = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
    check(!!(second && second.ok) && second.hp === firstHp - second.damage, "第二击在第一击的余量上继续扣", `hp=${second.hp}`);

    //#endregion

    //#region 三、幂等

    group("三、幂等：重复投递同一出手不重复结算");
    const beforeIdempotent = second.hp;
    // 同一次出手（同一 castId、同一内容）原样再投一遍 —— 服务端不许重复结算。
    // 只等重发之后到达的新帧：waitForSettle 会命中首次结算的旧帧（duplicate:false）。
    const settleCountBefore = session.settles.length;
    session.socket.send(JSON.stringify({
      type: "cast",
      data: { castId: firstShot.id, skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" },
    }));
    const replay = await waitFor(`castId=${firstShot.id} 重投后的新 settle`, async () => {
      const hits = session.settles
        .slice(settleCountBefore)
        .filter((frame) => frame.castId === firstShot.id);
      return hits.length > 0 ? hits[hits.length - 1] : null;
    });
    check(!!(replay && replay.ok && replay.duplicate === true), "重复的 castId 原样重发并标记 duplicate", JSON.stringify(replay));
    check(!!(replay && replay.ok) && replay.damage === (first.ok ? first.damage : -1), "重发的伤害与首次一致（没有重掷随机数）");
    const afterReplay = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
    check(!!(afterReplay && afterReplay.ok) && afterReplay.hp === beforeIdempotent - afterReplay.damage, "重放没有多扣血（第三击只扣一次）", `hp=${afterReplay.hp}`);

    //#endregion

    //#region 四、死亡判定

    group("四、死亡由服务端判：恰好一次 killed，之后 target_dead");
    let killedCount = 0;
    let deathHp = -1;
    for (let i = 0; i < 60; i++) {
      const result = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
      if (!result || !result.ok) break;
      if (result.killed) {
        killedCount += 1;
        deathHp = result.hp;
      }
    }
    checkEqual(killedCount, 1, "killed 恰好报一次");
    checkEqual(deathHp, 0, "死亡时血量恰好为 0");
    const deadCast = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
    check(deadCast && deadCast.ok === false && deadCast.code === "target_dead", "死后再打报 target_dead", JSON.stringify(deadCast));

    //#endregion

    //#region 五、幂等账与换图 / 断线（世界状态不随之清）

    group("五、幂等账被清（换图 / 断线），世界状态保持（共享且持久）");
    session.socket.send(JSON.stringify({ type: "targetsReset" }));
    await sleep(100);
    // targetsReset 只清幂等账：重投同 castId 会**重新走一遍校验** —— 而世界状态不被清账影响，
    // 死掉的怪照旧拒绝（#34 时代「清账后满血重来」的语义随世界权威一起终结）
    const replayAfterReset = await cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" }).promise;
    check(replayAfterReset && replayAfterReset.ok === false && replayAfterReset.code === "target_dead", "targetsReset 后重投被重新校验：死怪不因清账复活", JSON.stringify(replayAfterReset));

    // 世界快照如实：死亡的实例 alive=false 且带重生倒计时，活着的照常
    const snapshot = await session.joinWorld("1", []);
    const snapA = snapshot && snapshot.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    const snapB = snapshot && snapshot.monsters.find((m) => m.instanceId === (mobB ? mobB.instanceId : "m1_2"));
    check(!!snapA && snapA.alive === false && snapA.hp === 0 && typeof snapA.respawnInMs === "number", "快照里死亡的实例 alive=false 且带重生倒计时", JSON.stringify(snapA));
    check(!!snapB && snapB.alive === true && snapB.hp === 65, "快照里活着的实例状态不受会话操作影响", JSON.stringify(snapB));

    // 换图 = 发新的 worldJoin：旧图观看者身份移除、幂等账清零，但旧图实例状态原样保留
    const map2 = await session.joinWorld("2", [{ monsterKey: "3", x: 10, y: 20 }]);
    check(!!(map2 && map2.monsters.length === 1), "换图 worldJoin 拿到新图的实例", JSON.stringify(map2));
    const back = await session.joinWorld("1", []);
    const backA = back && back.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!backA && backA.alive === false && backA.hp === 0, "换图往返后旧图实例状态保持（世界状态不随会话清）");

    session.socket.close();
    await waitFor("旧连接断开", async () => (session.closed ? session : null));
    const ticket2 = await api(baseUrl, "POST", "realtime/ticket", { token });
    session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket2.data.ticket)}`);
    await waitFor("重连成功", async () => (session.opened ? session : null));
    // 重连后重新 join（播种计划为空 —— 实例已存在，不该翻倍），拿回权威状态
    const rejoined = await session.joinWorld("1", []);
    check(!!(rejoined && rejoined.monsters.length === 2), "重连后重新 worldJoin 不重复播种（仍是 2 只）", JSON.stringify(rejoined && rejoined.monsters.length));
    const rejoinA = rejoined && rejoined.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!rejoinA && rejoinA.alive === false && rejoinA.hp === 0, "重连拿回的状态与断线前一致（断线不清世界状态）");
    // castSeq 继续往下走；重连后同一 castId 也没人记得它 —— 视为新出手（打活着的 mobB）
    const reconnected = await cast(session, { skillId: "1000", targetId: mobB ? mobB.instanceId : "m1_2", monsterKey: "1" }).promise;
    check(!!(reconnected && reconnected.ok && reconnected.duplicate === false), "重连后结算上下文已清（同 castId 不算重复）", JSON.stringify(reconnected));

    //#endregion

    assertExpectedCount(passed, failed);
    console.log(`\n${failed === 0 ? "✅" : "❌"} 伤害结算：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
  }
})();
