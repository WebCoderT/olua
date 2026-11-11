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
 * - 掉落拾取（#325）：pick 帧按账本格子级入包（可叠加/装备占格）、背包满拒拾、
 *   重复拾取幂等、非归属者与未知账拒拾、清账后不可再拾
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:combat
 */
const { spawn } = require("node:child_process");
// 写角色接口的基线帮手（#820 / B62：revision 必填）
const { revOfWith } = require("./lib/role-save.cjs");
const fs = require("node:fs");
const net = require("node:net");
const os = require("os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（与 startServer 的 ADMIN_REGISTER_CODE 同值；击杀奖励 region 要用它改配置表） */
const ADMIN_CODE = "e2e-combat-admin";

//#region 出厂值的预期来源：配置快照

/**
 * `server/data/config-snapshot.sql`（= 库的逐行投影，空库启动时整份灌进去）
 *
 * #655 起库里是唯一权威，所以这一套里的「几只怪 / 多少血 / 多少经验」一律**算出来**，
 * 不写死：写死就等于把出厂的刷怪密度、等级经验搬成测试里的第二份副本，
 * 运营在后台调一次数值，这里就整片红 —— 而那并不是缺陷。
 */
const configSnapshot = require("./lib/config-snapshot.cjs");
const { paceCast } = require("./lib/cast-pace.cjs");

const SPAWN_AREAS = configSnapshot.rows("map_spawn_areas");
const MONSTER_ROWS = configSnapshot.rows("monsters");
const GROWTH_SCALARS = Object.fromEntries(configSnapshot.rows("growth_scalars").map((row) => [row.key, Number(row.value)]));

/** 某张图的播种量：每个刷怪区按 `max` 铺满（`WorldService` 的播种口径，不是随机数） */
const spawnCount = (mapId) =>
  SPAWN_AREAS.filter((area) => String(area.mapId) === String(mapId)).reduce((sum, area) => sum + Number(area.max), 0);

/** 怪物出厂行（按 key 取；maxHp / level 这些断言都以它为准） */
const monsterRowOf = (key) => MONSTER_ROWS.find((row) => String(row.id) === String(key));

/** 击杀经验（与 `CombatSettlementService.killExpFor` 同口径：同级 = (等级+1) × expPerLevel，等级差线性衰减） */
const killExpOf = (roleLevel, monsterLevel) => {
  const perLevel = GROWTH_SCALARS["expGain.expPerLevel"];
  const maxGap = GROWTH_SCALARS["expGain.maxLevelGap"];
  const gap = Math.abs(roleLevel - monsterLevel);
  if (gap >= maxGap) return 0;
  return Math.max(1, Math.round((monsterLevel + 1) * perLevel * (1 - gap / maxGap)));
};

//#endregion

//#region 断言小工具

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
 * 直读角色的击杀计数（#400）
 *
 * 这一列没有 HTTP 出口（它只喂排行榜），所以断言只能走库。`node:sqlite` 是
 * Node 内置的同步驱动，读一行就关 —— 与 `seedSpawnAreas` 同一套用法。
 */
function readKills(dbPath, roleId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT kills FROM roles WHERE id = ?").get(roleId);
  db.close();
  return row ? row.kills : null;
}

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
      // 位置过期压到 2s：互见 region（#324）的超时离场断言要等它；region 七的窗口都
      // 在持续喂 pos（500ms 间隔），不受影响
      MONSTER_AI_POS_STALE_MS: "2000",
      // 外观懒刷新压到 1s：互见 region（#383）的换装断言要等在场表重读存档，
      // 默认 5s 会让这条用例白等四秒（下限就是 1000，再小也压不动）
      PLAYER_APPEARANCE_REFRESH_MS: "1000",
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

/**
 * 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000）
 *
 * 本文件的 api() 是「baseUrl 打头」的形态，所以这里也带上 baseUrl。
 */
const revOf = (baseUrl, roleId, token) =>
  revOfWith((method, route, options) => api(baseUrl, method, route, options), roleId, token);

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
    /** 玩家互见广播帧（#324：互见增量 + 快照兜底 + 离开事件） */
    players: [],
    /** 拾取结果帧（#325：成功与拒绝都在内） */
    pickeds: [],
    /** error 帧（#325：格式不对的 pick 等低频错误） */
    errors: [],
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
      if (frame.type === "players") session.players.push(frame.data);
      if (frame.type === "picked") session.pickeds.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
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

    // #597 起建号由服务端给齐初始技能（1xxx 全 1 级）：想测「未学习」，
    // 先用管理端把技能清空，第二段再补回来走正常结算
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "斗战者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    // #859 起「没有位置记录」的角色只准进新手村，而这一套全程在图 1 / 图 2 上跑：
    // 先按运营摆位把主角放到图 1（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");

    // 管理端令牌：技能 / 装备 / 背包 从 #556 起是服务端权威，玩家侧存档已经改不动它们了
    // （客户端上报会被库里那份回填），所以测试要造这些状态只能走管理端结构化编辑。
    const adminToken = await registerAdmin(baseUrl, "combat_admin", "Combat#123");
    check(!!adminToken, "准备：管理员已登录（改配置表与造角色状态都要用它）");

    // 清空技能，让「未学习」这条用例恢复前提（#597 起初始号自带 1xxx 全 1 级）
    const cleared = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { skills: {} } });
    check(cleared.code === 0, "准备：管理端清空技能（未学习用例的前提）", cleared.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const wsUrl = `${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`;
    let session = connect(wsUrl);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    check(session.opened, "准备：实时连接已建立");

    /**
     * 发一次 cast：返回 { id, promise }（id 是本次的 castId，promise 等它自己的 settle 帧）
     *
     * 发送推迟一个出手间隔（`lib/cast-pace.cjs`）：服务端 #813 起按真客户端口径判冷却
     * （基础剑术 250ms 一刀），连发会被 `rejected: "cooldown"` 拒掉。形状保持同步返回
     * `{ id, promise }`，调用点不用改。
     */
    let castSeq = 0;
    const cast = (session_, body) => {
      castSeq += 1;
      const id = castSeq;
      const promise = (async () => {
        await paceCast();
        session_.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
        return session_.waitForSettle(id);
      })();
      return { id, promise };
    };

    /** 进图播种：地图 1 上的刷怪区按 `max` 铺满（maxHp / 物防都来自 `monsters` 表），拿回服务端发的实例 id */
    const mapOneTotal = spawnCount("1");
    const world = await session.joinWorld("1");
    check(world && world.monsters.length === mapOneTotal, `准备：worldJoin 播种后拿到 ${mapOneTotal} 只权威实例`, JSON.stringify(world));
    const mobA = world && world.monsters[0];
    const mobB = world && world.monsters.find((mob) => mob.instanceId !== (mobA && mobA.instanceId));
    const mobARow = mobA && monsterRowOf(mobA.monsterKey);
    check(!!mobA && /^m1_z1_\d+$/.test(mobA.instanceId), "准备：实例 id 由服务端发牌（m1_z1_N 形态，带区段）", mobA && mobA.instanceId);
    check(!!mobA && mobA.hp === mobARow.maxHp && mobA.maxHp === mobARow.maxHp && mobA.alive === true, "准备：实例以服务端表的满血起算", `hp=${mobA && mobA.hp} 表=${mobARow && mobARow.maxHp}`);

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
    // 技能已收权（#556）：玩家侧存档改不动 `skills`，学技能只能走管理端结构化编辑
    const saved = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { skills: { 1000: 1 } } });
    check(saved.code === 0, "准备：角色已学会技能 1000（管理端结构化编辑）", saved.message);

    // 怪物 1（赤焰斗鸡）：maxHp / 物防取 `monsters` 表；1 级角色物攻 [14,20]，技能 1 级倍率 1 → 伤害 ∈ [8, 16]
    const firstShot = cast(session, { skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" });
    const first = await firstShot.promise;
    check(!!(first && first.ok), "首次出手结算成功", JSON.stringify(first));
    const firstHp = first && first.ok ? first.hp : -1;
    check(first.ok && first.damage >= 8 && first.damage <= 16, "伤害落在公式区间 [8, 16] 内", `damage=${first.damage}`);
    check(first.ok && first.killed === false, "满血怪一击不死（killed = false）");
    check(first.ok && firstHp === mobARow.maxHp - first.damage, `血量算术自洽（hp = ${mobARow.maxHp} − damage）`, `hp=${firstHp}`);
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

    // #827：幂等账按时间过期，不再「只留 256 条、超出挤掉最旧」。先灌 300 条
    // 解析得通但技能不存在的出手（每个都会被记进幂等账），再重放第一发 —— 仍在 TTL 内，
    // 必须判重复；容量定 256 的实现会在这里把它挤掉，于是「打得够久就能重放」。
    const FLOOD = 300;
    for (let i = 0; i < FLOOD; i++) {
      session.socket.send(JSON.stringify({
        type: "cast",
        data: { castId: 900000 + i, skillId: "9999", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" },
      }));
    }
    await sleep(800);
    const settleCountAfterFlood = session.settles.length;
    session.socket.send(JSON.stringify({
      type: "cast",
      data: { castId: firstShot.id, skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" },
    }));
    const replayAfterFlood = await waitFor(`灌 ${FLOOD} 条后重放首发的 settle`, async () => {
      const hits = session.settles
        .slice(settleCountAfterFlood)
        .filter((frame) => frame.castId === firstShot.id);
      return hits.length > 0 ? hits[hits.length - 1] : null;
    });
    check(
      !!(replayAfterFlood && replayAfterFlood.duplicate === true),
      `灌 ${FLOOD} 条之后首发仍判重复（不再被容量挤掉，TTL 内一律拒）`,
      JSON.stringify(replayAfterFlood),
    );

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
    check(!!snapB && snapB.alive === true && snapB.hp === monsterRowOf(snapB.monsterKey).maxHp, "快照里活着的实例状态不受会话操作影响", JSON.stringify(snapB));

    // 换图 = 发新的 worldJoin：旧图观看者身份移除、幂等账清零，但旧图实例状态原样保留。
    // #606 起进图门槛在服务端判（1 级角色既进不了 1 图 10 级、也进不了 2 图 40 级），
    // 而这一区域要验的是「换图清账」——所以先用管理端把这名角色提到 10 级并承认它的位置
    // （`onMap` 一并写 `mapAt`），换图目标选新手村 0 图（1 级可进），往返两程都在门槛之内
    const promoted = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { level: 10, onMap: "1" } });
    check(promoted.code === 0, "换图前把角色提到 10 级并摆回 1 图（门槛之上才有得验换图）", promoted.message);
    const map2 = await session.joinWorld("0");
    check(!!(map2 && map2.monsters.length === spawnCount("0")), `换图 worldJoin 拿到新图的实例（${spawnCount("0")} 只）`, JSON.stringify(map2));
    const back = await session.joinWorld("1");
    const backA = back && back.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!backA && backA.alive === false && backA.hp === 0, "换图往返后旧图实例状态保持（世界状态不随会话清）");

    // #827：换图往返（图 1 → 图 0 → 图 1）后重投**图 1 上那一次**的 castId。
    // 账必须已经不在了：要么随 worldJoin 清掉，要么键里的 mapId 让它不匹配 ——
    // 总之不能把换图前那份「ok + 有伤害」原样发回来（那等于让玩家重放一整场战斗）。
    // 这里的怪早被打死，所以重新校验的正确结果就是 target_dead。
    const settleCountBeforeStale = session.settles.length;
    session.socket.send(JSON.stringify({
      type: "cast",
      data: { castId: firstShot.id, skillId: "1000", targetId: mobA ? mobA.instanceId : "m1_1", monsterKey: "1" },
    }));
    const staleReplay = await waitFor(`castId=${firstShot.id} 换图往返后的重投`, async () => {
      const hits = session.settles
        .slice(settleCountBeforeStale)
        .filter((frame) => frame.castId === firstShot.id);
      return hits.length > 0 ? hits[hits.length - 1] : null;
    });
    check(
      !!(staleReplay && staleReplay.duplicate !== true && staleReplay.code === "target_dead"),
      "换图往返后同 castId 不命中旧账（重新校验而不是回放换图前的结果）",
      JSON.stringify(staleReplay),
    );

    session.socket.close();
    await waitFor("旧连接断开", async () => (session.closed ? session : null));
    const ticket2 = await api(baseUrl, "POST", "realtime/ticket", { token });
    session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket2.data.ticket)}`);
    await waitFor("重连成功", async () => (session.opened ? session : null));
    // 重连后重新 join（播种计划为空 —— 实例已存在，不该翻倍），拿回权威状态
    const rejoined = await session.joinWorld("1");
    check(!!(rejoined && rejoined.monsters.length === mapOneTotal), `重连后重新 worldJoin 不重复播种（仍是 ${mapOneTotal} 只）`, JSON.stringify(rejoined && rejoined.monsters.length));
    const rejoinA = rejoined && rejoined.monsters.find((m) => m.instanceId === (mobA ? mobA.instanceId : "m1_1"));
    check(!!rejoinA && rejoinA.alive === false && rejoinA.hp === 0, "重连拿回的状态与断线前一致（断线不清世界状态）");
    // castSeq 继续往下走；重连后同一 castId 也没人记得它 —— 视为新出手（打活着的 mobB）
    const reconnected = await cast(session, { skillId: "1000", targetId: mobB ? mobB.instanceId : "m1_2", monsterKey: "1" }).promise;
    check(!!(reconnected && reconnected.ok && reconnected.duplicate === false), "重连后结算上下文已清（同 castId 不算重复）", JSON.stringify(reconnected));

    //#endregion

    //#region 六、击杀奖励（#316）：经验与掉落的结算在服务端

    group("六、击杀奖励：经验与掉落的结算在服务端（settle 帧 reward）");

    // 管理员令牌已在「准备」段落登录（技能 / 装备 / 背包自 #556 起是服务端权威，只有管理端能改）

    /** 再来一名玩家（独立账号 / 角色 / 实时连接）：#597 起初始技能由服务端给齐（1xxx 全 1 级），无需再补 */
    async function newPlayer(name, level = 1) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const playerToken = registered.data && registered.data.token;
      const createdRole = await api(baseUrl, "POST", "roles", { token: playerToken, body: { name, occupation: "1", sex: "1" } });
      // #859：新号没有位置记录只准进新手村 —— 建号后立刻摆到图 1（这一套的默认战场）
      placeRolesAt(dbPath, "1", [name]);
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: playerToken });
      const playerSession = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor(`${name} 握手成功`, async () => (playerSession.opened ? playerSession : null));
      return { token: playerToken, roleId: createdRole.data && createdRole.data.id, name, session: playerSession };
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

    /**
     * 进某张图：先把人摆过去再 join（#859）
     *
     * 进图闸只在「换图」时判等级 / 战力 / 战魂，而这一套验的是进图之后的东西 ——
     * 角色该站在哪张图上本来就该由准备段决定（等价管理端 PATCH onMap）。
     */
    const enterAt = async (player, mapId) => {
      placeRolesAt(dbPath, mapId, [player.name]);
      return player.session.joinWorld(mapId);
    };

    /** 等某张图上出现活着的怪（WORLD_RESPAWN_MS = 5s，前面的 region 杀过图 1 的怪） */
    async function aliveMonster(player, mapId) {
      return waitFor(`mapId=${mapId} 有活着的怪`, async () => {
        const snap = await enterAt(player, mapId);
        const alive = (snap && snap.monsters.find((m) => m.alive)) || null;
        // #817：掉落点在「怪倒下的地方」，拾取距离闸拿它当参照 —— 记住这只怪在哪，
        // `pick` 之前就把玩家摆到那儿（等价真实客户端「走过去捡」）
        if (alive) player.lastSpot = { mapId, x: alive.x, y: alive.y };
        return alive;
      }, 15_000);
    }

    // —— A. 正常经验：同级击杀 = (怪物等级 + 1) × expPerLevel，服务端落账（revision 推进）——

    const killerA = await newPlayer("combat_rwa");
    const mobA2 = await aliveMonster(killerA, "1");
    check(!!mobA2, "A：等到了活着的怪（前面的击杀已按 5s 重生）", JSON.stringify(mobA2));
    const expA = killExpOf(1, monsterRowOf(mobA2.monsterKey).level);
    const killedA = await killMonster(killerA, mobA2.monsterKey, mobA2.instanceId);
    check(!!(killedA && killedA.ok && killedA.reward), "A：击杀结算带 reward", JSON.stringify(killedA));
    check(!!(killedA && killedA.reward) && killedA.reward.exp === expA, `A：同级击杀经验 = (等级+1)×expPerLevel = ${expA}`, JSON.stringify(killedA && killedA.reward));
    check(!!(killedA && killedA.reward) && killedA.reward.leveledUp === false && killedA.reward.level === 1, `A：${expA} 经验不够升级（level 不变 / leveledUp=false）`, JSON.stringify(killedA && killedA.reward && { level: killedA.reward.level, leveledUp: killedA.reward.leveledUp }));
    check(Array.isArray(killedA && killedA.reward && killedA.reward.drops), "A：reward.drops 是数组（内容随掉落表，确定性断言在 C 组）");
    const roleA = await api(baseUrl, "GET", `roles/${killerA.roleId}`, { token: killerA.token });
    check(roleA.code === 0 && roleA.data.data.exp === expA, `A：服务端已把经验落进存档（data.exp = ${expA}）`, JSON.stringify(roleA.data && roleA.data.exp));
    check(roleA.code === 0 && roleA.data.revision === (killedA.reward ? killedA.reward.revision : -1), "A：reward.revision 与服务端当前修订号一致（客户端照搬不会撞乐观锁）");

    // —— A2. 击杀计数（#400）：独立于经验，一次一加 ——

    checkEqual(readKills(dbPath, killerA.roleId), 1, "A：击杀计数 +1（roles.kills = 1，#400 排行榜的原料）");
    const mobA3 = await aliveMonster(killerA, "1");
    check(!!mobA3, "A：等到第二只活着的怪（验击杀计数是累加而不是覆盖）", JSON.stringify(mobA3));
    const killedA2 = mobA3 ? await killMonster(killerA, mobA3.monsterKey, mobA3.instanceId) : null;
    check(!!(killedA2 && killedA2.killed), "A：第二只也打死了");
    checkEqual(readKills(dbPath, killerA.roleId), 2, "A：击杀计数累加到 2（不是被后一次覆盖成 1）");

    // —— B. 升级：等级曲线 exp 段管理端改值即时生效（#786 曲线参数化）——

    const curvesBefore = await api(baseUrl, "GET", "admin/level-curves", { token: adminToken });
    const expSegOne = curvesBefore.data && curvesBefore.data.list.find((row) => row.curve === "exp" && row.seq === 1);
    check(!!expSegOne, "B：读到经验曲线第 1 段（1 级起）", JSON.stringify(expSegOne));
    const expOfOne = await api(baseUrl, "GET", "admin/level-curves/preview?level=1", { token: adminToken });
    check(expOfOne.code === 0 && expOfOne.data.exp === expSegOne.startValue, "B：1 级经验 = 第 1 段起始值（计算器与段参数同源）", JSON.stringify({ preview: expOfOne.data && expOfOne.data.exp, seed: expSegOne.startValue }));
    const expPatched = await api(baseUrl, "PATCH", "admin/level-curves/exp/1", { token: adminToken, body: { startValue: 5 } });
    check(expPatched.code === 0, "B：把 1 级经验改成 5 成功");

    const killerB = await newPlayer("combat_rwb");
    const mobB2 = await aliveMonster(killerB, "2");
    check(!!mobB2, "B：地图 2 等到了活着的怪", JSON.stringify(mobB2));
    const killedB = await killMonster(killerB, mobB2.monsterKey, mobB2.instanceId);
    // 经验按快照里的怪物等级 + 成长标量算：等级差线性衰减，1 级经验上限刚被管理端改成 5 → 必然升级、剩 exp − 5
    const expB = killExpOf(1, monsterRowOf(mobB2.monsterKey).level);
    const expLeftB = expB - 5;
    check(!!(killedB && killedB.reward) && killedB.reward.exp === expB, `B：击杀 ${monsterRowOf(mobB2.monsterKey).level} 级怪经验 = ${expB}`, JSON.stringify(killedB && killedB.reward));
    check(!!(killedB && killedB.reward) && killedB.reward.leveledUp === true && killedB.reward.level === 2 && killedB.reward.expNow === expLeftB, `B：管理端改角色等级 1 行的经验即时生效（升到 2 级，本级剩 ${expLeftB}）`, JSON.stringify(killedB && killedB.reward));
    const roleB = await api(baseUrl, "GET", `roles/${killerB.roleId}`, { token: killerB.token });
    check(roleB.code === 0 && roleB.data.level === 2 && roleB.data.data.exp === expLeftB, `B：服务端已升级（level 列 = 2，data.exp = ${expLeftB}）`, JSON.stringify({ level: roleB.data && roleB.data.level, exp: roleB.data && roleB.data.data && roleB.data.data.exp }));
    // 还原：把 1 级经验改回 seed 值（本库独立，但保持「测试后还原 seed」的纪律）
    await api(baseUrl, "PATCH", "admin/level-curves/exp/1", { token: adminToken, body: { startValue: expSegOne.startValue } });

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
    // picks 2 × 每次必掉 2 个 → 合并后恰好 drug_hp_1 x4（权重/概率/数量全确定）；
    // 默认参数下不绑定（bindChance 0 + 物品/怪物都没开强制绑定，#789）
    check(
      !!(killedC && killedC.reward) && JSON.stringify(killedC.reward.drops) === JSON.stringify([{ goodId: "drug_hp_1", count: 4, bound: false }]),
      "C：掉落按改后的表结算（2 次抽取 × 每次 2 个，合并 = drug_hp_1 x4，默认不绑定）",
      JSON.stringify(killedC && killedC.reward && killedC.reward.drops),
    );
    check(!!(killedC && killedC.reward) && killedC.reward.exp === 10 && killedC.reward.leveledUp === false, "C：经验与掉落互不影响（经验曲线已还原，不再升级）");

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
    // 等级是服务端写点（#550 起存档改不动它），这里走运营侧的 PATCH 改到 10 级 ——
    // 顺带验一件事：level 是索引列，PATCH 之后详情里的等级必须是 10，修订号只推进一次
    const savedD = await api(baseUrl, "PATCH", `admin/roles/${killerD.roleId}`, { token: adminToken, body: { level: 10 } });
    check(savedD.code === 0, "D：角色已改到 10 级（管理端 PATCH）", savedD.message);
    const afterPatchD = await api(baseUrl, "GET", `roles/${killerD.roleId}`, { token: killerD.token });
    const revisionD = afterPatchD.data && afterPatchD.data.revision;
    check(
      afterPatchD.data.level === 10 && revisionD === revisionDBefore + 1,
      "D：等级落到索引列，修订号只推进一次",
      `level=${afterPatchD.data.level} revision=${revisionD}`,
    );
    const mobD = await aliveMonster(killerD, "1");
    check(!!mobD, "D：等到了活着的怪", JSON.stringify(mobD));
    const killedD2 = mobD ? await killMonster(killerD, mobD.monsterKey, mobD.instanceId) : null;
    check(!!(killedD2 && killedD2.reward) && killedD2.reward.exp === 0, "D：等级差 9 ≥ 6 → 无经验（exp = 0）", JSON.stringify(killedD2 && killedD2.reward));
    check(!!(killedD2 && killedD2.reward) && killedD2.reward.revision === revisionD, "D：无经验不入账（revision 不再推进）", JSON.stringify(killedD2 && killedD2.reward));
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

    //#region 八、玩家互见（#324）：同图玩家的位置 / 血量 / 移动标记互见（players 帧）

    group("八、玩家互见：位置 / 血量 / 移动标记由服务端转发（players 帧）");

    const companion = await newPlayer("combat_rpr");

    // fighter 恢复持续上报（region 七末尾已停；互见的在场表以 pos 帧为数据源）。
    // 先等一拍再让 companion 进图：region 七末尾上报过 hp = 0（死亡路径），
    // 快照要读到的是恢复后的 hp = 100
    const selfPos = { x: 100, y: 100 };
    let fighterPosTimer = setInterval(
      () => fighter.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x: selfPos.x, y: selfPos.y, hp: 100 } })),
      300,
    );
    await sleep(500);

    // —— A. 快照兜底：companion 进图立刻拿到一份同图全量 ——
    await enterAt(companion, "2");
    const fullFrame = await waitFor("companion 的互见快照", async () => {
      return companion.session.players.find((frame) => frame.full === true) || null;
    }, 5_000);
    check(!!fullFrame, "A：进图即收到互见快照（full = true，随 world 应答发出）", JSON.stringify(fullFrame));
    const fighterAccountId = fullFrame && fullFrame.players.length > 0 ? fullFrame.players[0].accountId : null;
    check(!!fighterAccountId, "A：快照里带着已在场的 fighter（只列同图观看者）", JSON.stringify(fullFrame));
    check(
      !!fullFrame && fullFrame.players[0].hp === 100 && fullFrame.players[0].maxHp > 0,
      "A：快照条目带血量与资源上限（maxHp 服务端重算，血条分母不用客户端猜）",
      JSON.stringify(fullFrame && fullFrame.players[0]),
    );
    check(!!fullFrame && fullFrame.players[0].username === "combat_raf", "A：快照条目带显示名（角色名，服务端首见时查好缓存）", JSON.stringify(fullFrame && fullFrame.players[0]));
    // #383：外观随互见帧下发 —— 「没穿」用空串（客户端据此回落性别默认身体）
    const snapshotAppearance = fullFrame && fullFrame.players[0] && fullFrame.players[0].appearance;
    check(
      !!snapshotAppearance && snapshotAppearance.sex === "1" && snapshotAppearance.cloth === "" && snapshotAppearance.weapon === "" && snapshotAppearance.fashion === "",
      "A：快照条目带外观（性别 + 空装备槽原样下发，别人能看到他长什么样）",
      JSON.stringify(snapshotAppearance),
    );

    // —— B. 增量出现：companion 上报位置后 fighter 收到它 ——
    const companionPos = { x: 200, y: 200, hp: 100, moving: false };
    const companionPosTimer = setInterval(
      () => companion.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x: companionPos.x, y: companionPos.y, hp: companionPos.hp, moving: companionPos.moving } })),
      300,
    );
    const appearFrame = await waitFor("fighter 收到 companion 出现", async () => {
      return fighter.session.players.find((frame) => frame.players.some((entry) => entry.accountId !== fighterAccountId)) || null;
    }, 5_000);
    check(!!appearFrame, "B：fighter 收到 companion 的出现帧（首次上报即作为变化广播）", JSON.stringify(appearFrame));
    const companionEntry = appearFrame && appearFrame.players.find((entry) => entry.accountId !== fighterAccountId);
    const companionAccountId = companionEntry ? companionEntry.accountId : null;

    // —— C. 超时离场与重现：消失与重现都是显式事件 ——
    clearInterval(fighterPosTimer);
    const timeoutLeft = await waitFor("companion 收到 fighter 超时离场", async () => {
      return companion.session.players.find((frame) => (frame.left || []).includes(fighterAccountId)) || null;
    }, 8_000);
    check(!!timeoutLeft, "C：fighter 停止上报后 companion 收到离开事件（超时视作离场）", JSON.stringify(timeoutLeft));
    fighterPosTimer = setInterval(
      () => fighter.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x: selfPos.x, y: selfPos.y, hp: 100 } })),
      300,
    );
    const reappear = await waitFor("companion 再次收到 fighter", async () => {
      return companion.session.players.find((frame) => frame.players.some((entry) => entry.accountId === fighterAccountId)) || null;
    }, 5_000);
    check(!!reappear, "C：fighter 恢复上报后再次出现（重新上报即作为变化广播）", JSON.stringify(reappear));

    // —— D. 移动增量：moving 标记与最新坐标 ——
    companionPos.x = 260;
    companionPos.moving = true;
    const moveFrame = await waitFor("fighter 收到 companion 的移动增量", async () => {
      return fighter.session.players.find((frame) => frame.players.some((entry) => entry.accountId === companionAccountId && entry.moving === true)) || null;
    }, 5_000);
    check(!!moveFrame, "D：移动中的上报带 moving 标记（走路的演出依据，客户端自报）", JSON.stringify(moveFrame));
    const moveEntry = moveFrame && moveFrame.players.find((entry) => entry.accountId === companionAccountId);
    check(!!moveEntry && moveEntry.x === 260, "D：增量坐标是服务端转发的最新上报值", JSON.stringify(moveEntry));

    // —— E. 血量变化：互见帧里的血量跟着上报走 ——
    companionPos.hp = 80;
    const hurtFrame = await waitFor("fighter 收到 companion 的血量变化", async () => {
      return fighter.session.players.find((frame) => frame.players.some((entry) => entry.accountId === companionAccountId && entry.hp === 80)) || null;
    }, 5_000);
    check(!!hurtFrame, "E：血量变化进入增量广播（互见的血条跟着走）", JSON.stringify(hurtFrame));

    // —— H. 换装（#383）：改存档后站在不动也要被别人看到（在场表按 refresh 间隔重读）——
    // 装备栏自 #556 起是服务端权威：玩家侧上报的 equipments 会被库里那份回填，
    // 换装只能走管理端结构化编辑（等价于运营改档）。
    // #836 起管理端 PATCH 也校验部位与存在性 —— 之前随手写的 3001/4001（库里没有）
    // 现在会 20003，改用真实装备 id（cloth_1 +60 maxHp，正好给下面的血条分母断言垫差值）
    const redressed = await api(baseUrl, "PATCH", `admin/roles/${companion.roleId}`, {
      token: adminToken,
      body: { equipments: { cloth: "cloth_1", weapon: "weapon_1" } },
    });
    check(redressed.code === 0, "H：换装已写进存档（服务端权威数据变了，实时进程没被告知）", redressed.message);
    const dressedFrame = await waitFor("fighter 收到 companion 的换装帧", async () => {
      return (
        fighter.session.players.find((frame) =>
          frame.players.some((entry) => entry.accountId === companionAccountId && entry.appearance && entry.appearance.cloth === "cloth_1"),
        ) || null
      );
    }, 8_000);
    const dressedEntry = dressedFrame && dressedFrame.players.find((entry) => entry.accountId === companionAccountId);
    check(
      !!dressedEntry && dressedEntry.appearance.cloth === "cloth_1" && dressedEntry.appearance.weapon === "weapon_1",
      "H：换装后收到外观变化帧（坐标 / 血量都没变也广播，不用等他动一下）",
      JSON.stringify(dressedEntry && dressedEntry.appearance),
    );

    // 血条分母跟着存档走：升到 10 级（裸模 100 → 262，再加 cloth_1 的 60 = 322），别人看到的
    // 分母要跟上 —— maxHp 只在首见时算过一次，不并进懒刷新就会被冻在那一刻（换装加体力也撞这条）。
    // 等级走管理端 PATCH（#550 起存档改不动等级），装备保持不动，只有 maxHp 会变
    // 等级走管理端 PATCH（#550 起存档改不动等级），装备保持不动，只有 maxHp 会变
    const maxHpBefore = dressedEntry ? dressedEntry.maxHp : 0;
    const leveled = await api(baseUrl, "PATCH", `admin/roles/${companion.roleId}`, { token: adminToken, body: { level: 10 } });
    check(leveled.code === 0, "H：等级已改（管理端 PATCH 到 10 级，体力上限随之变化）", leveled.message);
    const maxHpFrame = await waitFor("fighter 收到 companion 的血条分母变化", async () => {
      // 直接等新值出现：等「≠ 旧值」会被更早的入图快照帧（裸模 100）抢先满足
      return fighter.session.players.find((frame) => frame.players.some((entry) => entry.accountId === companionAccountId && entry.maxHp === 322)) || null;
    }, 8_000);
    const maxHpEntry = maxHpFrame && maxHpFrame.players.find((entry) => entry.accountId === companionAccountId);
    check(
      !!maxHpEntry && maxHpEntry.maxHp === 322,
      `H：血条分母跟着存档走（${maxHpBefore} → ${maxHpEntry && maxHpEntry.maxHp}，不会被冻在首见那一刻）`,
      JSON.stringify(maxHpEntry),
    );

    // —— F. 换图离开：旧图的同伴收到 left（客户端才拆得掉旧节点）——
    await enterAt(companion, "1");
    const switchLeft = await waitFor("fighter 收到 companion 换图离开", async () => {
      return fighter.session.players.find((frame) => (frame.left || []).includes(companionAccountId)) || null;
    }, 5_000);
    check(!!switchLeft, "F：companion 换图后旧图收到离开事件（不靠「不再出现」让人猜）", JSON.stringify(switchLeft));

    // —— G. 断线离开：立即广播，不等广播节拍 ——
    companion.session.socket.close();
    await waitFor("companion 连接已断开", async () => (companion.session.closed ? companion.session : null));
    const closeLeft = await waitFor("fighter 收到 companion 断线离开", async () => {
      return fighter.session.players.find((frame) => (frame.left || []).includes(companionAccountId)) || null;
    }, 5_000);
    check(!!closeLeft, "G：companion 断线后 fighter 立即收到离开事件", JSON.stringify(closeLeft));
    clearInterval(fighterPosTimer);
    clearInterval(companionPosTimer);

    //#endregion

    //#region 九、掉落拾取（#325）：归属与格子级入包（pick 帧）

    group("九、掉落拾取：归属与格子级入包的权威在服务端（pick / picked 帧）");

    // 掉落确定性：怪物 1 改成「必掉 drug_hp_1 x2」（picks 1 × chance 1 × count [2,2]）
    await api(baseUrl, "PATCH", "admin/monster-drops/1", {
      token: adminToken,
      body: { tableId: null, picks: 1, entries: [{ goodId: "drug_hp_1", weight: 100, chance: 1, count: [2, 2] }] },
    });

    /**
     * 站到某个点（发一帧 `pos`，#817 的拾取距离闸读的就是在场表里这份坐标）
     *
     * 发**两次**：位置仲裁（#596）把单帧瞬移当成作弊，`POS_TRUST_STREAK = 2` 才跟随基线 ——
     * 真实客户端 4Hz 连续上报，200ms 内自然满足，这里用两帧模拟同一件事。
     * `hp` 只影响「AI 要不要把这个人当目标」，取个大于 0 的数即可。
     */
    const standAtSpot = (player, spot) => {
      const frame = JSON.stringify({ type: "pos", data: { mapId: spot.mapId, x: spot.x, y: spot.y, hp: 100 } });
      player.session.socket.send(frame);
      player.session.socket.send(frame);
    };

    /**
     * 发一次拾取并等它自己的 picked 帧（只等发送之后到达的：同一 castId 的旧帧不回填）
     *
     * `options.spot` 缺省 = 站到 `player.lastSpot`（这只怪倒下的地方，正常玩家的行为）；
     * 显式给一个点 = 故意从别处捡（距离闸用例）；`null` = 一帧位置都不报（`no_position` 用例）。
     * pos 与 pick 走同一条连接、服务端按序处理，所以不会出现「位置还没到、拾取先判」。
     */
    const pick = (player, castId, index, options = {}) => {
      const spot = options.spot === null ? null : options.spot || player.lastSpot;
      if (spot) standAtSpot(player, spot);
      const before = player.session.pickeds.length;
      player.session.socket.send(JSON.stringify({ type: "pick", data: { castId, index } }));
      return waitFor(`castId=${castId} index=${index} 的 picked 帧`, async () => {
        const hits = player.session.pickeds.slice(before).filter((frame) => frame.castId === castId && frame.index === index);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, 5_000);
    };

    // —— A. 正常拾取：按账本原子入包，revision 推进，存档可查 ——

    const picker = await newPlayer("combat_rpk");
    // 服务端不扩容（与商城同一语义）：初始 bag 是空数组（没有网格），先把存档原样带回、
    // 只把 bag 换成规范化空网格（4×10），给「服务端不扩容」一个前提
    const pickerInitial = await api(baseUrl, "GET", `roles/${picker.roleId}`, { token: picker.token });
    const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
    const savedGrid = await api(baseUrl, "PUT", `roles/${picker.roleId}`, {
      token: picker.token,
      body: {
        revision: pickerInitial.data && pickerInitial.data.revision,
        data: { ...(pickerInitial.data.data || {}), bag: emptyGrid },
      },
    });
    check(savedGrid.code === 0, "A：背包已存成规范化空网格（4×10，服务端不扩容语义的前提）", savedGrid.message);
    const mobK = await aliveMonster(picker, "1");
    check(!!mobK, "A：等到了活着的怪", JSON.stringify(mobK));
    const killedK = mobK ? await killMonster(picker, mobK.monsterKey, mobK.instanceId) : null;
    check(
      !!(killedK && killedK.reward) && JSON.stringify(killedK.reward.drops) === JSON.stringify([{ goodId: "drug_hp_1", count: 2, bound: false }]),
      "A：击杀结算带确定的掉落（drug_hp_1 x2，拾取账本与 settle 帧同源）",
      JSON.stringify(killedK && killedK.reward && killedK.reward.drops),
    );
    const pickedFirst = killedK ? await pick(picker, killedK.castId, 0) : null;
    check(!!(pickedFirst && pickedFirst.ok && pickedFirst.alreadyPicked === false), "A：首次拾取成功（alreadyPicked = false）", JSON.stringify(pickedFirst));
    check(
      !!(pickedFirst && pickedFirst.ok) && JSON.stringify(pickedFirst.placed) === JSON.stringify([{ row: 0, col: 0, id: "drug_hp_1", count: 2 }]),
      "A：placed 是服务端实际写入的格子（空背包第 0 行第 0 格整份放入）",
      JSON.stringify(pickedFirst && pickedFirst.ok && pickedFirst.placed),
    );
    check(
      !!(pickedFirst && pickedFirst.ok) && killedK && killedK.reward && pickedFirst.revision === killedK.reward.revision + 1,
      "A：入包推进修订号（revision = 击杀入账后的 revision + 1）",
      JSON.stringify({ pick: pickedFirst && pickedFirst.ok && pickedFirst.revision, kill: killedK && killedK.reward && killedK.reward.revision }),
    );
    const roleAfterPick = await api(baseUrl, "GET", `roles/${picker.roleId}`, { token: picker.token });
    const firstCell = roleAfterPick.data && roleAfterPick.data.data && Array.isArray(roleAfterPick.data.data.bag) ? roleAfterPick.data.data.bag[0] && roleAfterPick.data.data.bag[0][0] : undefined;
    check(
      roleAfterPick.code === 0 && JSON.stringify(firstCell) === JSON.stringify({ id: "drug_hp_1", count: 2 }),
      "A：掉落已落进存档（data.bag[0][0] = drug_hp_1 x2）",
      JSON.stringify(firstCell),
    );

    // —— B. 重复拾取幂等：同一 castId/index 再拾，原样应答不重复入包 ——

    const pickedAgain = killedK ? await pick(picker, killedK.castId, 0) : null;
    check(!!(pickedAgain && pickedAgain.ok && pickedAgain.alreadyPicked === true), "B：重复拾取幂等应答（alreadyPicked = true）", JSON.stringify(pickedAgain));
    check(!!(pickedAgain && pickedAgain.ok) && Array.isArray(pickedAgain.placed) && pickedAgain.placed.length === 0, "B：幂等重放没有新的入包格子（placed 为空）");
    check(
      !!(pickedAgain && pickedAgain.ok) && pickedFirst && pickedFirst.ok && pickedAgain.revision === pickedFirst.revision,
      "B：幂等重放不再推进修订号",
      JSON.stringify({ again: pickedAgain && pickedAgain.ok && pickedAgain.revision, first: pickedFirst && pickedFirst.ok && pickedFirst.revision }),
    );

    // —— C. 非归属者拒拾：账本按账号隔离，别人的 castId 查不到账 ——

    const outsider = await newPlayer("combat_rpo");
    const stolenPick = killedK ? await pick(outsider, killedK.castId, 0) : null;
    check(!!(stolenPick && stolenPick.ok === false && stolenPick.code === "unknown_drop"), "C：非归属者拾取被拒（unknown_drop，归属天然成立）", JSON.stringify(stolenPick));

    // —— D. 未知账拒拾：不存在的 castId / 越界的下标 / 格式不对的消息 ——

    const unknownCast = killedK ? await pick(picker, killedK.castId + 99999, 0) : null;
    check(!!(unknownCast && unknownCast.ok === false && unknownCast.code === "unknown_drop"), "D：不存在的 castId 被拒（unknown_drop）", JSON.stringify(unknownCast));
    const unknownIndex = killedK ? await pick(picker, killedK.castId, 9) : null;
    check(!!(unknownIndex && unknownIndex.ok === false && unknownIndex.code === "unknown_drop"), "D：越界的下标被拒（unknown_drop）", JSON.stringify(unknownIndex));
    picker.session.socket.send(JSON.stringify({ type: "pick", data: {} }));
    const badPick = await waitFor("格式不对的 pick 回 error 帧", async () => {
      return picker.session.errors.find((frame) => typeof frame.message === "string" && frame.message.includes("pick")) || null;
    }, 5_000);
    check(!!badPick, "D：格式不对的 pick 回 error 帧且不断开连接", JSON.stringify(badPick));

    // —— E. 背包满拒拾：整份放不下 → 20012，存档与修订号都不动 ——

    // 4×10 全塞满 material_iron（可叠加物品堆满每一格：药再也吃不进已有堆，也找不到空格）
    // 背包内容自 #556 起是服务端权威：玩家侧上报的内容会被库里那份回填（只借客户端的网格尺寸），
    // 所以「塞满背包」这种造状态必须走管理端结构化编辑（稀疏格式，一行一格）
    const fullCells = [];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) fullCells.push({ row, col, id: "material_iron", count: 99 });
    const savedFull = await api(baseUrl, "PATCH", `admin/roles/${picker.roleId}`, { token: adminToken, body: { bag: fullCells } });
    check(savedFull.code === 0, "E：背包已存成全满（4×10 格 material_iron x99，管理端结构化编辑）", savedFull.message);

    const mobFull = await aliveMonster(picker, "1");
    check(!!mobFull, "E：等到了活着的怪（上一只已按 5s 重生）", JSON.stringify(mobFull));
    const killedFull = mobFull ? await killMonster(picker, mobFull.monsterKey, mobFull.instanceId) : null;
    check(!!(killedFull && killedFull.reward && killedFull.reward.drops.length === 1), "E：击杀结算带掉落（拾取要被拒的那份）", JSON.stringify(killedFull && killedFull.reward && killedFull.reward.drops));
    const pickedFull = killedFull ? await pick(picker, killedFull.castId, 0) : null;
    check(!!(pickedFull && pickedFull.ok === false && pickedFull.code === "bag_full"), "E：背包满被拒拾（bag_full）", JSON.stringify(pickedFull));

    const roleAfterFull = await api(baseUrl, "GET", `roles/${picker.roleId}`, { token: picker.token });
    const bagAfterFull = roleAfterFull.data && roleAfterFull.data.data && roleAfterFull.data.data.bag;
    const hasDrug = Array.isArray(bagAfterFull) && bagAfterFull.some((line) => line.some((cell) => cell && cell.id === "drug_hp_1"));
    check(!hasDrug, "E：拒拾后存档背包一个字节都没动（没有药混进来）", JSON.stringify(bagAfterFull && bagAfterFull[0]));
    check(
      roleAfterFull.code === 0 && killedFull && killedFull.reward && roleAfterFull.data.revision === killedFull.reward.revision,
      "E：修订号与击杀入账后一致（拒拾本身不写库）",
      JSON.stringify({ kill: killedFull && killedFull.reward && killedFull.reward.revision, after: roleAfterFull.data && roleAfterFull.data.revision }),
    );

    // —— F. 会话清账：targetsReset 之后掉落账本随幂等账一起清 ——

    picker.session.socket.send(JSON.stringify({ type: "targetsReset" }));
    await sleep(100);
    const pickedAfterReset = killedFull ? await pick(picker, killedFull.castId, 0) : null;
    check(!!(pickedAfterReset && pickedAfterReset.ok === false && pickedAfterReset.code === "unknown_drop"), "F：targetsReset 后账本已清（换图旧掉落不再可拾）", JSON.stringify(pickedAfterReset));

    // —— G. 换图即清账：不发 targetsReset，只 worldJoin 也必须清（#817）——

    // F 靠的是客户端主动发 `targetsReset` —— 那是**客户端消息**，改包不发就还能隔图吸掉落。
    // 判据必须由服务端在放行 worldJoin 时自己给出：换图那一刻账本就没了。
    // 图 2 有进图门槛，先把等级提上去（picker 此时已经站在图 1，换图要走门槛判定）
    await api(baseUrl, "PATCH", `admin/roles/${picker.roleId}`, { token: adminToken, body: { level: 60 } });
    const mobG = await aliveMonster(picker, "1");
    const killedG = mobG ? await killMonster(picker, mobG.monsterKey, mobG.instanceId) : null;
    check(!!killedG, "G：在图 1 打出一份掉落（先不拾）", JSON.stringify(killedG && killedG.castId));
    await enterAt(picker, "2");
    const crossPick = killedG ? await pick(picker, killedG.castId, 0) : null;
    check(
      !!crossPick && crossPick.ok === false && crossPick.code === "unknown_drop",
      "G：换到图 2 后拾图 1 的掉落 → 拒（unknown_drop，服务端自己清的账）",
      JSON.stringify(crossPick),
    );
    await enterAt(picker, "1");
    const backPick = killedG ? await pick(picker, killedG.castId, 0) : null;
    check(
      !!backPick && backPick.ok === false && backPick.code === "unknown_drop",
      "G：换回图 1 也拾不到（账本在换图那一刻就清了，不会因为回去而复活）",
      JSON.stringify(backPick),
    );

    // —— H. 距离闸（#817）：隔远拒拾、走回来可拾、已拾的幂等放行、0 = 关闭校验 ——

    // 掉落点 = 怪倒下的地方（账本逐条记，区域技能一次三只也各记各的）。闸判三件事：
    // 有没有位置、是不是同一张图、离掉落点多远；半径是运营可配的 `drop.pickAcceptRadius`。
    const farPicker = await newGridPlayer("combat_rpf");
    const mobH = await aliveMonster(farPicker, "1");
    check(!!mobH, "H：等到了活着的怪", JSON.stringify(mobH));
    const killedH = mobH ? await killMonster(farPicker, mobH.monsterKey, mobH.instanceId) : null;
    check(
      !!(killedH && killedH.reward && killedH.reward.drops.length === 1),
      "H：击杀结算带一份掉落（拾取距离闸的靶子）",
      JSON.stringify(killedH && killedH.reward && killedH.reward.drops),
    );
    const farSpot = { mapId: "1", x: (mobH ? mobH.x : 0) + 800, y: mobH ? mobH.y : 0 };
    const pickedFar = killedH ? await pick(farPicker, killedH.castId, 0, { spot: farSpot }) : null;
    check(
      !!(pickedFar && pickedFar.ok === false && pickedFar.code === "too_far"),
      "H：站在 800px 外拾取被拒（too_far，不是静默失败也不是把东西发过来）",
      JSON.stringify(pickedFar),
    );
    const pickedNear = killedH ? await pick(farPicker, killedH.castId, 0) : null;
    check(
      !!(pickedNear && pickedNear.ok && pickedNear.alreadyPicked === false),
      "H：走回掉落点再拾就成功（前面的拒拾没把账本条目吃掉）",
      JSON.stringify(pickedNear),
    );
    const repickFromFar = killedH ? await pick(farPicker, killedH.castId, 0, { spot: farSpot }) : null;
    check(
      !!(repickFromFar && repickFromFar.ok && repickFromFar.alreadyPicked === true),
      "H：已拾的幂等重放不受距离限制（应答丢包后的重发不能被判成作弊）",
      JSON.stringify(repickFromFar),
    );

    // 没报过位置：拒绝而不是放行（放行等于给「不上报位置」开一个绕过闸的开关）
    const noPosPlayer = await newGridPlayer("combat_rpn");
    const mobN = await aliveMonster(noPosPlayer, "1");
    const killedN = mobN ? await killMonster(noPosPlayer, mobN.monsterKey, mobN.instanceId) : null;
    const pickedNoPos = killedN ? await pick(noPosPlayer, killedN.castId, 0, { spot: null }) : null;
    check(
      !!(pickedNoPos && pickedNoPos.ok === false && pickedNoPos.code === "no_position"),
      "H：一帧位置都没报过 → 拒拾（no_position，位置未知不等于站在旁边）",
      JSON.stringify(pickedNoPos),
    );

    // 0 = 关闭校验（排查问题用的开关）：改完立刻生效（结算现读库，不等客户端重进）
    // 出厂值从快照读（`runtime_params.drop_params`，JSON 列已由快照解析器解开）
    const acceptBefore = configSnapshot.rows("runtime_params")[0].dropParams.pickAcceptRadius;
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { drop: { pickAcceptRadius: 0 } } });
    const mobH2 = await aliveMonster(farPicker, "1");
    const killedH2 = mobH2 ? await killMonster(farPicker, mobH2.monsterKey, mobH2.instanceId) : null;
    const pickedOff = killedH2
      ? await pick(farPicker, killedH2.castId, 0, { spot: { mapId: "1", x: mobH2.x + 800, y: mobH2.y } })
      : null;
    check(
      !!(pickedOff && pickedOff.ok && pickedOff.alreadyPicked === false),
      "H：pickAcceptRadius = 0 时闸关闭（同一个人 800px 外也能拾，开关真的有作用）",
      JSON.stringify(pickedOff),
    );
    const restoredP = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken,
      body: { drop: { pickAcceptRadius: acceptBefore } },
    });
    checkEqual(restoredP.data && restoredP.data.drop && restoredP.data.drop.pickAcceptRadius, acceptBefore, "H：拾取半径已还原成出厂值");

    // 还原怪物 1 的掉落配置（seed 是内联条目池）
    await api(baseUrl, "PATCH", "admin/monster-drops/1", {
      token: adminToken,
      body: { tableId: null, picks: dropRowOne.picks, entries: dropRowOne.entries },
    });

    //#endregion

    //#region 十一、绑定与溯源（#789 / #816）：掉落时判定绑定，入包后可见，背包操作与穿脱都只换地方

    group("十一、绑定与溯源：三条规则判绑定、装备记来源、背包操作与穿脱把元数据认领回来");

    /** 动手前每只怪的掉落配置（还原用；键 = monsterKey） */
    const dropRowsBefore = new Map();
    const dropListBefore = await api(baseUrl, "GET", "admin/monster-drops?page=1&size=100", { token: adminToken });
    ((dropListBefore.data && dropListBefore.data.list) || []).forEach((row) => dropRowsBefore.set(row.monsterKey, row));

    /**
     * 把**这只怪**的掉落改成「必掉一份指定物品」（picks 1 × chance 1 → 结果确定）
     *
     * 按实际要打的怪物 key 改，而不是写死 "1"：地图 1 上不只一只怪，`aliveMonster`
     * 挑到哪只取决于重生时序（前面几个 region 各杀过一批），写死 key 会改成一张没人吃的表。
     *
     * `bindDrops` **每次显式写**（缺省 false）：`monster_drops.bind_drops` 是行上的持久开关，
     * 上一刀给某只怪开过「整体强制绑定」后，若这一刀又挑到同一只怪（图 1 只有两只，
     * 重生时序一变就会重复），不显式关掉就会把「随机概率 0% → 不绑定」这条判成绑定。
     * 这不是服务端行为，是测试自己留下的脏状态（#813 加出手间隔后暴露出来的）。
     */
    const patchDropOf = (monsterKey, goodId, extra = {}, count = [2, 2]) =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        body: { tableId: null, picks: 1, entries: [{ goodId, weight: 100, chance: 1, count }], bindDrops: false, ...extra },
      });

    /** 改过的怪物掉落（区域末尾统一还原成 seed 行） */
    const touchedDropKeys = new Set();
    /** 打一只怪（先把它的掉落改成指定物品），返回击杀结算 */
    const killWith = async (player, goodId, extra = {}, count = [2, 2]) => {
      const mob = await aliveMonster(player, "1");
      if (!mob) return null;
      touchedDropKeys.add(mob.monsterKey);
      await patchDropOf(mob.monsterKey, goodId, extra, count);
      const killed = await killMonster(player, mob.monsterKey, mob.instanceId);
      return killed && killed.reward ? { killed, drops: killed.reward.drops, mob } : null;
    };

    /** 新玩家 + 规范化空网格（服务端不扩容：先存一副 4×10 的空背包才有地方放掉落） */
    async function newGridPlayer(name) {
      const player = await newPlayer(name);
      const initial = await api(baseUrl, "GET", `roles/${player.roleId}`, { token: player.token });
      const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
      await api(baseUrl, "PUT", `roles/${player.roleId}`, {
        token: player.token,
        body: { revision: initial.data && initial.data.revision, data: { ...(initial.data.data || {}), bag: emptyGrid } },
      });
      return player;
    }

    // —— A. 三条规则：默认不绑 / 物品侧强制 / 怪物侧强制 / 随机概率 ——

    const binder = await newGridPlayer("combat_rbn1");
    const plainDrop = await killWith(binder, "drug_hp_1");
    check(
      !!plainDrop && plainDrop.drops.length === 1 && plainDrop.drops[0].bound === false,
      "A：三个开关都关着 → 不绑定（bound = false）",
      JSON.stringify(plainDrop && plainDrop.drops),
    );

    // 物品侧：把这件药品自己标成「掉落强制绑定」
    const drugBindOn = await api(baseUrl, "PATCH", "admin/drugs/drug_hp_1", { token: adminToken, body: { bindOnDrop: true } });
    check(
      drugBindOn.code === 0 && drugBindOn.data.bindOnDrop === true,
      "A：药品标成「掉落强制绑定」（管理端 PATCH 生效）",
      JSON.stringify(drugBindOn.data && drugBindOn.data.bindOnDrop),
    );
    const itemBound = await killWith(binder, "drug_hp_1");
    check(
      !!itemBound && itemBound.drops[0].bound === true,
      "A：物品侧强制绑定生效（这只是药品自己的标记，怪物没开）",
      JSON.stringify(itemBound && itemBound.drops),
    );
    await api(baseUrl, "PATCH", "admin/drugs/drug_hp_1", { token: adminToken, body: { bindOnDrop: false } });

    // 怪物侧：这只怪掉什么都绑
    const monsterBound = await killWith(binder, "drug_hp_1", { bindDrops: true });
    check(
      !!monsterBound && monsterBound.drops[0].bound === true,
      "A：怪物侧「掉落整体强制绑定」生效（物品侧已还原成不强制）",
      JSON.stringify(monsterBound && monsterBound.drops),
    );

    // 随机概率：两个强制都不为真时按参数掷一次；100% 必绑、0% 必不绑
    const paramsBefore = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken });
    const chanceBefore = paramsBefore.data && paramsBefore.data.drop && paramsBefore.data.drop.bindChance;
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { drop: { bindChance: 100 } } });
    const randomBound = await killWith(binder, "drug_hp_1");
    check(
      !!randomBound && randomBound.drops[0].bound === true,
      "A：随机绑定概率 100% → 必绑（第三道规则）",
      JSON.stringify(randomBound && randomBound.drops),
    );
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { drop: { bindChance: 0 } } });
    const randomOff = await killWith(binder, "drug_hp_1");
    check(
      !!randomOff && randomOff.drops[0].bound === false,
      "A：概率改回 0 → 又回到不绑定（参数即时生效）",
      JSON.stringify(randomOff && randomOff.drops),
    );

    // —— B. 装备溯源：谁掉的 / 哪个怪 / 什么时候；非装备不带溯源 ——

    const equipDrop = await killWith(binder, "weapon_1", {}, [1, 1]);
    check(!!equipDrop && equipDrop.drops.length >= 1, "B：装备掉落已抽取", JSON.stringify(equipDrop && equipDrop.drops));
    const pickedEquip = equipDrop ? await pick(binder, equipDrop.killed.castId, 0) : null;
    const equipCell = pickedEquip && pickedEquip.ok ? pickedEquip.placed[0] : null;
    check(
      !!equipCell && equipCell.from && equipCell.from.role === "combat_rbn1",
      "B：装备入包带「谁掉的」（from.role = 击杀者角色名）",
      JSON.stringify(equipCell && equipCell.from),
    );
    check(
      !!equipCell && equipCell.from && equipCell.from.monster === (equipDrop && equipDrop.mob.monsterKey),
      "B：带「哪个怪掉的」（from.monster = 怪物 key，客户端翻中文名）",
      JSON.stringify({ from: equipCell && equipCell.from, mob: equipDrop && equipDrop.mob.monsterKey }),
    );
    check(
      !!equipCell && equipCell.from && typeof equipCell.from.at === "number" && equipCell.from.at > 0,
      "B：带「什么时候掉的」（from.at = 毫秒时间戳）",
      JSON.stringify(equipCell && equipCell.from && equipCell.from.at),
    );
    check(!!equipCell && equipCell.bound === undefined, "B：这件装备没被强制绑定 → 格子上不写 bound（不占存档体积）");

    // 非装备（药品）不记溯源：用户口径「只有装备会溯源，其他物品只按是否绑定分成两个」
    const drugDrop = await killWith(binder, "drug_hp_1");
    const pickedDrug = drugDrop ? await pick(binder, drugDrop.killed.castId, 0) : null;
    const drugCell = pickedDrug && pickedDrug.ok ? pickedDrug.placed[0] : null;
    check(!!drugCell && drugCell.id === "drug_hp_1", "B：药品掉落入包", JSON.stringify(drugCell));
    check(!!drugCell && drugCell.from === undefined, "B：药品不带溯源（只有装备记来源）", JSON.stringify(drugCell && drugCell.from));

    // —— C. 入包后存档里看得见；背包操作只报格子，元数据由服务端认领回来 ——

    const roleAfterEquip = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const bagAfterEquip = roleAfterEquip.data && roleAfterEquip.data.data && roleAfterEquip.data.data.bag;
    const storedEquip = Array.isArray(bagAfterEquip)
      ? bagAfterEquip.reduce((hit, line) => hit || (line || []).find((cell) => cell && cell.id === "weapon_1") || null, null)
      : null;
    check(
      !!storedEquip && !!storedEquip.from && storedEquip.from.role === "combat_rbn1",
      "C：溯源已落进存档（GET roles 的 data.bag 里那格带 from）",
      JSON.stringify(storedEquip),
    );

    // 绑一堆药 + 再掉一堆同种未绑定的药，然后做一次「把绑定堆搬到空格」的整理：
    // 客户端只报 {row,col,id,count}（契约里没有 bound），服务端必须把绑定态认领回来
    const boundDrug = await killWith(binder, "drug_hp_1", { bindDrops: true });
    const pickedBound = boundDrug ? await pick(binder, boundDrug.killed.castId, 0) : null;
    const boundCell = pickedBound && pickedBound.ok ? pickedBound.placed[0] : null;
    check(!!boundCell && boundCell.bound === true, "C：绑定的那一堆入包（bound = true）", JSON.stringify(boundCell));
    const looseDrug = await killWith(binder, "drug_hp_1");
    const pickedLoose = looseDrug ? await pick(binder, looseDrug.killed.castId, 0) : null;
    check(!!pickedLoose && pickedLoose.ok, "C：再来一堆同种但未绑定的药", JSON.stringify(pickedLoose && pickedLoose.ok && pickedLoose.placed));

    const roleBeforeMove = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const gridBeforeMove = roleBeforeMove.data.data.bag;
    /** 稀疏格子（客户端口径：只有 row / col / id / count，从不带 bound） */
    const sparse = (grid) => {
      const cells = [];
      grid.forEach((line, row) => (line || []).forEach((cell, col) => cell && cells.push({ row, col, id: cell.id, count: cell.count })));
      return cells;
    };
    const beforeCells = sparse(gridBeforeMove);

    // 合法整理：把绑定的那一堆挪到一个空格（位置变了、内容没变）
    const drugCells = [];
    gridBeforeMove.forEach((line, row) =>
      (line || []).forEach((cell, col) => {
        if (cell && cell.id === "drug_hp_1") drugCells.push({ row, col, id: cell.id, count: cell.count, bound: cell.bound === true });
      }),
    );
    check(drugCells.length === 2, "C：背包里有两堆同种药（绑定一堆 / 未绑定一堆，没有并成一堆）", JSON.stringify(drugCells));
    const boundOne = drugCells.find((cell) => cell.bound);
    const looseOne = drugCells.find((cell) => !cell.bound);
    check(!!boundOne && !!looseOne, "C：两堆里恰好一堆绑、一堆没绑（同 id 不同桶）", JSON.stringify(drugCells));

    // 空格：整理只是换位置，不需要扩大容量
    let emptyPos = null;
    gridBeforeMove.forEach((line, row) =>
      (line || []).forEach((cell, col) => {
        if (!cell && !emptyPos) emptyPos = { row, col };
      }),
    );
    check(!!emptyPos, "C：4×10 网格里还有空格（搬运的目标位置）", JSON.stringify(emptyPos));

    const movedCells = beforeCells
      .filter((cell) => !(cell.row === boundOne.row && cell.col === boundOne.col))
      .concat(boundOne && emptyPos ? [{ row: emptyPos.row, col: emptyPos.col, id: "drug_hp_1", count: boundOne.count }] : []);
    const movedResult = await api(baseUrl, "POST", `roles/${binder.roleId}/bag-op`, {
      token: binder.token,
      body: { action: "move", cells: movedCells, revision: roleBeforeMove.data.revision },
    });
    check(movedResult.code === 0, "C：只报格子的整理被接受（服务端只验守恒）", movedResult.message);
    const boundKept = movedResult.code === 0 && emptyPos ? movedResult.data.data.bag[emptyPos.row][emptyPos.col] : null;
    check(
      !!boundKept && boundKept.bound === true && boundKept.count === (boundOne && boundOne.count),
      "C：绑定态被服务端认领回来（客户端没报 bound 也不会被洗成可交易）",
      JSON.stringify(boundKept),
    );

    // 作弊：把两堆（绑定 + 未绑定）报成一格（件数相加）—— 按「绑定态 + id」分组不守恒，必须拒
    const roleAfterMove = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const afterMoveCells = sparse(roleAfterMove.data.data.bag);
    const cheatCells = afterMoveCells
      .filter((cell) => cell.id !== "drug_hp_1")
      .concat([{ row: boundOne.row, col: boundOne.col, id: "drug_hp_1", count: boundOne.count + looseOne.count }]);
    const cheatResult = await api(baseUrl, "POST", `roles/${binder.roleId}/bag-op`, {
      token: binder.token,
      body: { action: "tidy", cells: cheatCells, revision: roleAfterMove.data.revision },
    });
    check(
      cheatResult.code === 20022,
      "C：交叉合并被拒（20022：按绑定态分组后内容不守恒）",
      JSON.stringify({ code: cheatResult.code, message: cheatResult.message }),
    );
    const roleAfterCheat = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const cheatBags = sparse(roleAfterCheat.data.data.bag);
    check(
      !cheatBags.some((cell) => cell.id === "drug_hp_1" && cell.count === boundOne.count + looseOne.count),
      "C：交叉合并没有落地（存档里不存在「两堆合成一堆」的药）",
      JSON.stringify(cheatBags),
    );

    // —— D. 扣一部分不能把绑定洗白（#816）：只改 count，元数据原样保留 ——

    // 用药：`emptyPos` 上那堆是绑定的 —— 用掉一瓶后 bound 必须还在，
    // 否则 5 瓶绑定药用到剩 1 瓶就变成可交易的了
    await api(baseUrl, "PATCH", `admin/roles/${binder.roleId}`, { token: adminToken, body: { hp: 1 } });
    const usedBound = await api(baseUrl, "POST", `roles/${binder.roleId}/drug-use`, {
      token: binder.token,
      body: { row: emptyPos.row, col: emptyPos.col, revision: await revOf(baseUrl, binder.roleId, binder.token) },
    });
    const usedCell = usedBound.code === 0 ? usedBound.data.data.bag[emptyPos.row][emptyPos.col] : null;
    check(
      !!usedCell && usedCell.bound === true && usedCell.count === boundKept.count - 1,
      "D：绑定药用掉一瓶：数量减一、bound 仍是 true（#816 的核心断言）",
      JSON.stringify({ usedCell, code: usedBound.code, message: usedBound.message }),
    );

    // 出售走的是另一条扣法（takeGoodsFromBag，按 id 点数扣）—— 造一堆绑定材料卖掉一半
    const boundMat = await killWith(binder, "material_hide", { bindDrops: true }, [4, 4]);
    const pickedMat = boundMat ? await pick(binder, boundMat.killed.castId, 0) : null;
    const matCell = pickedMat && pickedMat.ok ? pickedMat.placed[0] : null;
    check(!!matCell && matCell.bound === true, "D：绑定的材料入包（bound = true）", JSON.stringify(matCell));
    const soldHalf = await api(baseUrl, "POST", `roles/${binder.roleId}/sell`, {
      token: binder.token,
      body: { entries: [{ goodId: "material_hide", count: 2 }], revision: await revOf(baseUrl, binder.roleId, binder.token) },
    });
    const matAfter =
      soldHalf.code === 0 ? (soldHalf.data.data.bag.flat().find((cell) => cell && cell.id === "material_hide") || null) : null;
    check(
      !!matAfter && !!matCell && matAfter.bound === true && matAfter.count === matCell.count - 2,
      "D：卖一半：数量减二、bound 仍在（扣减路径同样不重建格子）",
      JSON.stringify({ matAfter, matCell, code: soldHalf.code, message: soldHalf.message }),
    );

    // —— D2. 管理端 PATCH 背包不再整体按未绑定重写（#836）：件数没改的格子把绑定认领回来 ——

    const roleBeforeAdminBag = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const gridBeforeAdminBag = roleBeforeAdminBag.data.data.bag;
    let adminBoundPos = null;
    let adminEmptyPos = null;
    gridBeforeAdminBag.forEach((line, row) =>
      (line || []).forEach((cell, col) => {
        if (cell && cell.id === "material_hide" && cell.bound === true && !adminBoundPos) adminBoundPos = { row, col };
        if (!cell && !adminEmptyPos) adminEmptyPos = { row, col };
      }),
    );
    check(
      !!adminBoundPos && !!adminEmptyPos,
      "D2：绑定材料与空格都在（管理端改包的前置）",
      JSON.stringify({ adminBoundPos, adminEmptyPos }),
    );
    // 运营把那格绑定材料挪到空格：件数一件没改，bound 必须跟着走
    const adminBagCells = sparse(gridBeforeAdminBag).map((cell) =>
      adminBoundPos && cell.row === adminBoundPos.row && cell.col === adminBoundPos.col
        ? { row: adminEmptyPos.row, col: adminEmptyPos.col, id: cell.id, count: cell.count }
        : cell,
    );
    const adminBagPatched = await api(baseUrl, "PATCH", `admin/roles/${binder.roleId}`, {
      token: adminToken,
      body: { bag: adminBagCells },
    });
    check(adminBagPatched.code === 0, "D2：管理端 PATCH bag 挪动绑定材料成功", adminBagPatched.message);
    const adminMovedCell =
      adminBagPatched.code === 0 && adminEmptyPos ? adminBagPatched.data.data.bag[adminEmptyPos.row][adminEmptyPos.col] : null;
    check(
      !!adminMovedCell && adminMovedCell.bound === true,
      "D2：管理端 PATCH 后绑定仍在（#836 之前整体按未绑定重写 = 运营一改包全员绑定件洗白）",
      JSON.stringify(adminMovedCell),
    );

    // —— E. 装备槽存对象（#816 后半）：绑定与溯源跟着这件东西走，穿脱只是换地方 ——

    // 打一件**强制绑定**的武器（B 段那件 weapon_1 是未绑定的，正好留着一个同 id 的对照）
    const boundEquipDrop = await killWith(binder, "weapon_1", { bindDrops: true }, [1, 1]);
    const pickedBoundEquip = boundEquipDrop ? await pick(binder, boundEquipDrop.killed.castId, 0) : null;
    const boundEquipCell = pickedBoundEquip && pickedBoundEquip.ok ? pickedBoundEquip.placed[0] : null;
    check(
      !!boundEquipCell && boundEquipCell.id === "weapon_1" && boundEquipCell.bound === true && !!boundEquipCell.from,
      "E：绑定武器入包（bound = true 且带溯源，作为穿脱前的基准）",
      JSON.stringify(boundEquipCell),
    );

    /** 在网格里找「那件绑定武器」的坐标（同 id 有两件，只认带 bound 的那件） */
    const findBoundWeapon = (grid) => {
      let hit = null;
      grid.forEach((line, row) =>
        (line || []).forEach((cell, col) => {
          if (!hit && cell && cell.id === "weapon_1" && cell.bound === true) hit = { row, col };
        }),
      );
      return hit;
    };
    const beforeEquipRole = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const boundEquipPos = findBoundWeapon(beforeEquipRole.data.data.bag);
    check(!!boundEquipPos, "E：背包里能定位到那件绑定武器", JSON.stringify(boundEquipPos));

    // 穿上：槽位值必须是**对象**（`{ id, bound, from }`），不是裸 id
    const wornResult = await api(baseUrl, "POST", `roles/${binder.roleId}/bag-op`, {
      token: binder.token,
      body: {
        action: "equip",
        row: boundEquipPos ? boundEquipPos.row : 0,
        col: boundEquipPos ? boundEquipPos.col : 0,
        revision: beforeEquipRole.data.revision,
      },
    });
    check(wornResult.code === 0, "E：穿上那件绑定武器", wornResult.message);
    const wornSlot = wornResult.code === 0 ? wornResult.data.data.equipments.weapon : null;
    check(
      !!wornSlot && typeof wornSlot === "object" && wornSlot.id === "weapon_1",
      "E：槽位值是对象 { id }（不是裸 id 字符串）",
      JSON.stringify(wornSlot),
    );
    check(!!wornSlot && wornSlot.bound === true, "E：绑定跟着进了槽位（穿上去不洗白）", JSON.stringify(wornSlot));
    check(
      !!wornSlot && !!wornSlot.from && wornSlot.from.monster === (boundEquipDrop && boundEquipDrop.mob.monsterKey),
      "E：溯源也进了槽位（from.monster 仍是那只怪）",
      JSON.stringify({ slot: wornSlot, mob: boundEquipDrop && boundEquipDrop.mob.monsterKey }),
    );

    // 存档里也是对象（响应是 DTO 投影，这里确认落库形状一致 —— 客户端/管理端都读存档）
    const storedWornRole = await api(baseUrl, "GET", `roles/${binder.roleId}`, { token: binder.token });
    const storedWornSlot = storedWornRole.data.data.equipments && storedWornRole.data.data.equipments.weapon;
    check(
      !!storedWornSlot && typeof storedWornSlot === "object" && storedWornSlot.id === "weapon_1" && storedWornSlot.bound === true,
      "E：存档里的 equipments.weapon 是对象且 bound 为 true",
      JSON.stringify(storedWornSlot),
    );

    // 脱下：格子里的 bound / from 必须原样回来（穿一次就洗白 = 绑定语义整体失效）
    const offResult = await api(baseUrl, "POST", `roles/${binder.roleId}/bag-op`, {
      token: binder.token,
      body: { action: "unequip", slot: "weapon", revision: storedWornRole.data.revision },
    });
    check(offResult.code === 0, "E：脱下武器（落点由服务端找第一个空格）", offResult.message);
    // 背包里这时有两件 weapon_1（B 段那件未绑定的 + 刚脱下来的绑定件），只认带 bound 的那件
    const offCells =
      offResult.code === 0 ? offResult.data.data.bag.flat().filter((cell) => cell && cell.id === "weapon_1") : [];
    const offCell = offCells.find((cell) => cell.bound === true) || null;
    check(
      offCells.length === 2 && offCells.filter((cell) => cell.bound === true).length === 1,
      "E：脱下来之后背包里是两件 weapon_1（未绑定的对照件 + 绑定件），绑定态没有扩散到另一件",
      JSON.stringify(offCells),
    );
    check(
      !!offCell && offCell.count === 1 && offCell.bound === true,
      "E：脱下来回到背包：绑定仍在（穿脱只换地方，不改值）",
      JSON.stringify(offCell),
    );
    check(
      !!offCell && !!offCell.from && offCell.from.monster === (boundEquipDrop && boundEquipDrop.mob.monsterKey),
      "E：脱下来回到背包：溯源仍在",
      JSON.stringify(offCell && offCell.from),
    );
    check(
      !!(offResult.code === 0 && offResult.data.data.equipments.weapon === null),
      "E：槽位清空（对象形式下也是 null，不是空串）",
      JSON.stringify(offResult.code === 0 ? offResult.data.data.equipments.weapon : undefined),
    );

    // 还原：这一区改过的每只怪的掉落配置 + 随机绑定概率，都回到改之前那一份
    for (const key of touchedDropKeys) {
      const before = dropRowsBefore.get(key);
      if (!before) continue;
      // 三态各按自己的形状还原（引用具名表的不带 entries，清空的两样都不带）
      const restore =
        before.source === "table"
          ? { tableId: before.tableId, picks: before.picks === null ? undefined : before.picks, bindDrops: before.bindDrops === true }
          : {
              tableId: null,
              entries: before.source === "entries" ? before.entries : null,
              picks: before.source === "entries" && before.picks !== null ? before.picks : undefined,
              bindDrops: before.bindDrops === true,
            };
      await api(baseUrl, "PATCH", `admin/monster-drops/${key}`, { token: adminToken, body: restore });
    }
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { drop: { bindChance: chanceBefore } } });

    //#endregion

    //#region 十、怪物技能（#372）：挂载表驱动服务端释放，客户端只收 casts 演

    group("十、怪物技能：挂载表驱动服务端 AI 释放（casts 帧）");

    const casterA = await newPlayer("combat_rsc");
    const castMob = await aliveMonster(casterA, "2");
    check(!!castMob, "十：地图 2 有活着的怪（技能释放的宿主）", JSON.stringify(castMob));

    // 原挂载与原攻击区间：region 末尾要还原（不污染 seed 前提与后续断言）
    const mountBefore = await api(baseUrl, "GET", `admin/monsters/${castMob.monsterKey}/skills`, { token: adminToken });
    const monsterQuery = await api(baseUrl, "GET", `admin/monsters?keyword=${encodeURIComponent(castMob.monsterKey)}`, { token: adminToken });
    const monsterRow = monsterQuery.data && monsterQuery.data.list.find((row) => row.id === castMob.monsterKey);
    check(!!monsterRow, "十：读到这只怪的基础数据（要固定攻击区间）", JSON.stringify(monsterQuery.data && monsterQuery.data.list.slice(0, 1)));

    // 攻击区间固定成 50~50：普攻伤害 ≤ 50，狂怒 ×1.5 之后必然 > 50 —— 倍率有没有生效一眼可辨
    const fixedAttack = await api(baseUrl, "PATCH", `admin/monsters/${castMob.monsterKey}`, {
      token: adminToken,
      body: { attributes: { ...monsterRow.attributes, physicalAttack: { min: 50, max: 50 } } },
    });
    check(fixedAttack.code === 0, "十：物攻区间固定成 50~50（让倍率可辨）", fixedAttack.message);

    // —— A. 只挂状态型（狂怒）：服务端释放 → casts 带 statusId → 攻击倍率生效 ——

    const mountStateful = await api(baseUrl, "PUT", `admin/monsters/${castMob.monsterKey}/skills`, {
      token: adminToken,
      body: { skills: [{ skillId: "9002", priority: 1 }] },
    });
    check(
      mountStateful.code === 0 && mountStateful.data.total === 1,
      "十：挂载整份替换成 1 条（只放狂怒）",
      JSON.stringify(mountStateful.data),
    );

    const castNear = { x: castMob.x + 10, y: castMob.y };
    const reportCastPos = (hp) =>
      casterA.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x: castNear.x, y: castNear.y, hp } }));
    const provokeCast = await cast(casterA.session, { skillId: "1000", targetId: castMob.instanceId, monsterKey: castMob.monsterKey }).promise;
    check(!!(provokeCast && provokeCast.ok), "十：出手激怒这只怪（进入战斗才会放技能）", JSON.stringify(provokeCast));
    reportCastPos(100);
    const castPosTimer = setInterval(() => reportCastPos(100), 500);

    const castFrame = await waitFor(
      "casts 帧",
      async () => casterA.session.ais.find((frame) => (frame.casts || []).some((entry) => entry.instanceId === castMob.instanceId)) || null,
      10_000,
    );
    check(!!castFrame, "十：收到 casts 帧（放不放、放哪个由服务端决定）", JSON.stringify(castFrame));
    const stateCast = castFrame && (castFrame.casts || []).find((entry) => entry.instanceId === castMob.instanceId);
    check(!!(stateCast && stateCast.skillId === "9002"), "十：先放状态型技能（狂怒 9002）", JSON.stringify(stateCast));
    check(!!(stateCast && stateCast.statusId === "9001"), "十：casts 带挂载的状态 id（客户端据此播状态特效）", JSON.stringify(stateCast));
    check(!!stateCast && stateCast.damage === undefined, "十：casts 不带伤害（数值权威在 hits 帧）", JSON.stringify(stateCast));

    const buffedHit = await waitFor(
      "狂怒生效后的普攻",
      async () =>
        casterA.session.ais.flatMap((frame) => frame.hits || []).find((hit) => hit.instanceId === castMob.instanceId && hit.damage > 50) ||
        null,
      10_000,
    );
    check(!!buffedHit, "十：狂怒 ×1.5 服务端生效（物攻固定 50，伤害 > 50 只可能乘过倍率）", JSON.stringify(buffedHit));

    // —— B. 同一只怪换成伤害型（跃鼠猛击）：casts 与 hits 同帧，且带倍率伤害 ——

    castPosTimer && clearInterval(castPosTimer);
    const mountDamaging = await api(baseUrl, "PUT", `admin/monsters/${castMob.monsterKey}/skills`, {
      token: adminToken,
      body: { skills: [{ skillId: "9001", priority: 1 }] },
    });
    check(mountDamaging.code === 0 && mountDamaging.data.total === 1, "十：挂载换成 1 条（只放跃鼠猛击）", JSON.stringify(mountDamaging.data));

    // 这名「沙包」得撑过观察窗口：宿主怪身上还带着阶段 A 的狂怒（物攻 ×1.5），攻击又已被固定成 50，
    // 一发伤害型技能 ≈ 50×1.8×1.5 − 物防 ≈ 130，而 1 级角色只有 100 血 —— 打中就躺；
    // 躺下之后 `applyMonsterHit` 直接返回 null（不再报命中），这一段的 hits 断言就永远等不到。
    // 所以先把 1 级血量抬高（本库独立，段尾还原）。
    const hpCurvesBefore = await api(baseUrl, "GET", "admin/level-curves", { token: adminToken });
    const hpSegOne = hpCurvesBefore.data && hpCurvesBefore.data.list.find((row) => row.curve === "hp" && row.seq === 1);
    const levelOneHp = hpSegOne && hpSegOne.startValue;
    const hpBoosted = await api(baseUrl, "PATCH", "admin/level-curves/hp/1", { token: adminToken, body: { startValue: 5000 } });
    check(hpBoosted.code === 0, "十：把 1 级血量临时抬高（让沙包活到技能命中）", hpBoosted.message);

    const casterB = await newPlayer("combat_rsk");
    // 这名沙包必须真的拿到抬高后的血量：拿不到就是「管理端改了、建号还在用老值」，
    // 那么后面等 hits 只会等来一个「打中就躺」的假红 —— 把口径显式摆出来
    const sandbag = await api(baseUrl, "GET", `roles/${casterB.roleId}`, { token: casterB.token });
    const sandbagHp = Number(sandbag.data && sandbag.data.data && sandbag.data.data.maxHp) || 0;
    check(sandbagHp >= 1000, "十：沙包按抬高后的血量建号（血量口径已生效）", `maxHp=${sandbagHp}`);
    // 必须先 joinWorld：monster-ai 帧按「谁在看这张图」派发，没进图的连接收不到广播
    const worldB = await enterAt(casterB, "2");
    const mobNow = worldB && worldB.monsters.find((entry) => entry.instanceId === castMob.instanceId);
    check(!!(mobNow && mobNow.alive), "十：这只怪还活着（阶段 A 只被打过一记，没被打死）", JSON.stringify(mobNow));
    // 用当前坐标（阶段 A 里它追过玩家，早就离开出生点了）
    const castNearB = { x: mobNow ? mobNow.x + 10 : castNear.x, y: mobNow ? mobNow.y : castNear.y };
    const provokeB = await cast(casterB.session, { skillId: "1000", targetId: castMob.instanceId, monsterKey: castMob.monsterKey }).promise;
    check(!!(provokeB && provokeB.ok), "十：换一名玩家激怒同一只怪（验证挂载改动即时生效）", JSON.stringify(provokeB));
    const reportBPos = (hp) => casterB.session.socket.send(JSON.stringify({ type: "pos", data: { mapId: "2", x: castNearB.x, y: castNearB.y, hp } }));
    reportBPos(sandbagHp);
    const castPosTimerB = setInterval(() => reportBPos(sandbagHp), 500);

    const damagingFrame = await waitFor(
      "伤害型 casts 帧",
      async () =>
        casterB.session.ais.find(
          (frame) => (frame.casts || []).some((entry) => entry.instanceId === castMob.instanceId && entry.skillId === "9001"),
        ) || null,
      12_000,
    );
    check(!!damagingFrame, "十：改成伤害型后服务端改放 9001（挂载改动 1 秒内生效）", JSON.stringify(damagingFrame));
    const damagingCast = damagingFrame && (damagingFrame.casts || []).find((entry) => entry.skillId === "9001");
    check(!!damagingCast && damagingCast.statusId === undefined, "十：伤害型 casts 不带 statusId", JSON.stringify(damagingCast));

    // 「同帧」这条断言不能钉在**第一帧**上：上一阶段的沙包 A 停了上报之后，服务端的目标校验
    // 还要等位置过期（posStaleMs = 2s）才会丢掉它 —— 这中间怪物完全可能对着 A **放这一发**，
    // 而 `applyMonsterHit` 对 hp ≤ 0 的角色直接返回 null（不给尸体报命中），那一帧就是
    // 「只有 casts、没有 hits」。钉死第一帧会随机红（CI 实测踩过：hits 是空数组）。
    // 所以要等「同一帧里既有 9001 的 casts、又有这只怪的 hits」的那一帧：
    // 服务端把两件事件攒在同一个 tick 里一起广播，等不到才是真回归。
    const damagingPair = await waitFor(
      "伤害型 casts 与 hits 同帧",
      async () =>
        casterB.session.ais.find(
          (frame) =>
            (frame.casts || []).some((entry) => entry.instanceId === castMob.instanceId && entry.skillId === "9001") &&
            (frame.hits || []).some((hit) => hit.instanceId === castMob.instanceId),
        ) || null,
      15_000,
    );
    castPosTimerB && clearInterval(castPosTimerB);
    const damagingHit = damagingPair && (damagingPair.hits || []).find((hit) => hit.instanceId === castMob.instanceId);
    check(
      !!damagingHit,
      "十：伤害型技能同帧走 hits 下发（动作归 casts，数值归 hits）",
      JSON.stringify(damagingPair && damagingPair.hits),
    );
    check(
      !!damagingHit && damagingHit.damage >= 60,
      "十：技能伤害带倍率（物攻 50 × 1.8 扣物防后仍 > 60）",
      JSON.stringify(damagingHit),
    );

    // —— C. 还原：挂载回到原样（seed 的 3 条），攻击区间回到原值 ——

    const restoreMount =
      mountBefore.data && mountBefore.data.list.length > 0
        ? await api(baseUrl, "PUT", `admin/monsters/${castMob.monsterKey}/skills`, {
            token: adminToken,
            body: {
              skills: mountBefore.data.list.map((item) => ({
                skillId: item.skillId,
                priority: item.priority,
                ...(typeof item.cooldown === "number" ? { cooldown: item.cooldown } : {}),
              })),
            },
          })
        : await api(baseUrl, "PUT", `admin/monsters/${castMob.monsterKey}/skills`, { token: adminToken, body: { skills: [] } });
    check(restoreMount.code === 0, "十：还原这只怪的技能挂载", restoreMount.message);
    const restoreAttack = await api(baseUrl, "PATCH", `admin/monsters/${castMob.monsterKey}`, {
      token: adminToken,
      body: { attributes: monsterRow.attributes },
    });
    check(restoreAttack.code === 0, "十：还原攻击区间（seed 前提复原）", restoreAttack.message);
    const hpRestored = await api(baseUrl, "PATCH", "admin/level-curves/hp/1", { token: adminToken, body: { startValue: levelOneHp } });
    check(hpRestored.code === 0, "十：还原 1 级血量", hpRestored.message);

    //#endregion

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
