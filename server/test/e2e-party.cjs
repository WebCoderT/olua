#!/usr/bin/env node
/**
 * 队伍专项 e2e（server/test/e2e-party.cjs，issue #399）
 *
 * 盯的不变量（改队伍动作 / 权限 / 经验分成后必须全绿）：
 * 一、邀请即建队：邀请人没队伍时自动建一支（自己是队长）；快照里人数 / 上限 / isLeader 都对
 * 二、同意与拒绝：同意后双方都收到新快照（名字由 JOIN 出来）、拒绝是静默的、邀请消费掉后不能再同意
 * 三、满员与重复：上限读配置（本套压到 3 人）、满员拒邀 50122、已在队伍 50123、重复邀请 50127
 * 四、权限与转让：非队长踢人 50124、不能踢自己 / 非成员 50125、转让后权限翻转（原队长失去踢人权）
 * 五、队长退出自动移交：队长退队后，**最早加入**的剩余成员接任
 * 六、解散：三方都收到空快照（客户端据此清面板与队标）
 * 七、屏蔽优先：他拉黑我 → 「不在线」（不说破）；我拉黑他 → 明说先解除（50130）
 * 八、互见帧带 partyId：组队立刻反映到别人的屏幕上（队友金色名字 + 队标），解散后变回空串
 * 九、经验分成：击杀者全额（settle.reward）、同图队友 50%（expGain 帧 + revision）、
 *     异图队友与等级差过大的队友都分不到（没有帧）、击杀者自己不会收到 expGain
 * 十、上限脏值回落（直接 new 服务类验，不起第二台服务）+ 门槛脏值回落
 * 十一、等级门槛（#497）：默认 10 级下，低等级发起 / 邀请低等级目标都拒 50144，
 *      被拒的邀请不送达、够级的照常组队（独立进程 + 默认配置，主进程把门槛压成 1）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:party
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 队伍上限压到 3：四个人就能撞满员，不必凑六个账号 */
const PARTY_LIMIT = 3;

/** 管理端注册码：造高等级号要提级（#554 后建号恒 1 级），提级得用管理端令牌 */
const ADMIN_REGISTER_CODE = "e2e-party-admin-code";

//#region 断言小工具（与 e2e-chat / e2e-blocks 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 87;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  return false;
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

/** 轮询等一个条件成立（超时返回 null，由调用方断言） */
async function waitFor(label, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  console.log(`  [..] 等待超时：${label}`);
  return null;
}

/**
 * 预先往临时库里插刷怪区（#295 起播种来源是 map_spawn_areas）
 *
 * 地图 1 放 4 只怪物 1（等级 1、maxHp 65），够经验分组连杀几次；
 * 地图 2 放 1 只，给「队友在另一张图」用。
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
  insert.run("1", "赤焰斗鸡区", "1", 0, 4, 400, 400, 800, 800, now);
  insert.run("2", "赤焰斗鸡区", "1", 0, 1, 100, 100, 200, 200, now);
  db.close();
}

/** 起一台服务（文件库）；`extraEnv` 覆盖单条配置（如 `PARTY_MIN_LEVEL`） */
async function startServer(dbPath, extraEnv = {}) {
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
      JWT_SECRET: "e2e-party-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 上限走配置（验的是「读配置」而不是默认 4）
      PARTY_MEMBER_LIMIT: String(PARTY_LIMIT),
      // 屏蔽缓存压到 0：拉黑立刻生效，免得测试里到处 sleep 等缓存过期
      SOCIAL_BLOCK_CACHE_MS: "0",
      // 本套靠 mapId 判「同图分经验」，位置过期线拉长到 60 秒（waitFor 的空档会跨过默认 3 秒）
      MONSTER_AI_POS_STALE_MS: "60000",
      // 提级要用管理端接口（#554：建号等级钉成出厂值，造高级号只能建号 → PATCH）
      ADMIN_REGISTER_CODE,
      ...extraEnv,
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

/** 一份最小可建号的角色文档（e2e-combat 的 roleData 同款口径，带上基础技能才打得动怪） */
function roleData(id, name, level, skills) {
  return { id, name, occupation: "1", sex: "1", level, hp: 100, mp: 50, equipments: {}, bag: [], skills };
}

/** 注册账号 + 建一个在线角色，返回 { token, roleId }
 *
 * `level` 不是 1 时**由管理端提到该等级**：#554 起建号请求里的 `level` 会被钉成出厂值 1
 * （改包建号即满级那条口子焊死了），所以「造一个 12 级队友」只能建号 → PATCH。
 */
async function preparePlayer(baseUrl, username, roleId, roleName, level = 1, skills = { "1000": 1 }) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  await api(baseUrl, "POST", "roles", { token, body: { data: roleData(roleId, roleName, 1, skills) } });
  if (level !== 1) await raiseLevel(baseUrl, roleId, level);
  return { token, roleId };
}

