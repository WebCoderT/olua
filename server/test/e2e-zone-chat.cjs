#!/usr/bin/env node
/**
 * 聊天带区 e2e（server/test/e2e-zone-chat.cjs，issue #958 / docs/39 §3.3）
 *
 * 盯的不变量（社交收成「同区」之后必须全绿）：
 * 一、世界频道只投给**本区**：1 区的消息不进 2 区的连接（同图也不行 —— 区在房间键最前面）
 * 二、同图频道按**房号**（`zone:map:slot`）投递：两个区同在「1 图」也互相看不见
 * 三、私聊只在同区找人：跨区 roleId 与「查无此人」同一种拒绝（不泄露别区有没有这个 id）
 * 四、帮会频道：帮会属于哪个区就只在哪个区喊（成员同区是入口保证，这条是兜底）
 *
 * 为什么单独一条：`e2e-chat` 验的是「频道语义」（世界 / 同图 / 帮会 / 私聊的收件人口径），
 * 它只有一个区，**区这一维永远覆盖不到** —— 而世界频道收件人正是「跨区攻击」最好用的入口。
 *
 * 与 e2e-chat 同款：**临时文件库**，票据走 HTTP、业务走 WS 帧。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { relaxGuildGate } = require("./lib/guild-gate.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-chat 同款口径）

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
      JWT_SECRET: "e2e-zone-chat-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-chat-admin-code",
      // 限频放宽：本套每条消息只发一次，被「太频繁」挡掉会变成假阳性
      CHAT_RATE_LIMIT: "50",
      CHAT_RATE_WINDOW_MS: "10000",
      // 本套不发位置心跳：在场条目按测试口径拉长，聊天准入（identityOf）才稳定可用
      MONSTER_AI_POS_STALE_MS: "60000",
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

/** 注册账号 + 建一个在线角色（区 = 账号当前浏览区），返回 { token, roleId, zoneId } */
async function preparePlayer(baseUrl, username, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token, roleId: created.data && created.data.id, zoneId: created.data && created.data.zoneId };
}

