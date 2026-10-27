#!/usr/bin/env node
/**
 * 聊天专项 e2e（server/test/e2e-chat.cjs，issue #395）
 *
 * 盯的不变量（改聊天转发 / 限频 / 频道准入后必须全绿）：
 * 一、世界频道：同图广播（发送者自己收到回显，**另一张图的人收不到**）；from 带
 *     accountId / roleId / username（客户端据此上色），正文经过净化（连续空白折叠）
 * 二、格式与限频：空消息 / 超长 / 不认识的频道 / 缺字段都被拒（error 帧，连接不断）；
 *     限频读配置（本套压到 3 条 / 1 秒），窗口过了又能发
 * 三、帮会频道：没帮会发不出去；帮会成员（含发送者）都收到、同图的外人收不到；
 *     from.guildName 是库里现查的帮会名
 * 四、私聊：双方都收到同一条帧（to 带收件人三件套）；查无此人 / 私聊自己 /
 *     缺对象 / **对方不在线**整条拒绝（发送者连回显都拿不到）
 *
 * 与 e2e-social 同款：**临时文件库**，票据走 HTTP、业务走 WS 帧。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 限频压到 3 条 / 1 秒：四条消息就能撞上限，不必等 10 秒的默认窗口 */
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 1000;
const MAX_LENGTH = 50;

//#region 断言小工具（与 e2e-social 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 35;

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

/** 起一台服务（文件库） */
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
      JWT_SECRET: "e2e-chat-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 限频与长度上限全走配置：验的是「读配置」而不是默认值
      CHAT_RATE_LIMIT: String(RATE_LIMIT),
      CHAT_RATE_WINDOW_MS: String(RATE_WINDOW_MS),
      CHAT_MAX_LENGTH: String(MAX_LENGTH),
      // 本套不发位置心跳（ waitFor 的空档会超过默认 3 秒的过期线）：
      // 在场条目按测试口径拉长到 60 秒，聊天准入（identityOf）才稳定可用
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

/** 一份最小可建号的角色文档（e2e-social 同款口径） */
function roleData(id, name) {
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag: [], skills: {} };
}

/** 注册账号 + 建一个在线角色，返回 { token, roleId } */
async function preparePlayer(baseUrl, username, roleId, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  await api(baseUrl, "POST", "roles", { token, body: { data: roleData(roleId, roleName) } });
  return { token, roleId };
}

