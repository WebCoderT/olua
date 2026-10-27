#!/usr/bin/env node
/**
 * 任务专项 e2e（server/test/e2e-quest.cjs，issue #396）
 *
 * 盯的不变量（改任务状态机 / 结算入口 / 配置守卫后必须全绿）：
 * 一、快照下发：quests 进 game-config 快照（客户端配置覆写的来源），seed 行齐全
 * 二、接取门控：主线链前置 / 重复接取 / 等级不够都被服务端拒（客户端的判断只是提前灰按钮）
 * 三、talk 进度：npc-talk 推进 accepted 行（到量转 ready + quest 帧），submit 领奖后
 *     main 保留 claimed 行作链门控；可接未接的任务在 npc-talk 响应里是 available
 * 四、kill 进度：击杀结算递进（唯一发生在 realtime 侧的进度变化），逐格 +1、到量 ready、
 *     quest 帧只推本人；奖励（金币 / 经验 / 物品）一次落库
 * 五、collect：交付时查背包（不足 20017 整单拒绝、行保持原状），够就扣走并发奖
 * 六、daily：领奖后**删行**（可重接、进度清零）—— 与 main 的 claimed 行语义相对
 * 七、管理端配置：动态增删 + 四条跨字段守卫（重复 id / 目标不存在 / 前置链成环 /
 *     被进度或链前置引用中拒删）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:quest
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（配置改写用它） */
const ADMIN_CODE = "e2e-quest-admin";

//#region 断言小工具（与 e2e-combat 同款口径）

const EXPECTED_ASSERTIONS = 48;

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
 * 预先往临时库里插刷怪区（#295：播种来源 = map_spawn_areas）。
 * 地图 1 一区两只怪物 1（max 2）—— 击杀进度（五只）与日常重接各杀一只都打它。
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
  db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("1", "1号怪物", "1", 0, 2, 200, 300, 400, 400, Date.now());
  db.close();
}

/** 起一台服务（文件库 + 快重生：击杀进度要连杀 6 只，默认 30s 重生等不起） */
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
      JWT_SECRET: "e2e-quest-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_RESPAWN_MS: "1500",
      // 本套不发位置心跳（waitFor 的空档会超过默认 3 秒的过期线）：在场条目按测试口径拉长
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

/** 一份最小可建号的角色文档（e2e-combat 同款；带技能 1000 供击杀用，背包 4×10 空网格） */
function roleData(id, name) {
  const bag = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag, skills: { 1000: 1 } };
}

/** 一条会话化的 WS 连接：cast 按 castId 等它自己的 settle 帧，quest 帧单独记 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    /** 任务进度帧（#396：只推给本人） */
    quests: [],
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 进图登记并等权威快照（cast 之前必须先 join） */
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
      if (frame.type === "quest") session.quests.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("close", () => {});
  socket.on("error", () => {});
  return session;
}

