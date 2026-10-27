#!/usr/bin/env node
/**
 * 成就专项 e2e（server/test/e2e-achievement.cjs，issue #401）
 *
 * 盯的不变量（改成就条件 / 事件采集点 / 领取路径 / 配置守卫后必须全绿）：
 * 一、快照下发：achievements 进 game-config 快照，seed 行齐全、行形状同管理端
 * 二、累计型（kill）：击杀事件由结算 `emit` 一次，任务与成就**共用同一采集点** ——
 *     连杀 3 只 → 两个击杀型成就各自 +3（`"*"` 任意怪 与 指定怪物 key 都对）
 * 三、累计型（quest）：交付一个任务 → `quest:claimed` → 任务型成就 +1
 * 四、状态型（level / collect）：**不落进度**，查询按当前状态现算 ——
 *     改库把等级提到门槛就达成；背包里塞够物品就达成（不需要任何事件）
 * 五、领取：金币 / 经验 / 物品一次落库；重复领 50133、未达成 50132、不存在 50131
 * 六、背包满：20012 **且不消耗领取资格** —— 清一格后还能再领
 * 七、管理端配置：列表 / 编辑 / 新建 / 目标键不存在 40000 / 有玩家记录时拒删
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:achievement
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（配置守卫用它） */
const ADMIN_CODE = "e2e-achievement-admin";

//#region 断言小工具（与 e2e-quest 同款口径）

const EXPECTED_ASSERTIONS = 39;

let passed = 0;
let failed = 0;
const failures = [];

function assertExpectedCount() {
  if (failed !== 0) return;
  if (passed === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passed}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（make audit 会比对）");
  process.exit(1);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 预先往临时库里插刷怪区（播种来源 = map_spawn_areas；地图 1 一区怪物 1，max 2） */
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
  db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("1", "1号怪物", "1", 0, 2, 200, 300, 400, 400, Date.now());
  db.close();
}

/** 起一台服务（文件库 + 快重生：连杀几只不用等 30 秒） */
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
      JWT_SECRET: "e2e-achievement-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_RESPAWN_MS: "1500",
      MONSTER_AI_POS_STALE_MS: "60000",
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

const waitFor = async (label, predicate, timeoutMs = 10_000) => {
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

/** 空背包（4×10 格） */
function emptyBag() {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
}

/** 一份最小可建号的角色文档（e2e-quest 同款；带技能 1000 供击杀用） */
function roleData(id, name) {
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag: emptyBag(), skills: { 1000: 1 } };
}

/** 一条会话化的 WS 连接：只需要 cast → settle（成就没有自己的帧） */
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
  socket.on("close", () => {});
  socket.on("error", () => {});
  return session;
}

/** 直接开库断言 role_achievements（没有 HTTP 出口的列只能直读） */
function recordOf(dbPath, roleId, achievementId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT progress, achieved_at, claimed_at FROM role_achievements WHERE role_id = ? AND achievement_id = ?")
    .get(roleId, achievementId);
  db.close();
  return row || null;
}