/** 一条收集 chat / error 帧的 WS 连接 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    welcomes: [],
    chats: [],
    errors: [],
    worlds: 0,
    send(type, data) {
      session.socket.send(JSON.stringify({ type, data }));
    },
  };
  socket.on("open", () => {});
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "chat") session.chats.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
      if (frame.type === "world") session.worlds += 1;
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-chat-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：一区两人 + 二区一人，**三个人站同一张图**

    group("准备：一区 A/B、二区 C —— 三人都在「1 图」");
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_chat_super", password: "super-pass-1", registerCode: "zone-chat-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id, "开一个二区", JSON.stringify(zone2.data));

    const A = await preparePlayer(baseUrl, "zc_player_a", "区聊甲");
    const B = await preparePlayer(baseUrl, "zc_player_b", "区聊乙");
    const C = await preparePlayer(baseUrl, "zc_player_c", "区聊丙");
    check(!!(A.token && B.token && C.token), "三个账号都注册并建好在线角色");
    checkEqual(A.zoneId, 1, "A 的角色在 1 区");
    checkEqual(B.zoneId, 1, "B 的角色在 1 区");

    // C 切到二区再建角：跨区建角是「换一组角色」，不是搬家
    const selectC = await api(baseUrl, "POST", "zones/select", { token: C.token, body: { zoneId: zone2Id } });
    checkEqual(selectC.data && selectC.data.zoneId, zone2Id, "C 切到二区");
    const cRole = await api(baseUrl, "POST", "roles", { token: C.token, body: { name: "区聊丙二区", occupation: "1", sex: "1" } });
    check(!!(cRole.data && cRole.data.id), "C 在二区建了角色", cRole.message);
    checkEqual(cRole.data && cRole.data.zoneId, zone2Id, "C 在二区建的角色确实属于二区");
    C.roleId = cRole.data && cRole.data.id;

    // #859 起只准进「服务端记下的那张图」：三个人都先摆到 1 图（准备动作，不是被测逻辑）
    placeRolesAt(dbPath, "1", ["区聊甲", "区聊乙", "区聊丙二区"]);
    relaxGuildGate(dbPath);

    const tickets = await Promise.all(
      [A, B, C].map((player) => api(baseUrl, "POST", "realtime/ticket", { token: player.token })),
    );
    check(tickets.every((ticket) => ticket.data && ticket.data.ticket), "三个账号都取到实时票据");
    const wsBase = baseUrl.replace("http", "ws");
    const sA = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[0].data.ticket)}`);
    const sB = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[1].data.ticket)}`);
    const sC = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[2].data.ticket)}`);
    const welcomed = await waitFor("三条连接都收到 welcome", async () =>
      sA.welcomes.length > 0 && sB.welcomes.length > 0 && sC.welcomes.length > 0 ? true : null,
    );
    check(!!welcomed, "三条实时连接都握手成功");

    sA.send("worldJoin", { mapId: "1" });
    sA.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    await sleep(120);
    sB.send("worldJoin", { mapId: "1" });
    sB.send("pos", { mapId: "1", x: 140, y: 200, hp: 100, moving: false });
    await sleep(120);
    sC.send("worldJoin", { mapId: "1" });
    sC.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    const joined = await waitFor("三个会话都拿到所在图快照", async () =>
      sA.worlds > 0 && sB.worlds > 0 && sC.worlds > 0 ? true : null,
    );
    check(!!joined, "三个会话都进了「1 图」（两个区各一份自己的世界）");

    //#endregion

    //#region 一、世界频道按区

    group("一、世界频道：同区的收到、别区的收不到（三人同图）");
    sA.chats = [];
    sB.chats = [];
    sC.chats = [];
    sA.send("chat", { channel: "world", text: "一区的世界喊话" });
    const echoA = await waitFor("A 收到自己的世界回显", async () =>
      sA.chats.find((entry) => entry.channel === "world" && entry.text.includes("一区的世界喊话")) || null,
    );
    check(!!echoA, "A 收到自己的回显（发送者天然在收件人集合里）");
    const worldB = await waitFor("同区的 B 收到", async () =>
      sB.chats.find((entry) => entry.channel === "world" && entry.text.includes("一区的世界喊话")) || null,
    );
    check(!!worldB, "同区同图的 B 收到世界消息");
    await sleep(200);
    checkEqual(
      sC.chats.filter((entry) => entry.channel === "world").length,
      0,
      "二区的 C 收不到（同图也不行 —— 世界频道的收件人是「本区在场者」）",
    );

    group("二、反向：二区发的一区也收不到");
    sA.chats = [];
    sB.chats = [];
    sC.chats = [];
    sC.send("chat", { channel: "world", text: "二区的世界喊话" });
    const echoC = await waitFor("C 收到自己的回显", async () =>
      sC.chats.find((entry) => entry.channel === "world" && entry.text.includes("二区的世界喊话")) || null,
    );
    check(!!echoC, "C 收到自己的回显（二区世界频道照常可用）");
    await sleep(200);
    checkEqual(
      sA.chats.filter((entry) => entry.channel === "world").length,
      0,
      "一区的 A 收不到二区的世界消息",
    );
    checkEqual(
      sB.chats.filter((entry) => entry.channel === "world").length,
      0,
      "一区的 B 也收不到",
    );

    //#endregion

    //#region 二、同图频道按房号

    group("三、同图频道：同区同图收到、跨区同图收不到");
    sA.chats = [];
    sB.chats = [];
    sC.chats = [];
    sA.send("chat", { channel: "map", text: "一区同图的招呼" });
    const mapEchoA = await waitFor("A 收到同图回显", async () =>
      sA.chats.find((entry) => entry.channel === "map" && entry.text.includes("一区同图的招呼")) || null,
    );
    check(!!mapEchoA, "A 收到同图频道回显");
    const mapB = await waitFor("同区的 B 收到同图消息", async () =>
      sB.chats.find((entry) => entry.channel === "map" && entry.text.includes("一区同图的招呼")) || null,
    );
    check(!!mapB, "同区同图的 B 收到同图频道");
    await sleep(200);
    checkEqual(
      sC.chats.filter((entry) => entry.channel === "map").length,
      0,
      "二区的 C 同在「1 图」也收不到（房号是 zone:map:slot）",
    );

    //#endregion

    //#region 三、私聊跨区

    group("四、私聊：跨区 roleId 与「查无此人」同一种拒绝");
    sA.chats = [];
    sA.errors = [];
    sA.send("chat", { channel: "private", text: "跨区私聊", toRoleId: C.roleId });
    const crossPrivate = await waitFor("跨区私聊被拒", async () =>
      sA.errors.find((error) => error.message.includes("查无此人")) || null,
    );
    check(!!crossPrivate, "拿别区的 roleId 私聊 → 「查无此人」（不泄露这个 id 存在）");
    checkEqual(sA.chats.length, 0, "被拒的私聊没有任何回显（没有半成功状态）");
    await sleep(150);
    checkEqual(sC.chats.filter((entry) => entry.channel === "private").length, 0, "二区的 C 一条私聊都没收到");

    group("五、同区私聊照旧");
    sA.chats = [];
    sB.chats = [];
    sA.send("chat", { channel: "private", text: "同区悄悄话", toRoleId: B.roleId });
    const privateB = await waitFor("B 收到私聊", async () =>
      sB.chats.find((entry) => entry.channel === "private" && entry.text === "同区悄悄话") || null,
    );
    check(!!privateB, "同区的 B 正常收到私聊（区边界没有误伤）");
    checkEqual(privateB && privateB.to && privateB.to.roleId, B.roleId, "帧的 to 带收件人 roleId");

    //#endregion

    //#region 四、帮会频道

    group("六、帮会频道：帮会在 1 区，二区的人进不来也喊不到");
    const guild = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "区聊帮" } });
    checkEqual(guild.code, 0, "A 在 1 区建了帮会「区聊帮」");
    checkEqual(guild.data && guild.data.zoneId, 1, "建出来的帮会 zoneId = 1（绑建帮人的区）");
    const applyB = await api(baseUrl, "POST", `guilds/${guild.data.id}/applications`, { token: B.token, body: { message: "同区申请" } });
    checkEqual(applyB.code, 0, "同区的 B 申请入帮成功");
    const approveB = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, {
      token: A.token,
      body: { approve: true },
    });
    checkEqual(approveB.code, 0, "A 通过了 B 的申请");

    sA.chats = [];
    sB.chats = [];
    sC.chats = [];
    sB.send("chat", { channel: "guild", text: "帮会频道同区喊话" });
    const guildAtA = await waitFor("帮主 A 收到帮会消息", async () =>
      sA.chats.find((entry) => entry.channel === "guild" && entry.text.includes("帮会频道同区喊话")) || null,
    );
    check(!!guildAtA, "同帮同区的 A 收到帮会频道");
    checkEqual(guildAtA && guildAtA.from.guildName, "区聊帮", "from.guildName 是库里现查的帮会名");
    await sleep(200);
    checkEqual(sC.chats.filter((entry) => entry.channel === "guild").length, 0, "二区的 C 收不到别区帮会的频道");

    sC.errors = [];
    sC.send("chat", { channel: "guild", text: "二区也能喊吗" });
    const noGuildC = await waitFor("二区 C 没帮会，被拒", async () =>
      sC.errors.find((error) => error.message.includes("帮会频道不可用")) || null,
    );
    check(!!noGuildC, "二区的 C 没有帮会 → 帮会频道被拒（帮会不跨区，成员表也查不到他）");

    sA.socket.close();
    sB.socket.close();
    sC.socket.close();

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 聊天带区 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 聊天带区 e2e：${passed} 条全绿`);
  }
})();
