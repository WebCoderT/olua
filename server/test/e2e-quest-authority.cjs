#!/usr/bin/env node
/**
 * 任务权威专项 e2e（server/test/e2e-quest-authority.cjs，issue #862/#863/#864/#865）
 *
 * 与 `e2e-quest.cjs` 的分工：那一套盯状态机（接 / 交 / 进度 / 日切），这一套只盯
 * **「服务端凭什么相信你」** 与 **周期**：
 *
 * 一、NPC 距离闸（#862/#863）：位置快照缺失 / 太旧 / NPC 不在本图 / 距离超限 → 20032；
 *     贴身后放行；接取与对话**都**要过这道闸
 * 二、缺点位 NPC 的放行口径（2026-11-11 定）：`npcs` 有行但 `map_npcs` 全服没点位时
 *     不拦（配置缺口不惩罚玩家），点位补上后自动生效
 * 三、放弃（#865）：进行中可放弃并删行 → 回到可接；claimed 不能放弃；没接过的报 20015
 * 四、过期交付（#865）：日常 / 周常跨轮后 submit 返 20033，且**一个铜板都不发**
 * 五、周常（#864）：接取时 `reset_day` 落本周周一；本周再接待 20027；跨周后过期不下发、
 *     再接覆盖重置
 *
 * 位置全部由测试直接写 `role_positions`：这张表的**唯一写者是实时进程**（1 秒节流），
 * 而这一套不发位置心跳 —— 直接写库等价于「他此刻就在这儿」，被测的是服务端的判定。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：npm run test:e2e:quest-authority
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（要建周常任务 + 摆 NPC 点位） */
const ADMIN_CODE = "e2e-quest-authority-admin";
/** 所有任务与 NPC 都在这张图上（种子数据里 0002 在每张图都有点位） */
const MAP_ID = "1";
/** 任务的发布 NPC（大陆传送官） */
const NPC_ID = "0002";
/** 只在特定图有点位的 NPC（战魂使者）—— 现网 `map_npcs` 里**没有**它，用来测「缺点位放行」 */
const NPC_NO_POINT = "9002";

//#region 断言小工具（与 e2e-quest 同款口径）

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 开库做一次准备 / 断言（每一步都等锁，避免与服务的世界落盘抢写锁） */
function withDb(dbPath, fn) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * 写一行角色位置快照（模拟「他此刻站在这儿」）
 *
 * @param {string} dbPath 库文件
 * @param {string} roleId 角色 id
 * @param {{mapId?: string, x: number, y: number, ageMs?: number}} at 位置与「多久之前」
 */
function setPosition(dbPath, roleId, at) {
  const now = Date.now() - (at.ageMs ?? 0);
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO role_positions (role_id, map_id, x, y, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(role_id) DO UPDATE SET map_id = excluded.map_id, x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
    ).run(roleId, at.mapId ?? MAP_ID, at.x, at.y, now);
  });
}

/** 某张图上某 NPC 的点位（没有 = null） */
function npcPoint(dbPath, mapId, npcId) {
  return withDb(dbPath, (db) => db.prepare("SELECT cx, cy FROM map_npcs WHERE map_id = ? AND npc_id = ?").get(mapId, npcId) ?? null);
}

/** 让角色站到某张图上某个 NPC 的**脚下** */
function standAtNpc(dbPath, roleId, mapId = MAP_ID, npcId = NPC_ID) {
  const spot = npcPoint(dbPath, mapId, npcId);
  if (!spot) throw new Error(`准备段失败：map_npcs 里没有 (map ${mapId}, npc ${npcId})`);
  setPosition(dbPath, roleId, { mapId, x: spot.cx, y: spot.cy });
  return spot;
}

/** 读任务进度行（不传 questId = 全部） */
function progressRows(dbPath, roleId, questId) {
  return withDb(dbPath, (db) =>
    questId
      ? db.prepare("SELECT status, progress, reset_day FROM quest_progress WHERE role_id = ? AND quest_id = ?").all(roleId, questId)
      : db.prepare("SELECT quest_id, status, progress, reset_day FROM quest_progress WHERE role_id = ?").all(roleId),
  );
}

/** 改某一行的 `reset_day`（e2e 没有假时钟，跨轮只能改行模拟） */
function setResetDay(dbPath, roleId, questId, day) {
  withDb(dbPath, (db) => db.prepare("UPDATE quest_progress SET reset_day = ? WHERE role_id = ? AND quest_id = ?").run(day, roleId, questId));
}

/** 起一台服务（文件库；不播怪，这一套不打架） */
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
      JWT_SECRET: "e2e-quest-authority-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
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
/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

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

