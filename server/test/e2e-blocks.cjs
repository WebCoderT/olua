#!/usr/bin/env node
/**
 * 屏蔽与举报专项 e2e（server/test/e2e-blocks.cjs，issue #398）
 *
 * 盯的不变量（改屏蔽过滤 / 举报落库 / 社交快照后必须全绿）：
 * 一、拉黑接口与快照：单向写库；**我拿得到「我拉黑的」，对方拿不到「谁拉黑了我」**；
 *     重复拉黑 50117 / 拉黑自己 50110 / 查无此人 50109
 * 二、好友关系被剪：拉黑一个好友，双方的好友关系同时消失（否则「好友」标签比拉黑还硬）
 * 三、聊天过滤（服务端执行）：收件人拉黑了发送者 → 收不到世界 / 帮会消息；
 *     私聊两个方向都挡，但**说法不同**（被拉黑的一方只看到「不在线」）
 * 四、互见过滤：被拉黑的人不再出现在我的 players 帧里（增量与 full 快照都要）
 * 五、解除拉黑后恢复：消息与位置重新出现；解除一个没拉黑的人 50118
 * 六、举报：只落库（同一对只留一条待处理 50120）、自举报 50110、管理端只读列表能查到
 *
 * 与 e2e-chat 同款：**临时文件库**，票据走 HTTP、业务走 WS 帧。
 * 关键配置 `SOCIAL_BLOCK_CACHE_MS=0`：关掉过滤缓存，让「拉黑立即生效」可被断言
 * （生产默认 2 秒，那一层由 BlockService 的懒刷新负责）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理端注册邀请码（与 startServer 的 ADMIN_REGISTER_CODE 同值） */
const ADMIN_CODE = "blocks-admin-code";

//#region 断言小工具（与 e2e-chat 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 50;

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
      JWT_SECRET: "e2e-blocks-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      // 限频放宽：本套要连发十来条聊天，压到默认值会撞上限
      CHAT_RATE_LIMIT: "50",
      CHAT_RATE_WINDOW_MS: "1000",
      // 屏蔽过滤关缓存：拉黑要能在下一条帧上立即生效
      SOCIAL_BLOCK_CACHE_MS: "0",
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

/** 发一次请求，返回统一包裹体（code / message / data） */
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

/** 一份最小可建号的角色文档（e2e-chat 同款口径） */
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

