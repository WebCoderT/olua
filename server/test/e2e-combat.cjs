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
 * - 击杀奖励（#316）：经验入账（含升级 / 等级差无经验）与掉落抽取都在服务端，
 *   settle 帧带 reward；管理端改 level_exps / monster_drops 即时生效；幂等重发原样带同一份 reward
 * - 换图清账：targetsReset 之后同一 targetId 按全新目标重新登记
 * - 断线清账：重连后同一 castId 视为新出手（结算上下文已随连接断开清掉）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:combat
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（与 startServer 的 ADMIN_REGISTER_CODE 同值；击杀奖励 region 要用它改配置表） */
const ADMIN_CODE = "e2e-combat-admin";

//#region 断言小工具

/**
 * 期望的断言条数（全绿时必须恰好这么多）
 * 改了断言就改这个数，并同步文档里的 e2e 总数（README.md / docs/resume.md；make audit 会比对）。
 */
const EXPECTED_ASSERTIONS = 69;

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

/**
 * 预先往临时库里插刷怪区（#295：播种来源 = map_spawn_areas，客户端不再上报计划）。
 * 表先建好再插行，服务端启动时的建表与空表 seed 都不会动它。
 * 地图 1 一区两只怪物 1（max 2），地图 2 一区一只怪物 3 —— 与旧播种计划等价。
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
  insert.run("1", "1号怪物", "1", 0, 2, 200, 300, 400, 400, now);
  insert.run("2", "1号怪物", "3", 0, 1, 10, 20, 100, 100, now);
  db.close();
}

/** 起一台服务并等它就绪（#295 起 DB 用临时文件库：刷怪区要在启动前插好） */
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
      JWT_SECRET: "e2e-combat-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 击杀奖励 region（#316）要等怪重生：把默认 30s 压到 5s（前一组「断线不清世界状态」
      // 的断言都在击杀后 2s 内完成，5s 有三倍余量；后面的等待用显式超时兜住）
      WORLD_RESPAWN_MS: "5000",
      // 怪物 AI region（#323）：tick 与广播压到最快，命中帧等待才有余量
      MONSTER_AI_TICK_MS: "50",
      MONSTER_AI_BROADCAST_MS: "100",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
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