/** 本周周一的「天号」（与 server/src/common/constants/quest.ts 同算法：05:00 尺子再取整到周一） */
function weekStartDay(now = Date.now()) {
  const day = Math.floor((now - 5 * 3_600_000) / 86_400_000);
  const weekday = (((day + 4) % 7) + 7) % 7;
  return day - ((weekday + 6) % 7);
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-quest-authority-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：玩家 + 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "quest_auth_player", password: "pass1234" } });
    const token = registered && registered.data && registered.data.token;
    check(!!token, "准备：玩家已注册");
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "权威者", occupation: "1", sex: "1" } });
    const roleId = created && created.data && created.data.id;
    check(created && created.code === 0 && !!roleId, "准备：角色已创建并自动在线", created && created.message);
    // #859：没有位置记录的角色只准进新手村 —— 这一套不 worldJoin，但摆位仍按运营口径来
    placeRolesAt(dbPath, MAP_ID);

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "quest_auth_admin", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username: "quest_auth_admin", password: "pass1234" } });
    const adminToken = adminLogin && adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录（要建周常 / 摆点位）");

    // 周常任务 8201：与任务 NPC 对话 1 次（跑通「接 → 推进度 → 交付 → 切周」整条链）
    const weekly = await api(baseUrl, "POST", "admin/quests", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: {
        id: "8201",
        kind: "weekly",
        label: "周常试炼",
        description: "本周的例行试炼：去和传送官说句话。",
        npcId: NPC_ID,
        minLevel: 1,
        objective: { type: "talk", target: NPC_ID, count: 1 },
        rewards: { bindGold: 300, exp: 50, items: [] },
      },
    });
    check(weekly && weekly.code === 0, "准备：建了一条 weekly 任务（8201）", weekly && weekly.message);
    // 8202：发布 NPC 是 9002（现网 `map_npcs` 里没有它），用来测「缺点位放行」那一档；
    // 不挂 prev 链，接取能不能过只取决于 NPC 距离这一道闸
    const noPointQuest = await api(baseUrl, "POST", "admin/quests", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: {
        id: "8202",
        kind: "main",
        label: "战魂试炼",
        description: "去战魂使者那儿报个到。",
        npcId: NPC_NO_POINT,
        minLevel: 1,
        objective: { type: "talk", target: NPC_NO_POINT, count: 1 },
        rewards: { bindGold: 100, exp: 10, items: [] },
      },
    });
    check(noPointQuest && noPointQuest.code === 0, "准备：建了一条发布 NPC 没点位的任务（8202）", noPointQuest && noPointQuest.message);
    check(
      weekly && weekly.data && weekly.data.kind === "weekly",
      "准备：管理端回显 kind = weekly（枚举已放开）",
      JSON.stringify(weekly && weekly.data && weekly.data.kind),
    );

    //#endregion

    //#region 一、NPC 距离闸

    group("一、NPC 距离闸（#862/#863）");

    // 1) 完全没有位置快照 —— 「不知道他在哪」必须拒绝，否则「不上报位置」就是绕过开关
    withDb(dbPath, (db) => db.prepare("DELETE FROM role_positions WHERE role_id = ?").run(roleId));
    const noPosTalk = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    checkEqual(noPosTalk && noPosTalk.code, 20032, "没有位置快照 → npc-talk 20032 not_near_npc");
    check(
      noPosTalk && /位置/.test(noPosTalk.message || ""),
      "文案说清是「没收到位置」而不是「太远」",
      noPosTalk && noPosTalk.message,
    );

    // 2) 位置快照太旧（11 秒前的）—— 掉线留下的行不能当永久通行证
    const spot = standAtNpc(dbPath, roleId);
    setPosition(dbPath, roleId, { mapId: MAP_ID, x: spot.cx, y: spot.cy, ageMs: 11_000 });
    const staleTalk = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    checkEqual(staleTalk && staleTalk.code, 20032, "位置快照 11 秒未更新 → 20032（新鲜度窗口 10 秒）");

    // 3) 站在同一张图但离得很远 —— 这条就是 #862 的核心：以前只凭 npcId 就算完成
    setPosition(dbPath, roleId, { mapId: MAP_ID, x: spot.cx + 500, y: spot.cy });
    const farTalk = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    checkEqual(farTalk && farTalk.code, 20032, "离 NPC 500px → 20032（阈值 120px）");
    check(/\d+ 像素/.test(farTalk && farTalk.message ? farTalk.message : ""), "文案带实际距离（玩家能判断差多远）", farTalk && farTalk.message);

    // 4) 接取也要过这道闸（#863）：远处接 8001
    const farAccept = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    checkEqual(farAccept && farAccept.code, 20032, "远处接取 8001 → 20032（接取与对话同一道闸）");
    checkEqual(progressRows(dbPath, roleId, "8001").length, 0, "被拒的接取没有留下进度行");

    // 5) 贴着 NPC 站 → 放行，且 talk 推进度（到量转 ready）
    standAtNpc(dbPath, roleId);
    const nearAccept = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    check(nearAccept && nearAccept.code === 0, "贴身后接取 8001 成功", nearAccept && nearAccept.message);
    standAtNpc(dbPath, roleId);
    const nearTalk = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    check(nearTalk && nearTalk.code === 0, "贴身后对话成功", nearTalk && nearTalk.message);
    const talkedRow = progressRows(dbPath, roleId, "8001")[0];
    check(!!talkedRow && talkedRow.status === "ready" && talkedRow.progress === 1, "对话推进到 ready（进度 1/1）", JSON.stringify(talkedRow));

    // 6) 边界：刚好在半径内（119px）放行，刚出半径（121px）拒绝
    setPosition(dbPath, roleId, { mapId: MAP_ID, x: spot.cx + 119, y: spot.cy });
    const insideEdge = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    check(insideEdge && insideEdge.code === 0, "距 119px（阈值内）→ 放行", insideEdge && insideEdge.message);
    setPosition(dbPath, roleId, { mapId: MAP_ID, x: spot.cx + 121, y: spot.cy });
    const outsideEdge = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    checkEqual(outsideEdge && outsideEdge.code, 20032, "距 121px（阈值外）→ 20032");

    //#endregion

    //#region 二、缺点位 NPC 的放行口径

    group("二、NPC 缺点位：放行 + 告警，补上点位后自动生效（2026-11-11 定）");
    checkEqual(npcPoint(dbPath, MAP_ID, NPC_NO_POINT), null, "准备：战魂使者（9002）在任何图上都没有点位");

    withDb(dbPath, (db) => db.prepare("DELETE FROM quest_progress WHERE role_id = ?").run(roleId));
    standAtNpc(dbPath, roleId);
    const noPointAccept = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8202" } });
    check(noPointAccept && noPointAccept.code === 0, "NPC 全服没点位 → 接取放行（不拿配置缺口卡玩家）", noPointAccept && noPointAccept.message);

    // 补一个点位到别的图（map 2）——「只摆在别的图」要变成拒绝，而不是继续放行
    const placed = await api(baseUrl, "POST", `admin/maps/2/npcs`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { npcId: NPC_NO_POINT, cx: 4096, cy: -5312 },
    });
    check(placed && placed.code === 0, "准备：给 9002 在 map 2 摆一个点位", placed && JSON.stringify(placed.message));
    standAtNpc(dbPath, roleId);
    const otherMapAccept = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8202" } });
    checkEqual(otherMapAccept && otherMapAccept.code, 20032, "NPC 只摆在别的图 → 20032（走错图不再放行）");
    check(
      otherMapAccept && /不在你当前这张图/.test(otherMapAccept.message || ""),
      "文案指明是「不在这张图」（与「太远」分开）",
      otherMapAccept && otherMapAccept.message,
    );

    //#endregion

    //#region 三、放弃

    group("三、放弃（#865）");
    withDb(dbPath, (db) => db.prepare("DELETE FROM quest_progress WHERE role_id = ?").run(roleId));

    standAtNpc(dbPath, roleId);
    const acceptDaily = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    check(acceptDaily && acceptDaily.code === 0, "接取日常 8101", acceptDaily && acceptDaily.message);
    const abandoned = await api(baseUrl, "POST", "quests/abandon", { token, body: { questId: "8101" } });
    check(abandoned && abandoned.code === 0, "放弃进行中的日常 → 成功", abandoned && abandoned.message);
    checkEqual(progressRows(dbPath, roleId, "8101").length, 0, "放弃后进度行已删除（回到「没接过」）");
    const abandonAgain = await api(baseUrl, "POST", "quests/abandon", { token, body: { questId: "8101" } });
    checkEqual(abandonAgain && abandonAgain.code, 20015, "没接过再放弃 → 20015");
    standAtNpc(dbPath, roleId);
    const reAcceptAfterAbandon = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    check(reAcceptAfterAbandon && reAcceptAfterAbandon.code === 0, "放弃后当轮可再接（没领奖就没占额度）", reAcceptAfterAbandon && reAcceptAfterAbandon.message);

    // claimed 行不能放弃：8001 走完 talk → submit
    standAtNpc(dbPath, roleId);
    await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    standAtNpc(dbPath, roleId);
    await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    const submitted = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8001" } });
    check(submitted && submitted.code === 0, "8001 交付成功（拿它做 claimed 样本）", submitted && submitted.message);
    const abandonClaimed = await api(baseUrl, "POST", "quests/abandon", { token, body: { questId: "8001" } });
    checkEqual(abandonClaimed && abandonClaimed.code, 20015, "已领奖的不能放弃（删了日常就能刷）");
    checkEqual(progressRows(dbPath, roleId, "8001")[0].status, "claimed", "claimed 行仍在（放弃没有删它）");

    //#endregion

    //#region 四、过期交付

    group("四、过期交付（#865）");
    const bindGoldNow = async () => {
      const role = await api(baseUrl, "GET", `roles/${roleId}`, { token });
      return role && role.data && role.data.data ? Number(role.data.data.bindGold ?? 0) : 0;
    };
    const goldBefore = await bindGoldNow();

    // 日常：把这一行挪到昨天 → 交付必须被拒，且不发奖
    const dailyRow = progressRows(dbPath, roleId, "8101")[0];
    setResetDay(dbPath, roleId, "8101", dailyRow.reset_day - 1);
    const expiredSubmit = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8101" } });
    checkEqual(expiredSubmit && expiredSubmit.code, 20033, "昨天的日常行 → submit 20033 quest_expired");
    checkEqual(await bindGoldNow(), goldBefore, "过期交付一个铜板都没发");

    // 周常：同样跨轮
    standAtNpc(dbPath, roleId);
    const acceptWeekly = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8201" } });
    check(acceptWeekly && acceptWeekly.code === 0, "接取周常 8201", acceptWeekly && acceptWeekly.message);
    const weeklyRow = progressRows(dbPath, roleId, "8201")[0];
    setResetDay(dbPath, roleId, "8201", weekStartDay() - 7);
    const expiredWeekly = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8201" } });
    checkEqual(expiredWeekly && expiredWeekly.code, 20033, "上周的周常行 → submit 20033");

    //#endregion

    //#region 五、周常周期

    group("五、周常（#864）：周一 05:00 切周");
    checkEqual(weeklyRow.reset_day, weekStartDay(), "接取时 reset_day 落本周周一的天号");
    check(
      weeklyRow.reset_day <= Math.floor((Date.now() - 5 * 3_600_000) / 86_400_000),
      "周号不晚于今天（同一把 05:00 尺子）",
      JSON.stringify({ weekly: weeklyRow.reset_day }),
    );

    // 跨周后：过期行不下发（客户端「没有行 = 可接」的判断不用改）
    const meAfterExpire = await api(baseUrl, "GET", "quests/me", { token });
    const weeklyInMe = (meAfterExpire && meAfterExpire.data && meAfterExpire.data.quests ? meAfterExpire.data.quests : []).filter(
      (row) => row.questId === "8201",
    );
    checkEqual(weeklyInMe.length, 0, "跨周后过期的周常行不下发");

    standAtNpc(dbPath, roleId);
    const reAcceptWeekly = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8201" } });
    check(reAcceptWeekly && reAcceptWeekly.code === 0, "跨周后可再接（覆盖重置）", reAcceptWeekly && reAcceptWeekly.message);
    const resetWeekly = progressRows(dbPath, roleId, "8201");
    check(
      resetWeekly.length === 1 && resetWeekly[0].status === "accepted" && resetWeekly[0].progress === 0 && resetWeekly[0].reset_day === weekStartDay(),
      "覆盖重置：同一行、进度清零、天号回到本周周一",
      JSON.stringify(resetWeekly),
    );

    // 本周做完 → 20027（文案要说「下周一 05:00」）
    standAtNpc(dbPath, roleId);
    await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: NPC_ID } });
    const weeklySubmit = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8201" } });
    check(weeklySubmit && weeklySubmit.code === 0, "周常交付成功", weeklySubmit && weeklySubmit.message);
    standAtNpc(dbPath, roleId);
    const weeklyAgain = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8201" } });
    checkEqual(weeklyAgain && weeklyAgain.code, 20027, "本周再接同一周常 → already_done（20027）");
    check(
      weeklyAgain && /下周一/.test(weeklyAgain.message || ""),
      "文案指明下一轮是「下周一 05:00」",
      weeklyAgain && weeklyAgain.message,
    );

    //#endregion

    //#region 六、位置快照的新鲜度由实时进程维护（不落盘就必然失效）

    group("六、离线即失效：位置行删掉（等价 dropAccount）之后不能再交互");
    withDb(dbPath, (db) => db.prepare("DELETE FROM role_positions WHERE role_id = ?").run(roleId));
    const afterDrop = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8101" } });
    checkEqual(afterDrop && afterDrop.code, 20032, "位置行删除（下线）后接取 → 20032");

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push("未捕获异常");
    console.error("\n未捕获异常：", error && error.stack ? error.stack : error);
    console.error(server.logs().split("\n").slice(-40).join("\n"));
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    try {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    } catch {
      /* 已经退出 */
    }
    console.log(`\n---------------------------------`);
    console.log(`  ${passed} 通过 / ${failed} 失败`);
    if (failed > 0) {
      console.log(failures.map((item) => `  ✗ ${item}`).join("\n"));
    }
    process.exit(failed > 0 ? 1 : 0);
  }
})();