/** 直接开库改角色等级（状态型成就的门槛是「现在是什么样」，走库最直接） */
function setRoleLevel(dbPath, roleId, level) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE roles SET level = ? WHERE id = ?").run(level, roleId);
  db.close();
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-achievement-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 准备：玩家 + 实时连接 + 管理员

    group("准备：玩家、实时连接与管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "ach_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const roleDoc = roleData("ach_r1", "成就者");
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleDoc } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    const world = await session.joinWorld("1");
    check(!!(world && world.monsters.some((m) => m.alive)), "准备：进图拿到活着的怪物 1");

    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "ach_admin", password: "pass1234", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { username: "ach_admin", password: "pass1234" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录（配置守卫用它）");

    //#endregion

    //#region 一、快照下发

    group("一、快照下发（客户端配置覆写的来源）");
    const snapshot = await api(baseUrl, "GET", "game-config", { token });
    const snapAch = (snapshot.data && snapshot.data.achievements) || [];
    check(
      snapshot.code === 0 && snapAch.length === 8 && snapAch.some((row) => row.id === "ach_kill_10") && snapAch.some((row) => row.id === "ach_level_10"),
      "快照带 achievements 全量（8 条，含累计型与状态型）",
      JSON.stringify(snapAch.length),
    );
    const snapKill = snapAch.find((row) => row.id === "ach_kill_10");
    checkEqual(snapKill && snapKill.condition && snapKill.condition.type, "kill", "快照成就行形状同管理端（condition 已展开）");
    checkEqual(snapKill && snapKill.condition && snapKill.condition.target, "*", "任意怪的条件目标是 *（不是某个怪物 key）");

    //#endregion

    let castSeq = 0;
    const cast = (body) => {
      castSeq += 1;
      const id = castSeq;
      session.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
      return { id, promise: session.waitForSettle(id) };
    };
    /** 连杀一只（自带重试：刷怪区只有 2 槽、重生 1.5s，只取一次快照会空手返回） */
    const killOne = async (attempts = 30) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snap = await session.joinWorld("1");
        const mob = snap && snap.monsters.find((m) => m.alive);
        if (mob) {
          for (let i = 0; i < 80; i++) {
            const result = await cast({ skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey }).promise;
            if (!result || !result.ok) break;
            if (result.killed) return result;
          }
        }
        await sleep(200);
      }
      return null;
    };
    const myAchievement = async (achievementId) => {
      const mine = await api(baseUrl, "GET", "achievements/me", { token });
      const list = (mine.data && mine.data.achievements) || [];
      return list.find((row) => row.id === achievementId) || null;
    };

    //#region 二、累计型（kill）：任务与成就共用同一个采集点

    group("二、累计型（kill）：击杀事件由结算 emit 一次，两个成就各自记账");
    for (let i = 0; i < 3; i++) await killOne();
    const killRecord = recordOf(dbPath, roleId, "ach_kill_10");
    checkEqual(killRecord && killRecord.progress, 3, "连杀 3 只 → 任意怪成就 progress = 3（事件记账）");
    const chickenRecord = recordOf(dbPath, roleId, "ach_kill_chicken");
    checkEqual(chickenRecord && chickenRecord.progress, 3, "同一次击杀也记到「指定怪物」成就上（target 匹配）");
    const killView = await myAchievement("ach_kill_10");
    checkEqual(killView && killView.progress, 3, "接口读到的进度与库里一致（3/10）");
    checkEqual(killView && killView.achieved, false, "没到门槛时未达成");
    const untouched = recordOf(dbPath, roleId, "ach_quest_5");
    check(untouched === null, "别的条件类型不会凭空产生记录（quest 型还没被触发）");

    //#endregion

    //#region 三、累计型（quest）：交付任务 → quest:claimed

    group("三、累计型（quest）：交付一个任务 → 任务型成就 +1");
    await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: "0002" } });
    const submitted = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8001" } });
    checkEqual(submitted && submitted.code, 0, "任务交付成功（前置条件：talk 任务已 ready）");
    const questRecord = recordOf(dbPath, roleId, "ach_quest_5");
    checkEqual(questRecord && questRecord.progress, 1, "交付 1 个任务 → 任务型成就 +1");
    const questView = await myAchievement("ach_quest_5");
    checkEqual(questView && questView.progress, 1, "任务型进度也出现在接口里（1/5）");

    //#endregion

    //#region 四、状态型：不落进度，查询现算

    group("四、状态型（level / collect）：不落进度，按当前状态现算");
    const levelBefore = await myAchievement("ach_level_10");
    checkEqual(levelBefore && levelBefore.achieved, false, "1 级时「十级入门」未达成");
    const levelRecordBefore = recordOf(dbPath, roleId, "ach_level_10");
    check(levelRecordBefore === null, "状态型成就**不写进度行**（哪怕没达成也一条记录都没有）");
    setRoleLevel(dbPath, roleId, 10);
    const levelAfter = await myAchievement("ach_level_10");
    checkEqual(levelAfter && levelAfter.achieved, true, "把等级提到 10 → 立刻达成（不需要任何事件或同步）");

    //#endregion

    //#region 五、领取：金币 / 经验一次落库；三种拒绝

    group("五、领取：发奖一次落库，重复领 / 未达成 / 不存在各自报错");
    // 门槛是 10：把剩下 7 只打完（成就只有在跨过门槛那一刻才翻成「可领」）
    for (let i = 0; i < 7; i++) await killOne();
    const reachedView = await myAchievement("ach_kill_10");
    checkEqual(reachedView && reachedView.achieved, true, "累计到 10 只 → 成就翻成已达成（事件驱动）");
    const claimed = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_kill_10" } });
    checkEqual(claimed && claimed.code, 0, "达成后可以领奖");
    checkEqual(claimed && claimed.data && claimed.data.gold, 500, "金币奖励到账（500）");
    checkEqual(claimed && claimed.data && claimed.data.exp, 100, "经验奖励到账（100）");
    const again = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_kill_10" } });
    checkEqual(again && again.code, 50133, "重复领取被拒（50133）");
    const notYet = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_combat_10000" } });
    checkEqual(notYet && notYet.code, 50132, "未达成的成就不能领（50132）");
    const missing = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_nope" } });
    checkEqual(missing && missing.code, 50131, "不存在的成就报 50131");
    const killAfterClaim = recordOf(dbPath, roleId, "ach_kill_10");
    check(killAfterClaim && killAfterClaim.claimed_at !== null, "领取时刻已落库（claimed_at 非空）");

    //#endregion

    //#region 六、背包满：整份奖励转邮件（#429）

    group("六、背包满：整份奖励转邮件，成就照常记已领（#429）");
    // 背包格子格式是 { id, count }（与 RolesService.placeGoodsIntoBag 同一口径）
    const fullBag = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => ({ id: "material_hide", count: 99 })));
    const stuffed = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: { ...roleDoc, level: 10, bag: fullBag } } });
    checkEqual(stuffed && stuffed.code, 0, "准备：背包塞满（40 格兽皮）");
    const bagFull = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_level_10" } });
    checkEqual(bagFull && bagFull.code, 0, "背包满时成就也能领（不再堵在 20012）");
    check(!!(bagFull && bagFull.data && bagFull.data.mailId), "返回 mailId：整份奖励转进了邮箱");
    const claimedRow = recordOf(dbPath, roleId, "ach_level_10");
    check(claimedRow && claimedRow.claimed_at !== null, "成就照常记已领（状态型成就第一次领奖就把行建出来）");
    const againAfterFull = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_level_10" } });
    checkEqual(againAfterFull && againAfterFull.code, 50133, "再领一次被拒（50133）—— 状态型成就不能反复刷奖励");
    const mailBox = await api(baseUrl, "GET", "mails/me", { token });
    const rewardMail = (mailBox.data.mails || []).find((row) => row.id === (bagFull.data && bagFull.data.mailId));
    check(
      !!rewardMail && rewardMail.kind === "achievement" && rewardMail.gold === 1000 && rewardMail.attachments.length === 1,
      "邮件内容是那份成就奖励（kind = achievement / 金币 1000 / 1 条物品）",
      JSON.stringify(rewardMail),
    );
    const oneFree = emptyBag();
    oneFree[0][0] = { id: "material_hide", count: 99 };
    await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: { ...roleDoc, level: 10, bag: oneFree } } });
    const claimedAfter = await api(baseUrl, "POST", `mails/${rewardMail && rewardMail.id}/claim`, { token });
    checkEqual(claimedAfter && claimedAfter.code, 0, "清出一格后从邮箱领到手上");
    checkEqual(claimedAfter && claimedAfter.data && claimedAfter.data.items && claimedAfter.data.items.length, 1, "物品奖励到账（1 条）");

    //#endregion

    //#region 七、管理端配置

    group("七、管理端配置：列表 / 编辑 / 新建 / 目标键校验 / 删除守卫");
    const list = await api(baseUrl, "GET", "admin/achievements?page=1&size=50", { token: adminToken });
    checkEqual(list && list.data && list.data.list.length, 8, "管理端列表 seed 了 8 条成就");
    const updated = await api(baseUrl, "PATCH", "admin/achievements/ach_collect_hide", {
      token: adminToken,
      body: { label: "皮料大亨" },
    });
    checkEqual(updated && updated.data && updated.data.label, "皮料大亨", "编辑名称（部分更新）生效");
    const badTarget = await api(baseUrl, "POST", "admin/achievements", {
      token: adminToken,
      body: { id: "ach_bad", category: "battle", label: "坏目标", condition: { type: "kill", target: "999999", count: 1 } },
    });
    checkEqual(badTarget && badTarget.code, 40000, "击杀目标不是已配置怪物 → 40000");
    const fresh = await api(baseUrl, "POST", "admin/achievements", {
      token: adminToken,
      body: { id: "ach_fresh", category: "explore", label: "新成就", condition: { type: "level", target: "", count: 5 } },
    });
    checkEqual(fresh && fresh.data && fresh.data.id, "ach_fresh", "新建成就成功");
    const removeFresh = await api(baseUrl, "DELETE", "admin/achievements/ach_fresh", { token: adminToken });
    checkEqual(removeFresh && removeFresh.code, 0, "没有玩家记录时可以删");
    const removeUsed = await api(baseUrl, "DELETE", "admin/achievements/ach_kill_10", { token: adminToken });
    checkEqual(removeUsed && removeUsed.code, 40000, "有玩家成就记录时拒删（40000）");

    //#endregion
  } finally {
    if (serverChild) serverChild.kill();
  }

  console.log(`\n${failed === 0 ? "✔" : "✗"} ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  assertExpectedCount();
  process.exit(0);
})();