/** 注册并登录一个管理员，返回 token（临时库是空的，第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { username, password } });
  return login.data && login.data.token;
}

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
    /** 怪物 AI 广播帧（#323：位置增量 + 普攻命中事件） */
    ais: [],
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
      if (frame.type === "monster-ai") session.ais.push(frame.data);
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
  const dbPath = path.join(os.tmpdir(), `olua-e2e-combat-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
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
    const world = await session.joinWorld("1");
    check(world && world.monsters.length === 2, "准备：worldJoin 播种后拿到 2 只权威实例", JSON.stringify(world));
    const mobA = world && world.monsters[0];
    const mobB = world && world.monsters[1];
    check(!!mobA && /^m1_z1_\d+$/.test(mobA.instanceId), "准备：实例 id 由服务端发牌（m1_z1_N 形态，带区段）", mobA && mobA.instanceId);
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
    const snapshot = await session.joinWorld("1");
    const snapA = snapshot && snapshot.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    const snapB = snapshot && snapshot.monsters.find((m) => m.instanceId === (mobB ? mobB.instanceId : "m1_2"));
    check(!!snapA && snapA.alive === false && snapA.hp === 0 && typeof snapA.respawnInMs === "number", "快照里死亡的实例 alive=false 且带重生倒计时", JSON.stringify(snapA));
    check(!!snapB && snapB.alive === true && snapB.hp === 65, "快照里活着的实例状态不受会话操作影响", JSON.stringify(snapB));

    // 换图 = 发新的 worldJoin：旧图观看者身份移除、幂等账清零，但旧图实例状态原样保留
    const map2 = await session.joinWorld("2");
    check(!!(map2 && map2.monsters.length === 1), "换图 worldJoin 拿到新图的实例", JSON.stringify(map2));
    const back = await session.joinWorld("1");
    const backA = back && back.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!backA && backA.alive === false && backA.hp === 0, "换图往返后旧图实例状态保持（世界状态不随会话清）");

    session.socket.close();
    await waitFor("旧连接断开", async () => (session.closed ? session : null));
    const ticket2 = await api(baseUrl, "POST", "realtime/ticket", { token });
    session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket2.data.ticket)}`);
    await waitFor("重连成功", async () => (session.opened ? session : null));
    // 重连后重新 join（播种计划为空 —— 实例已存在，不该翻倍），拿回权威状态
    const rejoined = await session.joinWorld("1");
    check(!!(rejoined && rejoined.monsters.length === 2), "重连后重新 worldJoin 不重复播种（仍是 2 只）", JSON.stringify(rejoined && rejoined.monsters.length));
    const rejoinA = rejoined && rejoined.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!rejoinA && rejoinA.alive === false && rejoinA.hp === 0, "重连拿回的状态与断线前一致（断线不清世界状态）");
    // castSeq 继续往下走；重连后同一 castId 也没人记得它 —— 视为新出手（打活着的 mobB）
    const reconnected = await cast(session, { skillId: "1000", targetId: mobB ? mobB.instanceId : "m1_2", monsterKey: "1" }).promise;
    check(!!(reconnected && reconnected.ok && reconnected.duplicate === false), "重连后结算上下文已清（同 castId 不算重复）", JSON.stringify(reconnected));

    //#endregion

    //#region 六、击杀奖励（#316）：经验与掉落的结算在服务端

    group("六、击杀奖励：经验与掉落的结算在服务端（settle 帧 reward）");

    const adminToken = await registerAdmin(baseUrl, "combat_admin", "Combat#123");
    check(!!adminToken, "准备：管理员已登录（击杀奖励要用它改配置表）");

    /** 再来一名带技能的玩家（独立账号 / 角色 / 实时连接），返回 { token, roleId, session } */
    async function newPlayer(name, level = 1) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const playerToken = registered.data && registered.data.token;
      const createdRole = await api(baseUrl, "POST", "roles", { token: playerToken, body: { data: roleData(`${name}_r1`, name, level, { 1000: 1 }) } });
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: playerToken });
      const playerSession = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor(`${name} 握手成功`, async () => (playerSession.opened ? playerSession : null));
      return { token: playerToken, roleId: createdRole.data && createdRole.data.id, session: playerSession };
    }

    /** 连续出手直到目标死亡，返回带 killed 的那次结算（打不死 / 被拒返回 null） */
    async function killMonster(player, monsterKey, instanceId) {
      for (let i = 0; i < 80; i++) {
        const result = await cast(player.session, { skillId: "1000", targetId: instanceId, monsterKey }).promise;
        if (!result || !result.ok) return null;
        if (result.killed) return result;
      }
      return null;
    }

    /** 等某张图上出现活着的怪（WORLD_RESPAWN_MS = 5s，前面的 region 杀过图 1 的怪） */
    async function aliveMonster(player, mapId) {
      return waitFor(`mapId=${mapId} 有活着的怪`, async () => {
        const snap = await player.session.joinWorld(mapId);
        return (snap && snap.monsters.find((m) => m.alive)) || null;
      }, 15_000);
    }

    // —— A. 正常经验：同级击杀 = (怪物等级 + 1) × expPerLevel，服务端落账（revision 推进）——

    const killerA = await newPlayer("combat_rwa");
    const mobA2 = await aliveMonster(killerA, "1");
    check(!!mobA2, "A：等到了活着的怪（前面的击杀已按 5s 重生）", JSON.stringify(mobA2));
    const killedA = await killMonster(killerA, mobA2.monsterKey, mobA2.instanceId);
    check(!!(killedA && killedA.ok && killedA.reward), "A：击杀结算带 reward", JSON.stringify(killedA));
    check(!!(killedA && killedA.reward) && killedA.reward.exp === 10, "A：同级击杀经验 = (1+1)×5 = 10", JSON.stringify(killedA && killedA.reward));
    check(!!(killedA && killedA.reward) && killedA.reward.leveledUp === false && killedA.reward.level === 1, "A：10 经验不够升级（level 不变 / leveledUp=false）");
    check(Array.isArray(killedA && killedA.reward && killedA.reward.drops), "A：reward.drops 是数组（内容随掉落表，确定性断言在 C 组）");
    const roleA = await api(baseUrl, "GET", `roles/${killerA.roleId}`, { token: killerA.token });
    check(roleA.code === 0 && roleA.data.data.exp === 10, "A：服务端已把经验落进存档（data.exp = 10）", JSON.stringify(roleA.data && roleA.data.exp));
    check(roleA.code === 0 && roleA.data.revision === (killedA.reward ? killedA.reward.revision : -1), "A：reward.revision 与服务端当前修订号一致（客户端照搬不会撞乐观锁）");

    // —— B. 升级：level_exps 管理端改值即时生效 ——

    const levelExpsBefore = await api(baseUrl, "GET", "admin/level-exps?page=1&size=100", { token: adminToken });
    const levelOneRow = levelExpsBefore.data && levelExpsBefore.data.list.find((row) => row.level === 1);
    check(!!levelOneRow, "B：读到 1 级经验 seed 行", JSON.stringify(levelOneRow));
    await api(baseUrl, "PATCH", "admin/level-exps/1", { token: adminToken, body: { exp: 5 } });

    const killerB = await newPlayer("combat_rwb");
    const mobB2 = await aliveMonster(killerB, "2");
    check(!!mobB2, "B：地图 2 等到了活着的怪", JSON.stringify(mobB2));
    const killedB = await killMonster(killerB, mobB2.monsterKey, mobB2.instanceId);
    // 怪物 3 是 2 级：1 级角色打它差 1 级 → (2+1)×5×(1−1/6) = 12.5 → 13；1 级升 2 级只需 5（刚被管理端改小）→ 升 1 级剩 8
    check(!!(killedB && killedB.reward) && killedB.reward.exp === 13, "B：击杀 2 级怪经验 = 15×(1−1/6) = 13", JSON.stringify(killedB && killedB.reward));
    check(!!(killedB && killedB.reward) && killedB.reward.leveledUp === true && killedB.reward.level === 2 && killedB.reward.expNow === 8, "B：管理端改 level_exps 即时生效（升到 2 级，本级剩 8）", JSON.stringify(killedB && killedB.reward));
    const roleB = await api(baseUrl, "GET", `roles/${killerB.roleId}`, { token: killerB.token });
    check(roleB.code === 0 && roleB.data.level === 2 && roleB.data.data.exp === 8, "B：服务端已升级（level 列 = 2，data.exp = 8）", JSON.stringify({ level: roleB.data && roleB.data.level, exp: roleB.data && roleB.data.data && roleB.data.data.exp }));
    // 还原：把 1 级经验改回 seed 值（本库独立，但保持「测试后还原 seed」的纪律）
    await api(baseUrl, "PATCH", "admin/level-exps/1", { token: adminToken, body: { exp: levelOneRow.exp } });

    // —— C. 确定性掉落：monster_drops 管理端改值即时生效 ——

    const dropsBefore = await api(baseUrl, "GET", "admin/monster-drops?page=1&size=20", { token: adminToken });
    const dropRowOne = dropsBefore.data && dropsBefore.data.list.find((row) => row.monsterKey === "1");
    check(!!dropRowOne, "C：读到怪物 1 的掉落 seed 行", JSON.stringify(dropRowOne && dropRowOne.source));
    await api(baseUrl, "PATCH", "admin/monster-drops/1", {
      token: adminToken,
      body: { tableId: null, picks: 2, entries: [{ goodId: "drug_hp_1", weight: 100, chance: 1, count: [2, 2] }] },
    });

    const killerC = await newPlayer("combat_rwc");
    const mobC = await aliveMonster(killerC, "1");
    check(!!mobC, "C：等到了活着的怪", JSON.stringify(mobC));
    const killedC = await killMonster(killerC, mobC.monsterKey, mobC.instanceId);
    // picks 2 × 每次必掉 2 个 → 合并后恰好 drug_hp_1 x4（权重/概率/数量全确定）
    check(
      !!(killedC && killedC.reward) && JSON.stringify(killedC.reward.drops) === JSON.stringify([{ goodId: "drug_hp_1", count: 4 }]),
      "C：掉落按改后的表结算（2 次抽取 × 每次 2 个，合并 = drug_hp_1 x4）",
      JSON.stringify(killedC && killedC.reward && killedC.reward.drops),
    );
    check(!!(killedC && killedC.reward) && killedC.reward.exp === 10 && killedC.reward.leveledUp === false, "C：经验与掉落互不影响（level_exps 已还原，不再升级）");

    // 幂等：重发击杀那次的 castId，reward 原样重发（不重掷掉落、不重复入账）
    const killedCastId = castSeq; // killMonster 的最后一发就是击杀那发
    const replayCount = killerC.session.settles.length;
    killerC.session.socket.send(JSON.stringify({
      type: "cast",
      data: { castId: killedCastId, skillId: "1000", targetId: mobC.instanceId, monsterKey: mobC.monsterKey },
    }));
    const rewardReplay = await waitFor("击杀 castId 重投后的新 settle", async () => {
      const hits = killerC.session.settles.slice(replayCount).filter((frame) => frame.castId === killedCastId);
      return hits.length > 0 ? hits[hits.length - 1] : null;
    });
    check(
      !!(killedC && rewardReplay && rewardReplay.ok && rewardReplay.duplicate === true) &&
        JSON.stringify(rewardReplay.reward) === JSON.stringify(killedC.reward),
      "C：重复投递原样重发同一份 reward（不重掷、不重复入账）",
      JSON.stringify(rewardReplay),
    );
    // 还原怪物 1 的掉落配置（seed 是内联条目池）
    await api(baseUrl, "PATCH", "admin/monster-drops/1", {
      token: adminToken,
      body: { tableId: null, picks: dropRowOne.picks, entries: dropRowOne.entries },
    });

    // —— D. 等级差无经验：差 ≥ maxLevelGap（6）→ exp = 0，不入账不推修订号 ——

    const killerD = await newPlayer("combat_rwd");
    const roleDBefore = await api(baseUrl, "GET", `roles/${killerD.roleId}`, { token: killerD.token });
    const revisionDBefore = roleDBefore.data && roleDBefore.data.revision;
    // 把角色存成 10 级（revision 用最新值；带的还是 1 级技能，结算只看等级差）
    const savedD = await api(baseUrl, "PUT", `roles/${killerD.roleId}`, {
      token: killerD.token,
      body: { revision: revisionDBefore, data: roleData("combat_rwd_r1", "combd", 10, { 1000: 1 }) },
    });
    check(savedD.code === 0 && savedD.data.revision === revisionDBefore + 1, "D：角色已存成 10 级（revision 推进一次）", JSON.stringify(savedD.data && savedD.data.revision));
    const mobD = await aliveMonster(killerD, "1");
    check(!!mobD, "D：等到了活着的怪", JSON.stringify(mobD));
    const killedD2 = mobD ? await killMonster(killerD, mobD.monsterKey, mobD.instanceId) : null;
    check(!!(killedD2 && killedD2.reward) && killedD2.reward.exp === 0, "D：等级差 9 ≥ 6 → 无经验（exp = 0）", JSON.stringify(killedD2 && killedD2.reward));
    check(!!(killedD2 && killedD2.reward) && killedD2.reward.revision === revisionDBefore + 1, "D：无经验不入账（revision 不再推进）", JSON.stringify(killedD2 && killedD2.reward));
    const roleDAfter = await api(baseUrl, "GET", `roles/${killerD.roleId}`, { token: killerD.token });
    check(roleDAfter.code === 0 && !roleDAfter.data.data.exp, "D：存档里没有经验记录（服务端没有多记）", JSON.stringify(roleDAfter.data && roleDAfter.data.data && roleDAfter.data.data.exp));

    //#endregion

    //#region 七、怪物 AI（#323）：目标 / 移动 / 普攻与玩家受击的权威在服务端

    group("七、怪物 AI：普攻与玩家受击由服务端结算（monster-ai 帧）");

    const fighter = await newPlayer("combat_raf");
    // 地图 2：一只怪物 3（前面的 region 没动过它），拿服务端发的出生点
    const aiMob = await aliveMonster(fighter, "2");
    check(!!aiMob, "七：地图 2 有活着的怪（拿服务端发的出生点）", JSON.stringify(aiMob));

    // 出手一次激怒被动怪（结算顺带把「打伤它的人」记给 AI —— 追击由此开始）
    const provokeShot = await cast(fighter.session, { skillId: "1000", targetId: aiMob.instanceId, monsterKey: aiMob.monsterKey }).promise;
    check(!!(provokeShot && provokeShot.ok), "七：出手激怒被动怪（结算成功）", JSON.stringify(provokeShot));

    /** 周期上报位置（pos 帧有过期时间，断言窗口比它长就要持续喂） */
    let posTimer = null;
    const reportPos = (x, y, hp) => fighter.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x, y, hp } }));
    const hitCount = () => fighter.session.ais.reduce((sum, frame) => sum + (frame.hits ? frame.hits.length : 0), 0);

    // —— A. 激怒后进入普攻距离：服务端出招，玩家受击落账 ——
    const near = { x: aiMob.x + 10, y: aiMob.y };
    reportPos(near.x, near.y, 100);
    posTimer = setInterval(() => reportPos(near.x, near.y, 100), 500);
    const roleBefore = await api(baseUrl, "GET", `roles/${fighter.roleId}`, { token: fighter.token });
    const revisionBefore = roleBefore.data ? roleBefore.data.revision : -1;

    const aiHitFrame = await waitFor("monster-ai 命中帧", async () => {
      return fighter.session.ais.find((frame) => frame.hits && frame.hits.length > 0) || null;
    }, 8_000);
    check(!!aiHitFrame, "A：收到 monster-ai 命中帧（服务端按普攻间隔出招）", JSON.stringify(aiHitFrame));
    const hit = aiHitFrame && aiHitFrame.hits[0];
    check(!!hit && hit.damage > 0, "A：普攻伤害 > 0（怪物物攻区间 − 玩家物防区间）", JSON.stringify(hit));
    check(!!hit && hit.hp < 100 && hit.maxHp > 0, "A：受击后血量下降且带资源上限", JSON.stringify(hit));
    check(!!hit && typeof hit.accountId === "string" && hit.accountId.length > 0, "A：命中事件带受击账号（广播给全图观看者）");

    const roleAfter = await api(baseUrl, "GET", `roles/${fighter.roleId}`, { token: fighter.token });
    check(!!hit && roleAfter.code === 0 && roleAfter.data.data.hp === hit.hp, "A：受击已落进存档（data.hp = hit.hp）", JSON.stringify({ db: roleAfter.data && roleAfter.data.data && roleAfter.data.data.hp, hit: hit && hit.hp }));
    check(roleAfter.code === 0 && roleAfter.data.revision === revisionBefore, "A：受击不推进修订号（revision 原样，战斗期间存档不撞乐观锁）", JSON.stringify({ before: revisionBefore, after: roleAfter.data && roleAfter.data.revision }));

    // —— B. 普攻间隔：1.5s 内没有第二击，2.5s 内第二击到来 ——
    const countAfterFirst = hitCount();
    await sleep(1_500);
    check(hitCount() === countAfterFirst, "B：1.5s 内没有第二击（attackInterval = 2000ms 生效）", JSON.stringify({ countAfterFirst, now: hitCount() }));
    await sleep(1_200);
    check(hitCount() >= countAfterFirst + 1, "B：2.7s 内第二击到来（间隔后继续出招）", JSON.stringify({ countAfterFirst, now: hitCount() }));

    // —— C. 追击：玩家走出普攻距离但在检测范围内 → 服务端推着怪追 ——
    const far = { x: aiMob.x + 150, y: aiMob.y };
    reportPos(far.x, far.y, 100);
    posTimer && clearInterval(posTimer);
    posTimer = setInterval(() => reportPos(far.x, far.y, 100), 500);
    const countBeforeChase = hitCount();
    const chaseEntry = await waitFor("追击中的位置增量", async () => {
      return fighter.session.ais.flatMap((frame) => frame.monsters || []).find((entry) => entry.instanceId === aiMob.instanceId && entry.moving === true) || null;
    }, 3_000);
    check(!!chaseEntry, "C：收到移动中的位置增量（moving = true）", JSON.stringify(chaseEntry));
    check(!!chaseEntry && chaseEntry.x < aiMob.x + 150, "C：怪物朝玩家方向移动（x 向目标趋近）", JSON.stringify({ entryX: chaseEntry && chaseEntry.x, spawnX: aiMob.x }));

    // —— D. 丢失目标：走出检测范围 / 玩家死亡都不再被追击 ——
    reportPos(aiMob.x + 500, aiMob.y, 100);
    posTimer && clearInterval(posTimer);
    posTimer = setInterval(() => reportPos(aiMob.x + 500, aiMob.y, 100), 500);
    const countBeforeFar = hitCount();
    await sleep(1_500);
    check(hitCount() === countBeforeFar, "D：走出检测范围后不再被追击（detectRange = 200 生效）", JSON.stringify({ before: countBeforeFar, now: hitCount() }));

    reportPos(near.x, near.y, 0);
    posTimer && clearInterval(posTimer);
    posTimer = setInterval(() => reportPos(near.x, near.y, 0), 500);
    const countBeforeDead = hitCount();
    await sleep(1_500);
    check(hitCount() === countBeforeDead, "D：上报血量 0（死亡）后不再被选为目标", JSON.stringify({ before: countBeforeDead, now: hitCount() }));
    posTimer && clearInterval(posTimer);

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
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  }
})();