/** 直接开库断言 quest_progress（e2e-guild 同款手法） */
function progressRows(dbPath, roleId, questId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const rows = questId
    ? db.prepare("SELECT status, progress FROM quest_progress WHERE role_id = ? AND quest_id = ?").all(roleId, questId)
    : db.prepare("SELECT quest_id, status, progress FROM quest_progress WHERE role_id = ?").all(roleId);
  db.close();
  return rows;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-quest-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 准备：玩家（带技能）+ 实时连接 + 管理员

    group("准备：玩家、实时连接与管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "quest_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleData("quest_r1", "任务者") } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    check(session.opened, "准备：实时连接已建立");
    const world = await session.joinWorld("1");
    check(!!(world && world.monsters.some((m) => m.alive)), "准备：进图拿到活着的怪物 1", JSON.stringify(world && world.monsters.length));

    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "quest_admin", password: "pass1234", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { username: "quest_admin", password: "pass1234" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录（配置守卫要用它改表）");

    const questList = await api(baseUrl, "GET", "admin/quests?page=1&size=50", { token: adminToken });
    check(questList.code === 0 && questList.data.list.length === 5, "准备：任务配置 seed 了 5 条（8001~8004 主线 + 8101 日常）", JSON.stringify(questList.data && questList.data.total));

    /** 连续出手直到目标死亡，返回带 killed 的那次结算（打不死 / 被拒返回 null） */
    let castSeq = 0;
    const cast = (body) => {
      castSeq += 1;
      const id = castSeq;
      session.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
      return { id, promise: session.waitForSettle(id) };
    };
    /**
     * 连续出手直到目标死亡，返回带 killed 的那次结算（实在打不到才返回 null）。
     * **必须自带重试**：刷怪区只有 2 个槽、重生 `1500ms`，刚连杀完 5 只时可能两只都在冷却，
     * 只取一次快照会「没有活着的怪」直接空手返回（CI 上就这样抖过一次：六组拿不到击杀，
     * 后面 6 条断言连环假红）。同理出手被拒（目标在快照与出手之间被别人打死）也要重取快照。
     */
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
    /** 我的一条任务进度行 */
    const myQuest = async (questId) => {
      const mine = await api(baseUrl, "GET", "quests/me", { token });
      const list = (mine.data && mine.data.quests) || [];
      return list.find((row) => row.questId === questId) || null;
    };

    //#endregion

    //#region 一、快照下发

    group("一、快照下发（客户端配置覆写的来源）");
    const snapshot = await api(baseUrl, "GET", "game-config", { token });
    const snapQuests = (snapshot.data && snapshot.data.quests) || [];
    check(
      snapshot.code === 0 && snapQuests.length === 5 && snapQuests.some((row) => row.id === "8001") && snapQuests.some((row) => row.id === "8101"),
      "快照带 quests 全量（主线 + 日常都在）",
      JSON.stringify(snapQuests.length),
    );
    const snapMain = snapQuests.find((row) => row.id === "8001");
    check(
      !!snapMain && snapMain.objective && snapMain.objective.type === "talk" && snapMain.objective.target === "0002" && snapMain.rewards && snapMain.rewards.gold === 500,
      "快照任务行形状同管理端（objective / rewards 已展开）",
      JSON.stringify(snapMain),
    );

    //#endregion

    //#region 二、接取门控（前置 / 重复 / 等级）

    group("二、接取门控");
    const gated = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8003" } });
    check(gated.code === 20015, "主线链前置未完成 → 20015（8002 还没领）", JSON.stringify(gated));

    // 未接取时 npc-talk 里是 available（放在接取 8001 之前——可接态来自「无进度行」）
    await api(baseUrl, "PATCH", "admin/npcs/0002", { token: adminToken, body: { dialog: "欢迎来到大陆，年轻人。" } });
    const talkBefore = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: "0002" } });
    const beforeRow = talkBefore.code === 0 ? (talkBefore.data.quests || []).find((row) => row.questId === "8001") : null;
    check(!!beforeRow && beforeRow.status === "available", "未接取时 npc-talk 里 8001 是 available", JSON.stringify(beforeRow));

    const acceptedMain = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    const mainRow = acceptedMain.code === 0 ? (acceptedMain.data.quests || []).find((row) => row.questId === "8001") : null;
    check(!!mainRow && mainRow.status === "accepted" && mainRow.progress === 0, "接取 8001 成功（accepted / 进度 0）", JSON.stringify(mainRow));

    const reAccept = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    check(reAccept.code === 20015, "重复接取 → 20015", JSON.stringify(reAccept));

    await api(baseUrl, "PATCH", "admin/quests/8101", { token: adminToken, body: { minLevel: 99 } });
    const lowLevel = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    check(lowLevel.code === 20016, "等级不够 → 20016（服务端复核，不信客户端灰按钮）", JSON.stringify(lowLevel));
    await api(baseUrl, "PATCH", "admin/quests/8101", { token: adminToken, body: { minLevel: 1 } });
    const acceptedDaily = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    check(acceptedDaily.code === 0, "等级够（改回 1 级）→ 日常可接（无前置门控）", JSON.stringify(acceptedDaily.message));

    const mineAfter = await api(baseUrl, "GET", "quests/me", { token });
    const mineIds = ((mineAfter.data && mineAfter.data.quests) || []).map((row) => row.questId).sort();
    checkEqual(JSON.stringify(mineIds), JSON.stringify(["8001", "8101"]), "me 只有两行进度（可接任务不在内）");

    //#endregion

    //#region 三、talk 进度与领奖（main 的 claimed 行 = 链门控）

    group("三、talk 进度与领奖");
    const talkOne = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: "0002" } });
    check(talkOne.code === 0 && talkOne.data.dialog === "欢迎来到大陆，年轻人。", "对话带回管理端配置的文案", JSON.stringify(talkOne.data && talkOne.data.dialog));
    const mainAfterTalk = await myQuest("8001");
    check(!!mainAfterTalk && mainAfterTalk.status === "ready", "talk 进度 +1 到量 → ready", JSON.stringify(mainAfterTalk));
    const talkFrame = session.quests.find((frame) => frame.questId === "8001");
    check(!!talkFrame && talkFrame.status === "ready", "quest 帧推给了本人连接（进度变化即推）", JSON.stringify(talkFrame));

    const submitMain = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8001" } });
    check(
      submitMain.code === 0 && submitMain.data.reward && submitMain.data.reward.gold === 500 && submitMain.data.reward.exp === 100,
      "交付 8001：奖励按配置结算（金币 500 / 经验 100）",
      JSON.stringify(submitMain.data && submitMain.data.reward),
    );
    const mainClaimed = await myQuest("8001");
    check(!!mainClaimed && mainClaimed.status === "claimed", "main 领奖后保留 claimed 行（作链门控）", JSON.stringify(mainClaimed));

    //#endregion

    //#region 四、kill 进度（realtime 击杀结算递进）

    group("四、kill 进度（击杀结算递进）");
    const acceptedKill = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8002" } });
    check(acceptedKill.code === 0, "接取 8002（prev 8001 已 claimed）", JSON.stringify(acceptedKill.message));

    const firstKill = await killOne();
    check(!!(firstKill && firstKill.killed), "击杀第 1 只成功");
    const afterFirst = await myQuest("8002");
    check(!!afterFirst && afterFirst.progress === 1 && afterFirst.status === "accepted", "击杀进度 +1（服务端权威，客户端没有上报口子）", JSON.stringify(afterFirst));
    const killFrame = session.quests.find((frame) => frame.questId === "8002");
    check(!!killFrame && killFrame.progress === 1 && killFrame.target === 5, "quest 帧带 progress / target", JSON.stringify(killFrame));

    let killedTotal = 1;
    while (killedTotal < 5) {
      const result = await killOne();
      if (result && result.killed) killedTotal += 1;
      else await sleep(100);
    }
    check(killedTotal === 5, "连杀 5 只（重生等待在 killOne 里兜底）", `killed=${killedTotal}`);
    const killReady = await myQuest("8002");
    check(!!killReady && killReady.status === "ready", "进度到量 → ready", JSON.stringify(killReady));

    const submitKill = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8002" } });
    const killReward = submitKill.data && submitKill.data.reward;
    check(
      submitKill.code === 0 && !!killReward && killReward.gold === 800 && JSON.stringify(killReward.items) === JSON.stringify([{ goodId: "material_hide", count: 2 }]),
      "交付 8002：金币 800 + 兽皮 x2 一次落库",
      JSON.stringify(killReward),
    );
    const roleAfter = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const bagAfter = (roleAfter.data && roleAfter.data.data && roleAfter.data.data.bag) || [];
    const hideCells = bagAfter.flat().filter((cell) => cell && cell.id === "material_hide");
    check(hideCells.reduce((sum, cell) => sum + cell.count, 0) === 2, "奖励物品已入包（material_hide x2）", JSON.stringify(bagAfter));

    const claimedRows = progressRows(dbPath, roleId, "8002");
    check(claimedRows.length === 1 && claimedRows[0].status === "claimed", "开库核对：main 领奖后行还在（claimed）", JSON.stringify(claimedRows));
    const resubmitKill = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8002" } });
    check(resubmitKill.code === 20015, "不可重复领奖 → 20015", JSON.stringify(resubmitKill));

    //#endregion

    //#region 五、collect（交付时查背包）

    group("五、collect（交付时查背包）");
    // 背包恰好 2 张皮（8002 的奖励）：把 8003 的目标数量改成 2，走「够 → 扣走 + 发奖」的完整链
    await api(baseUrl, "PATCH", "admin/quests/8003", { token: adminToken, body: { objective: { type: "collect", target: "material_hide", count: 2 } } });
    const acceptedCollect = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8003" } });
    check(acceptedCollect.code === 0, "接取 8003（prev 8002 已 claimed）", JSON.stringify(acceptedCollect.message));
    const collectProgress = await myQuest("8003");
    check(!!collectProgress && collectProgress.progress === 2, "collect 进度实时算背包持有量（2/2）", JSON.stringify(collectProgress));

    const submitCollect = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8003" } });
    const collectReward = submitCollect.data && submitCollect.data.reward;
    check(
      submitCollect.code === 0 && JSON.stringify(collectReward && collectReward.items) === JSON.stringify([{ goodId: "material_iron", count: 1 }]),
      "交付 8003：奖励铁料 x1",
      JSON.stringify(collectReward),
    );
    const bagFinal = (((await api(baseUrl, "GET", `roles/${roleId}`, { token })).data || {}).data || {}).bag || [];
    const hidesLeft = bagFinal.flat().filter((cell) => cell && cell.id === "material_hide").reduce((sum, cell) => sum + cell.count, 0);
    const irons = bagFinal.flat().filter((cell) => cell && cell.id === "material_iron").reduce((sum, cell) => sum + cell.count, 0);
    check(hidesLeft === 0 && irons === 1, "材料扣走（皮清零）、奖励入包（铁料 x1）", JSON.stringify({ hidesLeft, irons }));

    const chainNext = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8004" } });
    check(chainNext.code === 0, "链继续：接取 8004（prev 8003 已 claimed）", JSON.stringify(chainNext.message));

    //#endregion

    //#region 六、daily 重接（领奖后删行）

    group("六、daily 领奖后删行可重接");
    await api(baseUrl, "PATCH", "admin/quests/8101", { token: adminToken, body: { objective: { type: "kill", target: "1", count: 1 } } });
    const dailyKill = await killOne();
    check(!!(dailyKill && dailyKill.killed), "日常目标（改后杀 1 只怪物 1）达成");
    const dailyReady = await myQuest("8101");
    check(!!dailyReady && dailyReady.status === "ready", "日常进度到量 → ready", JSON.stringify(dailyReady));
    const submitDaily = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8101" } });
    check(submitDaily.code === 0 && submitDaily.data.reward.gold === 500, "交付日常：奖励照发", JSON.stringify(submitDaily.data && submitDaily.data.reward));
    const dailyAfter = await myQuest("8101");
    check(dailyAfter === null, "daily 领奖后**行被删除**（me 里没有 8101）", JSON.stringify(dailyAfter));
    const dailyRows = progressRows(dbPath, roleId, "8101");
    check(dailyRows.length === 0, "开库核对：8101 无行（可重接、进度清零）", JSON.stringify(dailyRows));
    const reAcceptDaily = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    check(reAcceptDaily.code === 0, "重接成功（新一轮开始，进度 0）", JSON.stringify(reAcceptDaily.message));

    //#endregion

    //#region 七、管理端配置纪律（动态增删 + 四条守卫）

    group("七、管理端配置纪律");
    const createdQuest = await api(baseUrl, "POST", "admin/quests", {
      token: adminToken,
      body: { id: "8201", kind: "daily", label: "临时任务", objective: { type: "kill", target: "1", count: 1 }, rewards: { gold: 1, exp: 1, items: [] } },
    });
    check(createdQuest.code === 0 && createdQuest.data.id === "8201", "动态新增任务成功", JSON.stringify(createdQuest.message));
    const dupQuest = await api(baseUrl, "POST", "admin/quests", {
      token: adminToken,
      body: { id: "8201", kind: "daily", label: "重复", objective: { type: "kill", target: "1", count: 1 } },
    });
    check(dupQuest.code === 40000, "重复 id → 40000", JSON.stringify(dupQuest));
    const badTarget = await api(baseUrl, "POST", "admin/quests", {
      token: adminToken,
      body: { id: "8202", kind: "daily", label: "坏目标", objective: { type: "kill", target: "no_such_monster", count: 1 } },
    });
    check(badTarget.code === 40000, "目标键指向不存在的怪物 → 40000", JSON.stringify(badTarget));
    const cycle = await api(baseUrl, "PATCH", "admin/quests/8001", { token: adminToken, body: { prevQuestId: "8004" } });
    check(cycle.code === 40000, "前置链成环（8001→8004→8003→8002→8001）→ 40000", JSON.stringify(cycle));

    const delWithFollower = await api(baseUrl, "DELETE", "admin/quests/8002", { token: adminToken });
    check(delWithFollower.code === 40000, "被后继任务当前置 → 拒删", JSON.stringify(delWithFollower));
    const delWithProgress = await api(baseUrl, "DELETE", "admin/quests/8001", { token: adminToken });
    check(delWithProgress.code === 40000, "有玩家进度（claimed 行）→ 拒删", JSON.stringify(delWithProgress));
    const delTemp = await api(baseUrl, "DELETE", "admin/quests/8201", { token: adminToken });
    check(delTemp.code === 0, "无引用的临时任务可删", JSON.stringify(delTemp));
    const delMissing = await api(baseUrl, "DELETE", "admin/quests/9999", { token: adminToken });
    check(delMissing.code === 50031, "删除不存在的任务 → 404（50031）", JSON.stringify(delMissing));

    //#endregion

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 任务 e2e：${failed} 项断言不通过`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
    assertExpectedCount();
  } finally {
    if (serverChild) serverChild.kill("SIGTERM");
    await sleep(300);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* 临时库随缘清理 */
    }
  }
})();