/** 一条收集 chat / error / players 帧的 WS 连接 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    founded: false,
    welcomes: [],
    chats: [],
    errors: [],
    players: [],
    worlds: 0,
    send(type, data) {
      session.socket.send(JSON.stringify({ type, data }));
    },
  };
  socket.on("open", () => {
    session.founded = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "chat") session.chats.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
      if (frame.type === "players") session.players.push(frame.data);
      if (frame.type === "world") session.worlds += 1;
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {});
  return session;
}

/** 某个会话收到的 players 帧里，出现过多少次某个角色（增量条目；按 roleId 认人） */
function playerEntries(session, roleId) {
  const hits = [];
  for (const frame of session.players) {
    for (const entry of frame.players) if (entry.roleId === roleId) hits.push(entry);
  }
  return hits;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-blocks-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：三个玩家（同图）+ 一个管理员

    group("准备：三个玩家（A/B/C 同图）+ 一个管理员");
    const A = await preparePlayer(baseUrl, "blocks_player_a", "blocks_role_a", "甲玩家");
    const B = await preparePlayer(baseUrl, "blocks_player_b", "blocks_role_b", "乙玩家");
    const C = await preparePlayer(baseUrl, "blocks_player_c", "blocks_role_c", "丙玩家");
    check(!!(A.token && B.token && C.token), "三个玩家账号都注册并建好在线角色");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "blocks_admin", password: "admin-pass-1", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    check(!!adminToken, "管理员注册成功（第一个注册的自动是超级管理员）");

    const tickets = await Promise.all(
      [A, B, C].map((player) => api(baseUrl, "POST", "realtime/ticket", { token: player.token })),
    );
    const wsBase = baseUrl.replace("http", "ws");
    const sessionA = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[0].data.ticket)}`);
    const sessionB = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[1].data.ticket)}`);
    const sessionC = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(tickets[2].data.ticket)}`);
    const welcomed = await waitFor("三条连接都收到 welcome", async () =>
      sessionA.welcomes.length && sessionB.welcomes.length && sessionC.welcomes.length ? true : null,
    );
    check(!!welcomed, "三条实时连接都握手成功");

    // 三人同图（拉黑前的 baseline：互相看得见）
    sessionA.send("worldJoin", { mapId: "1" });
    sessionA.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    sessionB.send("worldJoin", { mapId: "1" });
    sessionB.send("pos", { mapId: "1", x: 140, y: 200, hp: 100, moving: false });
    sessionC.send("worldJoin", { mapId: "1" });
    sessionC.send("pos", { mapId: "1", x: 180, y: 200, hp: 100, moving: false });
    await sleep(250);

    const baseline = await waitFor("C 的 full 快照里有 A（拉黑前的 baseline）", async () => {
      const full = sessionC.players.find((frame) => frame.full);
      if (!full) return null;
      return full.players.some((entry) => entry.roleId === A.roleId) ? full : null;
    });
    check(!!baseline, "同图互见的 baseline 已建立（C 看得见 A）");

    //#endregion

    //#region 一、拉黑接口与快照

    group("一、拉黑接口与快照（单向：我拿得到，对方拿不到）");

    const initial = await api(baseUrl, "GET", "social/me", { token: A.token });
    checkEqual(initial.data.blocks.length, 0, "初始黑名单为空");

    const blocked = await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: B.roleId } });
    checkEqual(blocked.code, 0, "A 拉黑 B 成功");
    checkEqual(blocked.data.blocks.length, 1, "返回的快照里黑名单有 1 条");
    checkEqual(blocked.data.blocks[0].roleId, B.roleId, "黑名单里是 B 的角色 id");
    checkEqual(blocked.data.blocks[0].name, "乙玩家", "黑名单带对方角色名（列表直接可显示）");

    const bView = await api(baseUrl, "GET", "social/me", { token: B.token });
    checkEqual(bView.data.blocks.length, 0, "B 的黑名单是空的 —— **他看不到「谁拉黑了我」**");
    checkEqual(bView.data.myRoleId, B.roleId, "B 的快照仍然只有自己的信息（屏蔽不回传）");

    const dup = await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: B.roleId } });
    checkEqual(dup.code, 50117, "重复拉黑 → 50117");

    const self = await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: A.roleId } });
    checkEqual(self.code, 50110, "拉黑自己 → 50110");

    const ghost = await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: "no_such_role" } });
    checkEqual(ghost.code, 50109, "拉黑不存在的角色 → 50109");

    //#endregion

    //#region 二、聊天过滤（服务端执行，不是客户端猜的）

    group("二、聊天过滤：收件人拉黑了发送者就收不到");

    sessionA.chats = [];
    sessionB.chats = [];
    sessionC.chats = [];
    sessionB.send("chat", { channel: "world", text: "乙说话" });
    const atC = await waitFor("C 收到 B 的世界消息", async () =>
      sessionC.chats.find((entry) => entry.text === "乙说话") || null,
    );
    check(!!atC, "第三人 C 照常收到 B 的消息（屏蔽只影响拉黑者）");
    await sleep(200);
    checkEqual(sessionA.chats.filter((entry) => entry.text === "乙说话").length, 0, "A 收不到 B 的世界消息");

    sessionA.chats = [];
    sessionB.chats = [];
    sessionA.send("chat", { channel: "world", text: "甲说话" });
    const echoAtA = await waitFor("A 收到自己的回显", async () =>
      sessionA.chats.find((entry) => entry.text === "甲说话") || null,
    );
    check(!!echoAtA, "发送者自己的回显不受屏蔽影响（单向过滤）");
    const atB = await waitFor("B 收到 A 的消息", async () => sessionB.chats.find((entry) => entry.text === "甲说话") || null);
    check(!!atB, "**单向**：B 仍然收得到 A 的消息（屏蔽不是「互相拉黑」，也不告诉对方被拉黑了）");

    sessionA.errors = [];
    sessionB.errors = [];
    sessionB.send("chat", { channel: "private", text: "私聊你", toRoleId: A.roleId });
    const rejectToSender = await waitFor("B 私聊 A 被拒", async () => sessionB.errors[0] || null);
    checkEqual(rejectToSender && rejectToSender.message, "对方不在线，消息没有送达", "被拉黑的一方只看到「不在线」（不暴露屏蔽）");
    await sleep(150);
    checkEqual(sessionA.chats.filter((entry) => entry.text === "私聊你").length, 0, "A 收不到这条私聊");

    sessionA.errors = [];
    sessionA.send("chat", { channel: "private", text: "反向私聊", toRoleId: B.roleId });
    const rejectToBlocker = await waitFor("A 私聊 B 被拒", async () => sessionA.errors[0] || null);
    checkEqual(rejectToBlocker && rejectToBlocker.message, "你已把对方拉黑，先解除才能私聊", "拉黑者这边说清楚原因（这是自己的设置）");

    //#endregion

    //#region 三、互见过滤（增量 + full 快照）

    group("三、互见过滤：被拉黑的人不再出现在我的 players 帧里");

    sessionA.players = [];
    sessionC.players = [];
    sessionB.send("pos", { mapId: "1", x: 240, y: 260, hp: 100, moving: true });
    const seenByC = await waitFor("C 收到 B 的位置增量", async () => playerEntries(sessionC, B.roleId)[0] || null);
    check(!!seenByC && seenByC.x === 240, "C 照常收到 B 的位置（同图其他人都正常）", JSON.stringify(seenByC));
    await sleep(250);
    checkEqual(playerEntries(sessionA, B.roleId).length, 0, "A 收不到 B 的任何互见条目");

    sessionA.players = [];
    sessionA.send("worldJoin", { mapId: "1" });
    const fullForA = await waitFor("A 重进图拿到 full 快照", async () => sessionA.players.find((frame) => frame.full) || null);
    const fullIds = fullForA ? fullForA.players.map((entry) => entry.accountId) : [];
    check(!!fullForA, "A 重进图后收到 full 快照（进图本身是幂等的）");
    check(fullIds.length > 0, "full 快照里有其他人（C 还在，说明不是「什么都滤掉了」）", `ids=${fullIds.join(",")}`);
    check(fullIds.indexOf(B.roleId) < 0, "**full 快照同样过滤**：A 看不到 B（否则重进图就把他带回来了）");

    //#endregion

    //#region 四、解除拉黑后恢复

    group("四、解除拉黑：消息与位置重新出现");

    const unblocked = await api(baseUrl, "DELETE", `social/blocks/${B.roleId}`, { token: A.token });
    checkEqual(unblocked.code, 0, "A 解除拉黑 B");
    checkEqual(unblocked.data.blocks.length, 0, "解除后黑名单为空");

    sessionA.chats = [];
    sessionB.send("chat", { channel: "world", text: "解除后说话" });
    const backAtA = await waitFor("A 又收到 B 的消息", async () =>
      sessionA.chats.find((entry) => entry.text === "解除后说话") || null,
    );
    check(!!backAtA, "解除拉黑后消息恢复（过滤读的是当前库，不是一次性快照）");

    sessionA.players = [];
    sessionB.send("pos", { mapId: "1", x: 260, y: 300, hp: 100, moving: true });
    const backSeen = await waitFor("A 又收到 B 的位置", async () => playerEntries(sessionA, B.roleId)[0] || null);
    check(!!backSeen && backSeen.x === 260, "解除拉黑后互见恢复", JSON.stringify(backSeen));

    const notBlocked = await api(baseUrl, "DELETE", `social/blocks/${B.roleId}`, { token: A.token });
    checkEqual(notBlocked.code, 50118, "解除一个没拉黑的人 → 50118");

    //#endregion

    //#region 五、拉黑会剪掉好友关系

    group("五、拉黑一个好友：双方的好友关系同时消失");

    const added = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: B.roleId } });
    checkEqual(added.data.outgoing.length, 1, "A 向 B 发出好友申请（待处理 1 条）");
    const accepted = await api(baseUrl, "POST", `social/friends/${A.roleId}/accept`, { token: B.token });
    checkEqual(accepted.data.friends.length, 1, "B 同意后双方成为好友");

    const blockedFriend = await api(baseUrl, "POST", "social/blocks", { token: A.token, body: { roleId: B.roleId } });
    checkEqual(blockedFriend.data.friends.length, 0, "拉黑后 A 这边的好友关系被剪掉");
    checkEqual(blockedFriend.data.blocks.length, 1, "同时进了黑名单");
    const bAfter = await api(baseUrl, "GET", "social/me", { token: B.token });
    checkEqual(bAfter.data.friends.length, 0, "B 那边的好友关系也一起消失（不能留一条「好友」标签比拉黑还硬）");

    //#endregion

    //#region 六、举报（落库 + 管理端只读列表）

    group("六、举报：只落库、不自动处罚、不通知被举报人");

    const reported = await api(baseUrl, "POST", "social/reports", {
      token: C.token,
      body: { roleId: B.roleId, category: "abuse", reason: "在世界频道刷屏辱骂" },
    });
    checkEqual(reported.code, 0, "C 举报 B（骚扰辱骂）成功");
    checkEqual(reported.data, null, "举报接口没有业务数据（data 恒为 null）");

    const again = await api(baseUrl, "POST", "social/reports", {
      token: C.token,
      body: { roleId: B.roleId, category: "cheat" },
    });
    checkEqual(again.code, 50120, "同一对重复举报 → 50120（只留一条待处理）");

    const reportSelf = await api(baseUrl, "POST", "social/reports", {
      token: C.token,
      body: { roleId: C.roleId, category: "other" },
    });
    checkEqual(reportSelf.code, 50110, "举报自己 → 50110");

    const reportGhost = await api(baseUrl, "POST", "social/reports", {
      token: C.token,
      body: { roleId: "no_such_role", category: "other" },
    });
    checkEqual(reportGhost.code, 50109, "举报不存在的角色 → 50109");

    const badCategory = await api(baseUrl, "POST", "social/reports", {
      token: C.token,
      body: { roleId: B.roleId, category: "whatever" },
    });
    check(badCategory.code !== 0, "非法类别被 DTO 挡下（固定枚举，不开放自由分类）", `code=${badCategory.code}`);

    const adminList = await api(baseUrl, "GET", "admin/reports?page=1&size=10", { token: adminToken });
    checkEqual(adminList.code, 0, "管理端能查举报列表");
    checkEqual(adminList.data.total, 1, "列表里只有那一条（重复举报没有落第二条）");
    const first = adminList.data.list[0];
    checkEqual(first && first.targetRoleId, B.roleId, "被举报人是 B");
    checkEqual(first && first.targetName, "乙玩家", "列表带被举报人角色名（查询时 join 出来的）");
    checkEqual(first && first.categoryLabel, "骚扰辱骂", "类别中文名由服务端给（界面不自己映射）");
    checkEqual(first && first.status, "pending", "状态是待处理（v1 只写 pending）");

    const filtered = await api(baseUrl, "GET", `admin/reports?keyword=${encodeURIComponent("丙玩家")}`, { token: adminToken });
    checkEqual(filtered.data.total, 1, "按举报人角色名也能搜到（名字与 id 都进关键字）");

    const playerOnAdmin = await api(baseUrl, "GET", "admin/reports", { token: C.token });
    checkEqual(playerOnAdmin.code, 40101, "玩家令牌打管理端接口 → 40101（受众不同，令牌根本不被认）");

    //#endregion

    assertExpectedCount();
    if (failed > 0) {
      console.log(`\n❌ 屏蔽与举报 e2e 失败 ${failed} 条：\n   - ${failures.join("\n   - ")}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ 屏蔽与举报 e2e 全绿（${passed} 条断言）`);
    }
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
  }
})();