/** 管理端令牌（按服务缓存一份：这套只拿它做提等级） */
const adminTokens = new Map();

async function adminTokenOf(baseUrl) {
  if (adminTokens.has(baseUrl)) return adminTokens.get(baseUrl);
  const reg = await api(baseUrl, "POST", "admin/auth/register", {
    body: { username: "party_gm", password: "Admin#1234", registerCode: ADMIN_REGISTER_CODE },
  });
  const token = reg.data && reg.data.token;
  adminTokens.set(baseUrl, token);
  return token;
}

/** 管理端把角色提到指定等级（#554 之后唯一的正规提级路径） */
async function raiseLevel(baseUrl, roleId, level) {
  const token = await adminTokenOf(baseUrl);
  const res = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token, body: { level } });
  if (!res || res.code !== 0) throw new Error(`提等级失败 ${roleId} → ${level}：${res && res.message}`);
  return res;
}

/** 一条收集全部帧的 WS 连接（队伍 / 邀请 / 经验 / 互见 / 结算 / 错误都留档） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    welcomes: [],
    /** 最新一份队伍快照（服务端只在变化时发，所以「最新」就是当前真值） */
    party: null,
    partyFrames: [],
    invites: [],
    errors: [],
    players: [],
    settles: [],
    expGains: [],
    worlds: 0,
    worldFrames: [],
    send(type, data) {
      socket.send(JSON.stringify({ type, data }));
    },
    /** 发一条队伍帧 */
    partyAction(action, roleId) {
      socket.send(JSON.stringify({ type: "party", data: roleId ? { action, roleId } : { action } }));
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "party") {
        session.party = frame.data;
        session.partyFrames.push(frame.data);
      }
      if (frame.type === "partyInvite") session.invites.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
      if (frame.type === "players") session.players.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "expGain") session.expGains.push(frame.data);
      if (frame.type === "world") {
        session.worlds += 1;
        session.worldFrames.push(frame.data);
      }
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {});
  return session;
}

/** 发一个动作并等它带来的**错误**帧（返回 { code, message }；超时 null） */
async function expectError(session, send, label, timeoutMs = 3_000) {
  const before = session.errors.length;
  send();
  return waitFor(label, async () => (session.errors.length > before ? session.errors[session.errors.length - 1] : null), timeoutMs);
}

/** 发一个动作并等下一次快照（返回快照；超时 null） */
async function expectSnapshot(session, send, label, timeoutMs = 3_000) {
  const before = session.partyFrames.length;
  send();
  return waitFor(label, async () => (session.partyFrames.length > before ? session.partyFrames[session.partyFrames.length - 1] : null), timeoutMs);
}

/**
 * 等一条**新**邀请（会话里的 invites 是累积数组）
 *
 * 邀请与同意走的是两条独立连接，**跨连接的到达顺序没有保证**；
 * 而且数组是累积的，直接取 `invites[length - 1]` 会命中上一组留下的旧邀请，
 * 于是 accept 在服务端还没收到 invite 时就到了 —— 表现成偶发 50126。
 */
async function waitInvite(session, label, mark = session.invites.length) {
  return waitFor(label, async () => (session.invites.length > mark ? session.invites[session.invites.length - 1] : null));
}