/** 一条收集 chat / error 帧的 WS 连接 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    welcomes: [],
    chats: [],
    errors: [],
    worlds: 0,
    send(type, data) {
      session.socket.send(JSON.stringify({ type, data }));
    },
    /** 发一条聊天并等待它回显回来（返回回显帧；超时 null） */
    sayAndAwait: null,
  };
  socket.on("open", () => {
    session.opened = true;
  });
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
  const dbPath = path.join(os.tmpdir(), `olua-e2e-chat-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：三个账号，A/B 同图、C 在另一张图

    group("准备：三个账号（A/B 同图，C 在另一张图）");
    const A = await preparePlayer(baseUrl, "chat_player_a", "chat_role_a", "甲玩家");
    const B = await preparePlayer(baseUrl, "chat_player_b", "chat_role_b", "乙玩家");
    const C = await preparePlayer(baseUrl, "chat_player_c", "chat_role_c", "丙玩家");
    check(!!(A.token && B.token && C.token), "三个账号都注册并建好在线角色");

    const tickets = await Promise.all(
      [A, B, C].map((player) => api(baseUrl, "POST", "realtime/ticket", { token: player.token })),
    );
    check(tickets.every((ticket) => ticket.data && ticket.data.ticket), "三个账号都取到实时票据");
    const wsBase = baseUrl.replace("http", "ws");
    const sessionA = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[0].data.ticket)}`);
    const sessionB = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[1].data.ticket)}`);
    const sessionC = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[2].data.ticket)}`);
    const welcomed = await waitFor("三条连接都收到 welcome", async () =>
      sessionA.welcomes.length > 0 && sessionB.welcomes.length > 0 && sessionC.welcomes.length > 0 ? true : null,
    );
    check(!!welcomed, "三条实时连接都握手成功");

    sessionA.send("worldJoin", { mapId: "1" });
    sessionA.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    await sleep(120);
    sessionB.send("worldJoin", { mapId: "1" });
    sessionB.send("pos", { mapId: "1", x: 140, y: 200, hp: 100, moving: false });
    sessionC.send("worldJoin", { mapId: "2" });
    sessionC.send("pos", { mapId: "2", x: 100, y: 200, hp: 100, moving: false });
    await sleep(200);
    check(sessionA.worlds > 0 && sessionB.worlds > 0 && sessionC.worlds > 0, "三个会话都拿到了所在图的权威快照");

    //#endregion

    //#region 一、世界频道

    group("一、世界频道：同图广播 + 自己的回显 + 净化");
    sessionA.chats = [];
    sessionB.chats = [];
    sessionC.chats = [];
    sessionA.send("chat", { channel: "world", text: "  大家好，   世界频道  " });
    const worldEcho = await waitFor("A 收到自己的世界频道回显", async () =>
      sessionA.chats.find((entry) => entry.channel === "world" && entry.text.includes("大家好")) || null,
    );
    check(!!worldEcho, "A 收到回显（发送者自己也进广播列表——客户端只在收到帧时上屏）");
    checkEqual(worldEcho && worldEcho.from.username, "甲玩家", "回显带发送者角色名");
    check(
      !!worldEcho && typeof worldEcho.from.accountId === "string" && worldEcho.from.accountId.length > 0,
      "回显带发送者账号 id（客户端据此识别「是我发的」）",
      JSON.stringify(worldEcho && worldEcho.from),
    );
    checkEqual(worldEcho && worldEcho.text, "大家好， 世界频道", "正文被净化（首尾与连续空白折叠成一个空格）");

    const worldAtB = await waitFor("B 收到同图的世界消息", async () =>
      sessionB.chats.find((entry) => entry.channel === "world" && entry.from.username === "甲玩家") || null,
    );
    check(!!worldAtB, "同图的 B 收到世界消息");
    checkEqual(worldAtB && worldAtB.from.roleId, A.roleId, "帧带 roleId（客户端拿它做关系上色）");
    await sleep(150);
    checkEqual(sessionC.chats.length, 0, "另一张图的 C 收不到（世界频道 = 同图广播，issue 口径）");

    //#endregion

    //#region 二、格式与限频

    group("二、格式与限频：坏消息被拒、连接不断、上限读配置");
    sessionA.errors = [];
    sessionA.send("chat", { channel: "world", text: "   " });
    const emptyRejected = await waitFor("空白消息被拒", async () => sessionA.errors.length > 0 || null);
    check(!!emptyRejected, "纯空白消息被拒（不能为空）");
    checkEqual(sessionA.socket.readyState, WebSocket.OPEN, "被拒不断连接（error 帧语义）");

    sessionA.errors = [];
    sessionA.send("chat", { channel: "world", text: "长".repeat(MAX_LENGTH + 1) });
    const longRejected = await waitFor("超长消息被拒", async () => sessionA.errors.length > 0 || null);
    check(!!longRejected, `超过 CHAT_MAX_LENGTH（${MAX_LENGTH}）的消息被拒`);

    sessionA.errors = [];
    sessionA.send("chat", { channel: "galaxy", text: "你好" });
    const badChannel = await waitFor("不认识的频道被拒", async () => sessionA.errors.length > 0 || null);
    check(!!badChannel, "不认识的频道被拒（协议白名单在解析层）");

    sessionA.errors = [];
    sessionA.send("chat", { text: "缺频道" });
    const missingChannel = await waitFor("缺字段的 chat 被拒", async () => sessionA.errors.length > 0 || null);
    check(!!missingChannel, "缺 channel 的消息在解析层就被拒");

    // 限频：窗口 1 秒内放行 3 条，第 4 条被拒；窗口过了又能发。
    // 先等窗口清空——组一那条回显还在滑窗里占着一个名额，不清空这里只会放行 2 条
    await sleep(RATE_WINDOW_MS + 100);
    sessionA.errors = [];
    sessionA.chats = [];
    for (let i = 0; i < RATE_LIMIT; i++) sessionA.send("chat", { channel: "world", text: `限频第 ${i + 1} 条` });
    await waitFor("前三条都回显", async () => (sessionA.chats.length >= RATE_LIMIT ? true : null));
    checkEqual(sessionA.chats.length, RATE_LIMIT, `窗口内前 ${RATE_LIMIT} 条全部放行`);
    sessionA.errors = [];
    sessionA.send("chat", { channel: "world", text: "第 4 条应该被限" });
    const rateLimited = await waitFor("第 4 条被限", async () => sessionA.errors.some((error) => error.message.includes("频繁")) || null);
    check(!!rateLimited, `窗口 ${RATE_WINDOW_MS}ms 内超过 ${RATE_LIMIT} 条被限频`);
    await sleep(RATE_WINDOW_MS + 100);
    sessionA.errors = [];
    sessionA.chats = [];
    sessionA.send("chat", { channel: "world", text: "窗口过了，又能说了" });
    const afterWindow = await waitFor("窗口过后恢复放行", async () =>
      sessionA.chats.find((entry) => entry.text.includes("窗口过了")) || null,
    );
    check(!!afterWindow, "限频窗口过后恢复放行（滑窗不永久惩罚）");

    //#endregion

    //#region 三、帮会频道

    group("三、帮会频道：准入查库、成员广播、外人收不到");
    sessionA.errors = [];
    sessionA.chats = [];
    sessionA.send("chat", { channel: "guild", text: "还没帮会就想喊话" });
    const noGuild = await waitFor("没帮会发帮会频道被拒", async () => sessionA.errors.length > 0 || null);
    check(!!noGuild, "没帮会的人发帮会频道被拒（准入每次查库，不信缓存）");

    const guild = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "聊天帮" } });
    checkEqual(guild.code, 0, "A 建了帮会「聊天帮」");
    const applyB = await api(baseUrl, "POST", `guilds/${guild.data.id}/applications`, { token: B.token, body: { message: "收我" } });
    checkEqual(applyB.code, 0, "B 申请入帮");
    const approveB = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(approveB.code, 0, "A 通过了 B 的申请");

    sessionA.chats = [];
    sessionB.chats = [];
    sessionC.chats = [];
    sessionB.send("chat", { channel: "guild", text: "帮会的伙伴们好" });
    const guildAtB = await waitFor("B 收到帮会回显", async () =>
      sessionB.chats.find((entry) => entry.channel === "guild") || null,
    );
    check(!!guildAtB, "发送者收到帮会频道的回显");
    const guildAtA = await waitFor("A 收到帮会消息", async () =>
      sessionA.chats.find((entry) => entry.channel === "guild" && entry.from.username === "乙玩家") || null,
    );
    check(!!guildAtA, "同帮在线成员 A 收到（B 发的，A 是帮主）");
    checkEqual(guildAtA && guildAtA.from.guildName, "聊天帮", "from.guildName 是库里现查的帮会名");
    await sleep(150);
    checkEqual(sessionC.chats.filter((entry) => entry.channel === "guild").length, 0, "同图但没入帮的 C 收不到帮会频道");

    //#endregion

    //#region 四、私聊

    group("四、私聊：双方同帧、目标校验、离线整条拒绝");
    // 这一组的每一步都会被限频计数（allowSend 在频道分发之前）：
    // 步与步之间等窗口清空，否则后面的「拒绝」可能是限频的假阳性（判据纪律：错误消息要精确匹配）
    sessionA.chats = [];
    sessionB.chats = [];
    sessionA.send("chat", { channel: "private", text: "在吗", toRoleId: B.roleId });
    const privateAtB = await waitFor("B 收到私聊", async () =>
      sessionB.chats.find((entry) => entry.channel === "private" && entry.text === "在吗") || null,
    );
    check(!!privateAtB, "收件人 B 收到私聊");
    check(
      !!privateAtB && !!privateAtB.to && privateAtB.to.roleId === B.roleId && privateAtB.to.username === "乙玩家",
      "帧的 to 带收件人三件套（客户端会话按它分组）",
      JSON.stringify(privateAtB && privateAtB.to),
    );
    const privateEchoA = await waitFor("A 收到自己的私聊回显", async () =>
      sessionA.chats.find((entry) => entry.channel === "private") || null,
    );
    check(!!privateEchoA, "发送者 A 收到回显（与收件人同一条帧的形状）");

    await sleep(RATE_WINDOW_MS + 100);
    sessionA.errors = [];
    sessionA.send("chat", { channel: "private", text: "你在哪", toRoleId: "no_such_role" });
    const unknownTarget = await waitFor("查无此人被拒", async () =>
      sessionA.errors.find((error) => error.message.includes("查无此人")) || null,
    );
    check(!!unknownTarget, "私聊不存在的角色被拒");

    await sleep(RATE_WINDOW_MS + 100);
    sessionA.errors = [];
    sessionA.send("chat", { channel: "private", text: "自言自语", toRoleId: A.roleId });
    const selfTarget = await waitFor("私聊自己被拒", async () =>
      sessionA.errors.find((error) => error.message.includes("不能私聊自己")) || null,
    );
    check(!!selfTarget, "私聊自己被拒");

    await sleep(RATE_WINDOW_MS + 100);
    sessionA.errors = [];
    sessionA.send("chat", { channel: "private", text: "没有对象" });
    const noTarget = await waitFor("缺私聊对象被拒", async () =>
      sessionA.errors.find((error) => error.message.includes("缺少私聊对象")) || null,
    );
    check(!!noTarget, "私聊缺 toRoleId 被拒");

    // 对方不在线（连接断开）→ 整条拒绝：发送者连回显都拿不到
    await sleep(RATE_WINDOW_MS + 100);
    sessionB.socket.close();
    await waitFor("B 的连接真正断开", async () => (sessionB.socket.readyState === WebSocket.CLOSED ? true : null));
    await sleep(200); // 等服务端把 B 的连接清干净（清理走 close 事件）
    sessionA.errors = [];
    sessionA.chats = [];
    sessionA.send("chat", { channel: "private", text: "对面已经掉线了", toRoleId: B.roleId });
    const offlineRejected = await waitFor("对方离线的私聊被拒", async () =>
      sessionA.errors.find((error) => error.message.includes("对方不在线")) || null,
    );
    check(!!offlineRejected, "对方不在线时整条拒绝（不制造「发出去了但永远没人收到」）");
    checkEqual(sessionA.chats.length, 0, "被拒的私聊没有任何回显（没有半成功的状态）");

    sessionA.socket.close();
    sessionC.socket.close();

    //#endregion
  } finally {
    server.child.kill();
  }

  assertExpectedCount();
  if (failed > 0) {
    console.log(`\n❌ 聊天 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 聊天 e2e：${passed} 条全绿`);
  }
})();