/** 队伍快照的可读摘要（断言失败时打出来） */
function snap(snapshot) {
  if (!snapshot) return "null";
  return JSON.stringify({
    partyId: snapshot.partyId,
    leader: snapshot.leaderRoleId,
    isLeader: snapshot.isLeader,
    limit: snapshot.limit,
    members: (snapshot.members || []).map((member) => `${member.name}/${member.level}${member.leader ? "*" : ""}${member.online ? "" : "(离线)"}${member.sameMap ? "" : "(异图)"}`),
  });
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-party-${Date.now()}.db`);
  seedSpawnAreas(dbPath);
  const server = await startServer(dbPath, {
    // 组队门槛压到 1（#497）：本套的队伍动作全用 **1 级角色** —— 因为经验分成那组要
    // 「1 级打 1 级怪」才凑得出等级差 0 的干净数值。门槛留在默认 10 会让 79 条全变成
    // 「等级不足」。门槛本身（默认 10）由第十一组用**独立进程 + 默认配置**验。
    PARTY_MIN_LEVEL: "1",
  });
  try {
    const { baseUrl } = server;
    const wsBase = baseUrl.replace("http", "ws");

    //#region 准备：五个账号（A/B/D/E 同图 1，C 在图的 2）

    group("准备：五个账号（A/B/D/E 同图 1，C 在图的 2）");
    const A = await preparePlayer(baseUrl, "party_player_a", "party_role_a", "甲队长", 1);
    const B = await preparePlayer(baseUrl, "party_player_b", "party_role_b", "乙队友", 1);
    const C = await preparePlayer(baseUrl, "party_player_c", "party_role_c", "丙异图", 1);
    const D = await preparePlayer(baseUrl, "party_player_d", "party_role_d", "丁外人", 1);
    // E 用「等级差过大」这个身份：怪物 1 是 1 级，差 11 ≥ maxLevelGap(6) → 队友基数为 0
    const E = await preparePlayer(baseUrl, "party_player_e", "party_role_e", "戊高级", 12);
    check(!!(A.token && B.token && C.token && D.token && E.token), "五个账号都注册并建好在线角色");

    const tickets = await Promise.all(
      [A, B, C, D, E].map((player) => api(baseUrl, "POST", "realtime/ticket", { token: player.token })),
    );
    check(tickets.every((ticket) => ticket.data && ticket.data.ticket), "五个账号都取到实时票据");
    const [sA, sB, sC, sD, sE] = tickets.map((ticket) => connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`));
    const welcomed = await waitFor(
      "五条连接都收到 welcome",
      async () => ([sA, sB, sC, sD, sE].every((session) => session.welcomes.length > 0) ? true : null),
    );
    check(!!welcomed, "五条实时连接都握手成功");

    // 进图 + 位置上报：队伍的身份（角色 / 地图）与「在线」都来自在场表
    sA.send("worldJoin", { mapId: "1" });
    sA.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    sB.send("worldJoin", { mapId: "1" });
    sB.send("pos", { mapId: "1", x: 140, y: 200, hp: 100, moving: false });
    sD.send("worldJoin", { mapId: "1" });
    sD.send("pos", { mapId: "1", x: 180, y: 200, hp: 100, moving: false });
    sE.send("worldJoin", { mapId: "1" });
    sE.send("pos", { mapId: "1", x: 220, y: 200, hp: 100, moving: false });
    sC.send("worldJoin", { mapId: "2" });
    sC.send("pos", { mapId: "2", x: 100, y: 200, hp: 100, moving: false });
    const joined = await waitFor("五个会话都拿到所在图的权威快照", async () =>
      sA.worlds > 0 && sB.worlds > 0 && sC.worlds > 0 && sD.worlds > 0 && sE.worlds > 0 ? true : null,
    );
    check(!!joined, "五个会话都拿到了所在图的权威快照");

    // 进图补一份空快照（#399）：客户端一进游戏就知道「我在不在队伍里」，不需要额外拉一次
    const baseline = await waitFor("每人进图后都收到一份队伍快照", async () =>
      [sA, sB, sC, sD, sE].every((session) => session.party !== null) ? true : null,
    );
    check(
      !!baseline && [sA, sB, sC, sD, sE].every((session) => session.party.partyId === "" && session.party.members.length === 0),
      "进图后的首份快照是「没有队伍」（空 partyId + 空成员）",
      [sA, sB, sC, sD, sE].map((session) => snap(session.party)).join(" | "),
    );

    //#endregion

    //#region 一、邀请即建队

    group("一、邀请即建队：邀请人没队伍时自动建一支");
    const inviteBMark = sB.invites.length;
    const created = await expectSnapshot(sA, () => sA.partyAction("invite", B.roleId), "A 建队后的快照");
    check(!!created && created.partyId !== "" && created.members.length === 1, "邀请发出时顺手建队（A 队里只有自己）", snap(created));
    checkEqual(created && created.isLeader, true, "建队的人就是队长");
    checkEqual(created && created.limit, PARTY_LIMIT, "上限来自配置（PARTY_MEMBER_LIMIT=3）");
    checkEqual(created && created.members[0] && created.members[0].roleId, A.roleId, "成员就是邀请人自己");

    // 邀请是随上面那次 invite 一起发出的，mark 必须在发之前取
    const inviteB = await waitInvite(sB, "B 收到邀请", inviteBMark);
    check(!!inviteB && inviteB.fromRoleId === A.roleId, "被邀请人收到 partyInvite（带邀请人 roleId）", JSON.stringify(inviteB));
    checkEqual(inviteB && inviteB.fromName, "甲队长", "邀请帧带邀请人角色名");
    check(!!inviteB && inviteB.memberCount === 1 && inviteB.limit === PARTY_LIMIT, "邀请帧带「当前人数 / 上限」", JSON.stringify(inviteB));
    check(!!inviteB && inviteB.expiresAt > Date.now(), "邀请帧带过期时刻（客户端可显示倒计时）");

    const dupInvite = await expectError(sA, () => sA.partyAction("invite", B.roleId), "重复邀请");
    checkEqual(dupInvite && dupInvite.code, 50127, "重复邀请被拒（50127）");

    const selfInvite = await expectError(sA, () => sA.partyAction("invite", A.roleId), "邀请自己");
    checkEqual(selfInvite && selfInvite.code, 50129, "不能邀请自己（50129）");

    const ghostInvite = await expectError(sA, () => sA.partyAction("invite", "no_such_role"), "邀请不存在的角色");
    checkEqual(ghostInvite && ghostInvite.code, 50109, "找不到角色复用 50109（不新开码）");

    const badAction = await expectError(sA, () => sA.partyAction("teleport", B.roleId), "非法动作");
    checkEqual(badAction && badAction.code, 40000, "不认识的队伍动作被拒（40000）");

    //#endregion

    //#region 二、同意与拒绝

    group("二、同意与拒绝：快照双向同步、邀请消费掉就作废");
    const acceptedB = await expectSnapshot(sB, () => sB.partyAction("accept"), "B 同意后的快照");
    check(!!acceptedB && acceptedB.members.length === 2, "同意后队伍变成 2 人", snap(acceptedB));
    checkEqual(acceptedB && acceptedB.leaderRoleId, A.roleId, "队长仍是邀请人");
    checkEqual(acceptedB && acceptedB.isLeader, false, "被邀请人不是队长");
    check(
      !!acceptedB && acceptedB.members.some((member) => member.roleId === A.roleId && member.name === "甲队长"),
      "成员名字由库里的角色名 JOIN 出来（不冗余存一份）",
      snap(acceptedB),
    );

    const acceptedAtA = await waitFor("A 收到「有人进队」的广播", async () =>
      sA.partyFrames.filter((frame) => frame.members.length === 2).slice(-1)[0] || null,
    );
    check(!!acceptedAtA && acceptedAtA.partyId === acceptedB.partyId, "队伍快照广播给全部成员（A 也收到同一支队）");

    const acceptAgain = await expectError(sB, () => sB.partyAction("accept"), "已入队后再同意");
    checkEqual(acceptAgain && acceptAgain.code, 50126, "没有待处理邀请时同意被拒（50126）");

    sA.partyAction("invite", C.roleId);
    const inviteC = await waitInvite(sC, "C 收到邀请");
    check(!!inviteC && inviteC.memberCount === 2, "邀请帧里的当前人数随队伍变化（此刻 2 人）", JSON.stringify(inviteC));

    const declinedC = await expectSnapshot(sC, () => sC.partyAction("decline"), "C 拒绝后的快照");
    check(!!declinedC && declinedC.partyId === "" && declinedC.members.length === 0, "拒绝后 C 仍是「没有队伍」", snap(declinedC));
    const declineAgain = await expectError(sC, () => sC.partyAction("decline"), "重复拒绝");
    checkEqual(declineAgain && declineAgain.code, 50126, "邀请被消费掉后不能再拒绝（50126）");
    check(!!inviteC && inviteC.partyId === acceptedB.partyId, "邀请帧带队伍 id（客户端据此认出「还是那支队」）");

    //#endregion

    //#region 三、满员与重复

    group("三、满员：上限读配置，第四个人进不来");
    sA.partyAction("invite", C.roleId);
    await waitFor("C 第二次收到邀请", async () => sC.invites.length >= 3 ? true : null);
    const acceptedC = await expectSnapshot(sC, () => sC.partyAction("accept"), "C 同意后的快照");
    check(!!acceptedC && acceptedC.members.length === 3, "三人满员（上限 3）", snap(acceptedC));

    const fullInvite = await expectError(sA, () => sA.partyAction("invite", D.roleId), "满员邀请");
    checkEqual(fullInvite && fullInvite.code, 50122, "满员拒邀（50122）");

    const alreadyIn = await expectError(sA, () => sA.partyAction("invite", C.roleId), "邀请已在队伍的人");
    checkEqual(alreadyIn && alreadyIn.code, 50123, "已在队伍里的人不能再被邀请（50123）");

    check(
      sD.partyFrames.every((frame) => frame.partyId === ""),
      "外人（D）从头到尾没收到过任何非空队伍快照",
      JSON.stringify(sD.partyFrames.map((frame) => frame.partyId)),
    );

    //#endregion

    //#region 四、权限与转让

    group("四、权限：踢 / 转让 / 解散只有队长能做，转让后权限翻转");
    const notLeader = await expectError(sB, () => sB.partyAction("kick", C.roleId), "非队长踢人");
    checkEqual(notLeader && notLeader.code, 50124, "非队长踢人被拒（50124）");

    const kickSelf = await expectError(sA, () => sA.partyAction("kick", A.roleId), "踢自己");
    checkEqual(kickSelf && kickSelf.code, 50125, "不能踢自己（50125，退出用 leave）");

    const kickOutsider = await expectError(sA, () => sA.partyAction("kick", D.roleId), "踢外人");
    checkEqual(kickOutsider && kickOutsider.code, 50125, "踢不在队里的人被拒（50125）");

    const transferToC = await expectSnapshot(sA, () => sA.partyAction("transfer", C.roleId), "A 转让后的快照");
    checkEqual(transferToC && transferToC.leaderRoleId, C.roleId, "转让后队长变成 C");
    checkEqual(transferToC && transferToC.isLeader, false, "原队长失去 isLeader");
    check(
      !!transferToC && transferToC.members.filter((member) => member.leader).length === 1,
      "同一时刻只有一个队长（成员表不存 is_leader，队长只有 leader_role_id 一个写者）",
      snap(transferToC),
    );

    const cIsLeader = await waitFor("C 收到自己成为队长的快照", async () =>
      sC.partyFrames.filter((frame) => frame.isLeader).slice(-1)[0] || null,
    );
    checkEqual(cIsLeader && cIsLeader.leaderRoleId, C.roleId, "新队长收到 isLeader=true 的快照");

    const oldLeaderKick = await expectError(sA, () => sA.partyAction("kick", B.roleId), "原队长再踢人");
    checkEqual(oldLeaderKick && oldLeaderKick.code, 50124, "转让后原队长不能再踢人（权限翻转）");

    const backToA = await expectSnapshot(sC, () => sC.partyAction("transfer", A.roleId), "C 把队长转回 A");
    checkEqual(backToA && backToA.leaderRoleId, A.roleId, "队长可以再转回去");

    sA.partyAction("kick", C.roleId);
    const kicked = await waitFor("C 收到被踢后的空快照", async () =>
      sC.partyFrames.filter((frame) => frame.partyId === "").slice(-1)[0] || null,
    );
    check(!!kicked && kicked.members.length === 0, "被踢的人收到空快照（客户端据此关面板、清队标）", snap(kicked));
    const afterKickAtA = await waitFor("A 的队里只剩 2 人", async () =>
      sA.partyFrames.filter((frame) => frame.members.length === 2).slice(-1)[0] || null,
    );
    check(!!afterKickAtA, "踢人后队伍人数减一（A 收到新快照）", snap(afterKickAtA));

    //#endregion

    //#region 五、队长退出自动移交

    group("五、队长退出：自动移交给最早加入的成员");
    const leftA = await expectSnapshot(sA, () => sA.partyAction("leave"), "A 退队后的快照");
    check(!!leftA && leftA.partyId === "", "退队的人收到空快照", snap(leftA));
    const handover = await waitFor("B 成为新队长", async () =>
      sB.partyFrames.filter((frame) => frame.isLeader && frame.members.length === 1).slice(-1)[0] || null,
    );
    check(!!handover && handover.leaderRoleId === B.roleId, "队长退出后由最早加入的剩余成员接任", snap(handover));

    const disbandSolo = await expectSnapshot(sB, () => sB.partyAction("disband"), "B 解散独自的队伍");
    check(!!disbandSolo && disbandSolo.partyId === "", "一个人也能解散（等价于退队）", snap(disbandSolo));

    //#endregion

    //#region 六、解散

    group("六、解散：三方同时收到空快照");
    sA.partyAction("invite", B.roleId);
    await waitInvite(sB, "B 收到邀请（重组）");
    await expectSnapshot(sB, () => sB.partyAction("accept"), "B 再次同意");
    sA.partyAction("invite", D.roleId);
    const dInvite = await waitInvite(sD, "D 收到邀请");
    check(!!dInvite, "新人能收到邀请（队伍重建后邀请链照旧）");
    await expectSnapshot(sD, () => sD.partyAction("accept"), "D 同意加入");
    const beforeDisband = await waitFor("A 的队里有 3 人", async () =>
      sA.partyFrames.filter((frame) => frame.members.length === 3).slice(-1)[0] || null,
    );
    check(!!beforeDisband, "解散前是 3 人队", snap(beforeDisband));

    const markA = sA.partyFrames.length;
    const markB = sB.partyFrames.length;
    const markD = sD.partyFrames.length;
    sA.partyAction("disband");
    const cleared = await waitFor("三方都收到空快照", async () => {
      const pick = (session, mark) => session.partyFrames.slice(mark).filter((frame) => frame.partyId === "").slice(-1)[0];
      return pick(sA, markA) && pick(sB, markB) && pick(sD, markD) ? true : null;
    });
    check(!!cleared, "解散后队长、两名成员都收到空快照（一次广播清三端）");
    check(
      [sA, sB, sD].every((session) => session.party === null || session.party.partyId === ""),
      "三端的「当前队伍」都变成空",
      [sA, sB, sD].map((session) => snap(session.party)).join(" | "),
    );
    const disbandByMember = await expectError(sB, () => sB.partyAction("disband"), "已无队伍时解散");
    checkEqual(disbandByMember && disbandByMember.code, 50121, "不在队伍里时解散被拒（50121）");

    //#endregion

    //#region 七、屏蔽优先（#398 的交叉）

    group("七、屏蔽优先：他拉黑我 → 说「不在线」；我拉黑他 → 明说先解除");
    await api(baseUrl, "POST", "social/blocks", { token: E.token, body: { roleId: A.roleId } });
    const blockedByTarget = await expectError(sA, () => sA.partyAction("invite", E.roleId), "邀请拉黑我的人");
    checkEqual(blockedByTarget && blockedByTarget.code, 50128, "他拉黑我时只说「对方不在线」（不说破，50128）");

    await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: E.roleId } });
    const blockedByMe = await expectError(sA, () => sA.partyAction("invite", E.roleId), "邀请我拉黑的人");
    checkEqual(blockedByMe && blockedByMe.code, 50130, "我拉黑他时明说「先解除」（50130）");

    //#endregion

    //#region 八、互见帧带队伍标记

    group("八、演出：互见帧带 partyId（队友金色名字 + 队标的原料）");
    sA.partyAction("invite", B.roleId);
    await waitInvite(sB, "B 收到邀请（演出组）");
    const teamSnapshot = await expectSnapshot(sB, () => sB.partyAction("accept"), "A/B 重新组队");
    check(!!teamSnapshot && teamSnapshot.partyId !== "", "A 与 B 重新组队", snap(teamSnapshot));
    const teamId = teamSnapshot.partyId;

    const bSeenWithParty = await waitFor("B 的 frame 里 A 带上了 partyId", async () => {
      for (let i = sB.players.length - 1; i >= 0; i -= 1) {
        const entry = sB.players[i].players.find((player) => player.roleId === A.roleId);
        if (entry && entry.partyId === teamId) return entry;
      }
      return null;
    });
    check(!!bSeenWithParty, "别人眼里的我带上了队伍 id（此刻同队）", bSeenWithParty && bSeenWithParty.partyId);

    const aSeenWithParty = await waitFor("A 的 frame 里 B 带上了 partyId", async () => {
      for (let i = sA.players.length - 1; i >= 0; i -= 1) {
        const entry = sA.players[i].players.find((player) => player.roleId === B.roleId);
        if (entry && entry.partyId === teamId) return entry;
      }
      return null;
    });
    check(!!aSeenWithParty, "双向都带上（同一支队的人互相看得见队标）");

    const bLeaveMark = sB.partyFrames.length;
    sB.partyAction("leave");
    const partyCleared = await waitFor("退队后互见帧的 partyId 变回空串", async () => {
      for (let i = sA.players.length - 1; i >= 0; i -= 1) {
        const entry = sA.players[i].players.find((player) => player.roleId === B.roleId);
        if (entry && entry.partyId === "") return entry;
      }
      return null;
    });
    check(!!partyCleared, "退队后别人的帧里立刻不再带队伍 id（队标消失）");
    void bLeaveMark;

    //#endregion

    //#region 九、经验分成

    group("九、经验分成：击杀者全额、同图队友 50%、异图与等级差过大的分不到");
    // 队伍：A（击杀者，1 级）+ B（同图，1 级）+ C（异图，1 级）
    // 邀请与同意是两条独立连接上的帧：**跨连接的到达顺序没有保证**，
    // 所以每次同意前都要先等到邀请真的到了（后面几条同理）
    sA.partyAction("invite", B.roleId);
    const expInviteB = await waitInvite(sB, "B 收到经验组的邀请");
    check(!!expInviteB, "B 收到组队邀请（经验组）");
    const expB = await expectSnapshot(sB, () => sB.partyAction("accept"), "B 入队（经验组）");
    check(!!expB && expB.members.length === 2, "经验组：B 入队后 2 人", snap(expB));
    sA.partyAction("invite", C.roleId);
    const expInviteC = await waitInvite(sC, "C 收到异图的邀请");
    check(!!expInviteC, "C 收到组队邀请（异图那一位）");
    const expC = await expectSnapshot(sC, () => sC.partyAction("accept"), "C 入队（异图）");
    check(!!expC && expC.members.length === 3, "经验组：C 入队后 3 人（A/B 同图、C 在另一张图）", snap(expC));

    // 队友的角色修订号基线（那笔入账要比它大 1）
    const bBefore = await api(baseUrl, "GET", `roles/${B.roleId}`, { token: B.token });
    const bRevisionBefore = bBefore.data && bBefore.data.revision;
    check(typeof bRevisionBefore === "number" && bRevisionBefore > 0, "读到队友的角色修订号基线");

    let castSeq = 0;
    /** 连打到这只怪死为止（返回那次 killed 的 settle 帧） */
    const kill = async (session, mob) => {
      for (let i = 0; i < 40; i += 1) {
        castSeq += 1;
        const id = castSeq;
        session.send("cast", { castId: id, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey });
        const settle = await waitFor(`castId=${id}`, async () => session.settles.find((frame) => frame.castId === id) || null);
        if (!settle) return null;
        if (settle.killed) return settle;
      }
      return null;
    };

    // 重新进图一次，拿最新的怪物实例（进图是幂等的，前面的分组只用过帧没用过怪）。
    // 取帧要按**标记之后**：`slice(-1)[0]` 会撞上一份旧快照，怪物可能已经死了
    let worldMark = sA.worldFrames.length;
    sA.send("worldJoin", { mapId: "1" });
    const worldFrame = await waitFor("A 的 world 快照", async () =>
      sA.worldFrames.length > worldMark ? sA.worldFrames[sA.worldFrames.length - 1] : null,
    );
    const mob = worldFrame && worldFrame.monsters.find((monster) => monster.alive);
    check(!!mob, "拿到一只活着的怪物实例", mob && mob.instanceId);

    const kill1 = await kill(sA, mob);
    check(!!kill1 && !!kill1.reward, "击杀后 settle 帧带 reward（经验在服务端结算）");
    const killerExp = kill1 && kill1.reward ? kill1.reward.exp : 0;
    // 1 级打 1 级怪：(1+1) × expPerLevel(5) × (1 - 0/6) = 10
    checkEqual(killerExp, 10, "击杀者拿全额（等级差 0 → 10 点）");

    const mateGain = await waitFor("B 收到队友经验帧", async () => sB.expGains.slice(-1)[0] || null);
    checkEqual(mateGain && mateGain.exp, Math.floor(killerExp / 2), "同图队友拿到击杀经验的一半（向下取整）");
    checkEqual(mateGain && mateGain.from.username, "甲队长", "expGain 带击杀者名字（飘字用）");
    checkEqual(mateGain && mateGain.from.roleId, A.roleId, "expGain 带击杀者角色 id");
    checkEqual(mateGain && mateGain.revision, bRevisionBefore + 1, "expGain 的 revision 是入账后的（客户端照搬做新基线）");

    const bAfter = await api(baseUrl, "GET", `roles/${B.roleId}`, { token: B.token });
    checkEqual(bAfter.data && bAfter.data.revision, mateGain && mateGain.revision, "队友那份经验真的落库了（修订号推进）");
    checkEqual(
      bAfter.data && Number(bAfter.data.data.exp),
      mateGain && mateGain.expNow,
      "客户端的经验值与服务端下发的 expNow 一致（不会各算各的）",
    );
    check(sC.expGains.length === 0, "异图队友分不到经验（一条 expGain 都没有）");
    check(
      !sA.expGains.some((gain) => gain.from.roleId === A.roleId),
      "击杀者自己不会收到 expGain（settle 里已经带了 reward，两条路会重复加经验）",
    );

    // 等级差过大：E 是 12 级，对 1 级怪的基数是 0，乘任何比例还是 0
    await api(baseUrl, "DELETE", `social/blocks/${E.roleId}`, { token: A.token });
    await api(baseUrl, "DELETE", `social/blocks/${A.roleId}`, { token: E.token });
    sA.partyAction("disband");
    await waitFor("A 解散经验组", async () => (sA.party && sA.party.partyId === "" ? true : null));
    sA.partyAction("invite", E.roleId);
    await waitInvite(sE, "E 收到邀请");
    const eJoined = await expectSnapshot(sE, () => sE.partyAction("accept"), "E 加入（等级差组）");
    check(!!eJoined && eJoined.members.length === 2, "A 与 12 级的 E 组成 2 人队", snap(eJoined));

    const eMark = sE.expGains.length;
    worldMark = sA.worldFrames.length;
    sA.send("worldJoin", { mapId: "1" });
    const world2 = await waitFor("A 的第二份 world 快照", async () =>
      sA.worldFrames.length > worldMark ? sA.worldFrames[sA.worldFrames.length - 1] : null,
    );
    const mob2 = world2 && world2.monsters.find((monster) => monster.alive);
    check(!!mob2, "还有活着的怪物可打", mob2 && mob2.instanceId);
    const kill2 = await kill(sA, mob2);
    check(!!kill2 && !!kill2.reward && kill2.reward.exp > 0, "击杀者照旧拿到经验（组队不减少他的那一份）", kill2 && kill2.reward && String(kill2.reward.exp));
    await sleep(300);
    checkEqual(sE.expGains.length, eMark, "等级差过大的队友一条 expGain 都没有（基数为 0）");

    //#endregion

    //#region 十、上限脏值回落

    // 只验「读配置」这一小段数学：起第二台服务要 30 秒，而这三种脏值用类本身就能钉死
    group("十、上限脏值回落（直接 new 服务类，不起第二台服务）");
    const { PartyService } = require(path.join(SERVER_DIR, "dist", "modules", "party", "party.service.js"));
    const dirtyConfig = (value) => new PartyService({}, {}, { get: () => value });
    checkEqual(dirtyConfig("abc").memberLimit(), 4, "非数字上限回落默认 4（不让组队变成「一个人就算满」）");
    checkEqual(dirtyConfig(1).memberLimit(), 4, "小于 2 的上限回落默认");
    checkEqual(dirtyConfig("6").memberLimit(), 6, "合法值（含数字字符串）照配置走");
    checkEqual(dirtyConfig(undefined).minLevel(), 10, "门槛未配置回落默认 10（与客户端入口 openLevel 同值）");
    checkEqual(dirtyConfig(0).minLevel(), 10, "小于 1 的门槛回落默认（读错不该让「所有人都不能组队」）");
    checkEqual(dirtyConfig("12").minLevel(), 12, "合法门槛（含数字字符串）照配置走");

    //#endregion

    //#region 十一、等级门槛（默认 10 级，独立进程）

    // 主进程把门槛压到 1 了，所以门槛**本身**得另起一台用默认配置验（#497）。
    // 这不是第十组那种纯数学：要验的是「真实链路上低等级会被拒」，必须走真的服务。
    group("十一、等级门槛：低等级发起 / 邀请低等级目标都拒（默认 10 级，独立进程）");
    const levelDbPath = path.join(os.tmpdir(), `olua-e2e-party-level-${Date.now()}.db`);
    const levelServer = await startServer(levelDbPath);
    try {
      const levelBase = levelServer.baseUrl;
      const levelWs = levelBase.replace("http", "ws");
      const low = await preparePlayer(levelBase, "party_level_low", "party_level_low", "低级号", 1);
      const highA = await preparePlayer(levelBase, "party_level_high_a", "party_level_high_a", "高级甲", 10);
      const highB = await preparePlayer(levelBase, "party_level_high_b", "party_level_high_b", "高级乙", 10);
      const levelTickets = await Promise.all(
        [low, highA, highB].map((player) => api(levelBase, "POST", "realtime/ticket", { token: player.token })),
      );
      const [sLow, sHighA, sHighB] = levelTickets.map((ticket) =>
        connect(`${levelWs}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`),
      );
      const levelWelcomed = await waitFor(
        "等级组三条连接都收到 welcome",
        async () => ([sLow, sHighA, sHighB].every((session) => session.welcomes.length > 0) ? true : null),
      );
      check(!!levelWelcomed, "等级组三条实时连接都握手成功");
      // 进图 + 位置上报：邀请要看「在线」（在场表里得有位置）
      for (const session of [sLow, sHighA, sHighB]) {
        session.send("worldJoin", { mapId: "1" });
        session.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
      }
      await sleep(200);

      // 1) 低等级发起：客户端入口锁着，改包也打不进来
      const lowInvite = await expectError(sLow, () => sLow.partyAction("invite", highA.roleId), "低级号发起邀请被拒");
      check(
        !!lowInvite && lowInvite.code === 50144 && lowInvite.message === "需要 10 级才能组队",
        "低等级发起邀请被拒：50144「需要 10 级才能组队」",
        JSON.stringify(lowInvite),
      );
      // 2) 拒了就是不成立：对方一条邀请帧都不该有（否则他打不开面板，邀请只能烂在那儿）
      await sleep(200);
      checkEqual(sHighA.invites.length, 0, "被拒的邀请不会送达对方（对方打不开面板，邀请会悬空）");
      // 3) 高等级邀请低等级：同样拒，且说清是「对方」不够级
      const highInvite = await expectError(sHighA, () => sHighA.partyAction("invite", low.roleId), "邀请低级号被拒");
      check(
        !!highInvite && highInvite.code === 50144 && highInvite.message.includes("对方还没到 10 级"),
        "邀请低等级目标被拒：50144 且文案指明是「对方」",
        JSON.stringify(highInvite),
      );
      // 4) 门槛不误伤：两个够级的照常组队
      sHighA.partyAction("invite", highB.roleId);
      await waitInvite(sHighB, "高级乙收到邀请");
      const paired = await expectSnapshot(sHighB, () => sHighB.partyAction("accept"), "高级乙入队");
      check(!!paired && paired.members.length === 2, "两个够级的角色照常组队（门槛不误伤）", snap(paired));
    } finally {
      levelServer.child.kill("SIGKILL");
      await sleep(100);
    }

    //#endregion
  } finally {
    server.child.kill("SIGKILL");
    await sleep(100);
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}：队伍（#399）—— ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) console.log(`失败项：\n- ${failures.join("\n- ")}`);
  assertExpectedCount();
  process.exitCode = failed > 0 ? 1 : 0;
})();
