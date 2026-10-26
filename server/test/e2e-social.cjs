#!/usr/bin/env node
/**
 * 社交（好友与敌人）专项 e2e（server/test/e2e-social.cjs，issue #389）
 *
 * 盯的不变量（改好友 / 敌人 / 互见帧后必须全绿）：
 * 一、加好友：申请只写「我加别人」，对方 incoming 立刻可见；**对方也在等我时直接当同意**
 *     （不用再点一次）；同意后两边都进 friends（status=accepted）；好友上限**读配置**
 *     （本套把 SOCIAL_FRIEND_LIMIT 压到 2 来验，不复用默认 100）
 * 二、拒绝 / 撤回 / 删除：拒绝**不留痕**（两边都查不到，可以重新申请）；
 *     撤回（删 pending）与删好友走同一个接口；删好友**双向消失**；没有关系时 50112
 * 三、敌人：**单向**（我标了，对方的 enemies 仍为空）；重复标 50113、未标就解 50114
 * 四、按名字加人：找不到 50109、同名多个 50116（角色名只在同账号内唯一）、对自己 50110
 * 五、镜像两行：库里不存在「只有单向」的好友行（每对的两行 status 一致）
 * 六、互见帧：`players` 帧里的条目带 roleId / guildId / guildName（客户端据此算关系上色）
 *
 * 用**临时文件库**：第五组要直接开库比对镜像行。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 本套把好友上限定成 2：三个人就能撞到上限，不必造一百个账号 */
const FRIEND_LIMIT = 2;

//#region 断言小工具（与 e2e-guild 同款口径）

const failures = [];
let passed = 0;
let failed = 0;
const EXPECTED_ASSERTIONS = 47;

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
      JWT_SECRET: "e2e-social-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 好友上限压到 2：验的是「上限读配置」而不是那个默认值
      SOCIAL_FRIEND_LIMIT: String(FRIEND_LIMIT),
      // 互见广播调快一点：第六组不必等 200ms 的节拍
      PLAYER_SYNC_BROADCAST_MS: "80",
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

/** 一份最小可建号的角色文档（e2e-guild 同款口径） */
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

/** 一条收集 players 帧的 WS 连接 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    welcomes: [],
    players: [],
    send(type, data) {
      session.socket.send(JSON.stringify({ type, data }));
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.welcomes.push(frame.data);
      if (frame.type === "players") session.players.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-social-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：五个玩家（其中两个角色同名）

    group("准备：五个账号（两个角色故意同名）");
    const A = await preparePlayer(baseUrl, "social_player_a", "social_role_a", "甲玩家");
    const B = await preparePlayer(baseUrl, "social_player_b", "social_role_b", "乙玩家");
    const C = await preparePlayer(baseUrl, "social_player_c", "social_role_c", "丙玩家");
    const D = await preparePlayer(baseUrl, "social_player_d", "social_role_d", "丁玩家");
    // 角色名只在同一账号内唯一：两个账号各有一个「同名者」，按名字加人必然撞上
    const E1 = await preparePlayer(baseUrl, "social_player_e1", "social_role_e1", "同名者");
    const E2 = await preparePlayer(baseUrl, "social_player_e2", "social_role_e2", "同名者");
    check(!!(A.token && B.token && C.token && D.token && E1.token && E2.token), "五个账号都注册并建好在线角色");

    const mineA0 = await api(baseUrl, "GET", "social/me", { token: A.token });
    check(mineA0.code === 0 && mineA0.data.friends.length === 0, "初始快照：好友为空（不是 null）");
    checkEqual(mineA0.data.myRoleId, A.roleId, "快照带我的角色 id（客户端拿它比「是不是我自己」）");

    //#endregion

    //#region 一、申请 / 互加直接同意 / 同意 / 上限

    group("一、加好友：申请 / 互加直接同意 / 同意 / 上限读配置");
    const applyAB = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: B.roleId } });
    check(applyAB.code === 0 && applyAB.data.outgoing.length === 1 && applyAB.data.friends.length === 0, "A 加 B：进「我发出的」，还不是好友");
    check(
      applyAB.data.outgoing[0].roleId === B.roleId && applyAB.data.outgoing[0].name === "乙玩家" && applyAB.data.outgoing[0].status === "pendingOutgoing",
      "发出去的那条带对方角色名与状态（客户端直接显示，不用再查）",
      JSON.stringify(applyAB.data.outgoing[0]),
    );

    const mineB0 = await api(baseUrl, "GET", "social/me", { token: B.token });
    check(
      mineB0.data.incoming.length === 1 && mineB0.data.incoming[0].roleId === A.roleId && mineB0.data.incoming[0].status === "pendingIncoming",
      "B 的「别人加我」立刻可见（状态 pendingIncoming）",
      JSON.stringify(mineB0.data.incoming),
    );

    const applyBA = await api(baseUrl, "POST", "social/friends", { token: B.token, body: { roleId: A.roleId } });
    check(
      applyBA.code === 0 && applyBA.data.friends.length === 1 && applyBA.data.friends[0].roleId === A.roleId,
      "对方也在等我时再加一次 = 直接成为好友（省掉一次「同意」）",
      JSON.stringify(applyBA.data.friends),
    );

    const mineA1 = await api(baseUrl, "GET", "social/me", { token: A.token });
    check(
      mineA1.data.friends.length === 1 && mineA1.data.friends[0].roleId === B.roleId && mineA1.data.outgoing.length === 0,
      "A 这边同样变成好友，且「我发出的」已清空（镜像两行同时 accepted）",
    );
    checkEqual(mineA1.data.friends[0].level, 1, "好友行带等级（列表直接显示，不逐行再查）");

    const applyCA = await api(baseUrl, "POST", "social/friends", { token: C.token, body: { roleId: A.roleId } });
    checkEqual(applyCA.code, 0, "C 申请加 A");
    const mineA2 = await api(baseUrl, "GET", "social/me", { token: A.token });
    checkEqual(mineA2.data.incoming.length, 1, "A 看到一条待处理（C）");
    const acceptC = await api(baseUrl, "POST", `social/friends/${C.roleId}/accept`, { token: A.token });
    check(
      acceptC.code === 0 && acceptC.data.friends.length === FRIEND_LIMIT && acceptC.data.incoming.length === 0,
      "同意后好友数到上限、待处理清空",
      JSON.stringify(acceptC.data && acceptC.data.friends.map((item) => item.name)),
    );
    const mineC1 = await api(baseUrl, "GET", "social/me", { token: C.token });
    check(
      mineC1.data.friends.length === 1 && mineC1.data.friends[0].roleId === A.roleId,
      "C 这边也成了好友（同意改的是两行，不是只改我这边）",
    );

    const applyAD = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: D.roleId } });
    checkEqual(applyAD.code, 50115, "好友满时再加被拒（SOCIAL_FRIEND_FULL 50115，上限来自配置）");

    //#endregion

    //#region 二、拒绝 / 撤回 / 删除

    group("二、拒绝 / 撤回 / 删除：都不留痕");
    const applyDA = await api(baseUrl, "POST", "social/friends", { token: D.token, body: { roleId: A.roleId } });
    checkEqual(applyDA.code, 0, "D 申请加 A（D 自己没满，可以发申请）");
    const mineA3 = await api(baseUrl, "GET", "social/me", { token: A.token });
    checkEqual(mineA3.data.incoming.length, 1, "A 的待处理里出现 D");
    const rejectD = await api(baseUrl, "POST", `social/friends/${D.roleId}/reject`, { token: A.token });
    check(rejectD.code === 0 && rejectD.data.incoming.length === 0, "拒绝后待处理清空");
    const mineD0 = await api(baseUrl, "GET", "social/me", { token: D.token });
    check(
      mineD0.data.outgoing.length === 0 && mineD0.data.friends.length === 0 && mineD0.data.incoming.length === 0,
      "被拒的 D 那边一条痕迹都没有（不是「被拒绝」状态，而是干净）",
      JSON.stringify({ outgoing: mineD0.data.outgoing.length, friends: mineD0.data.friends.length }),
    );

    const reapplyDA = await api(baseUrl, "POST", "social/friends", { token: D.token, body: { roleId: A.roleId } });
    checkEqual(reapplyDA.code, 0, "被拒之后可以重新申请（拒绝没有留消费不掉的额度）");
    const cancelDA = await api(baseUrl, "DELETE", `social/friends/${A.roleId}`, { token: D.token });
    check(cancelDA.code === 0 && cancelDA.data.outgoing.length === 0, "撤回自己发出的申请：走同一个 DELETE，成功且列表清空");
    const mineA4 = await api(baseUrl, "GET", "social/me", { token: A.token });
    checkEqual(mineA4.data.incoming.length, 0, "撤回后 A 那边也不再挂着这条申请");

    const removeB = await api(baseUrl, "DELETE", `social/friends/${B.roleId}`, { token: A.token });
    check(removeB.code === 0 && removeB.data.friends.length === 1, "A 删掉 B：好友只剩 C");
    const mineB1 = await api(baseUrl, "GET", "social/me", { token: B.token });
    checkEqual(mineB1.data.friends.length, 0, "B 这边也不再是好友（双向消失，不需要他同意）");
    const removeAgain = await api(baseUrl, "DELETE", `social/friends/${B.roleId}`, { token: A.token });
    checkEqual(removeAgain.code, 50112, "已经没有关系时再删 = 50112（SOCIAL_FRIEND_NOT_FOUND）");

    //#endregion

    //#region 三、敌人单向

    group("三、敌人：单向一行（对方不知道）");
    const addEnemy = await api(baseUrl, "POST", "social/enemies", { token: A.token, body: { roleId: C.roleId } });
    check(
      addEnemy.code === 0 && addEnemy.data.enemies.length === 1 && addEnemy.data.enemies[0].roleId === C.roleId,
      "A 把 C 标为敌人",
      JSON.stringify(addEnemy.data && addEnemy.data.enemies),
    );
    const mineC2 = await api(baseUrl, "GET", "social/me", { token: C.token });
    checkEqual(mineC2.data.enemies.length, 0, "C 那边 enemies 为空（单向：我标我的）");
    checkEqual(mineC2.data.friends.length, 1, "标敌人不影响已有的好友关系（两套关系互不覆盖）");
    const enemyAgain = await api(baseUrl, "POST", "social/enemies", { token: A.token, body: { roleId: C.roleId } });
    checkEqual(enemyAgain.code, 50113, "重复标 = 50113（SOCIAL_ENEMY_EXISTS）");
    const removeEnemy = await api(baseUrl, "DELETE", `social/enemies/${C.roleId}`, { token: A.token });
    check(removeEnemy.code === 0 && removeEnemy.data.enemies.length === 0, "解除敌人成功");
    const removeEnemyAgain = await api(baseUrl, "DELETE", `social/enemies/${C.roleId}`, { token: A.token });
    checkEqual(removeEnemyAgain.code, 50114, "没标过就解 = 50114（SOCIAL_ENEMY_NOT_FOUND）");

    //#endregion

    //#region 四、按名字加人与错误码

    group("四、按名字加人：找不到 / 同名 / 自己 / 已是好友");
    const byName = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { name: "乙玩家" } });
    check(
      byName.code === 0 && byName.data.outgoing.length === 1 && byName.data.outgoing[0].roleId === B.roleId,
      "按角色名加人成功（精确到唯一的那个名字）",
      JSON.stringify(byName.data && byName.data.outgoing),
    );
    const notFound = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { name: "查无此人" } });
    checkEqual(notFound.code, 50109, "查无此人 = 50109（SOCIAL_ROLE_NOT_FOUND）");
    const ambiguous = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { name: "同名者" } });
    checkEqual(ambiguous.code, 50116, "同名多个 = 50116（让玩家改从「附近」按 roleId 加，不替他挑）");
    const self = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: A.roleId } });
    checkEqual(self.code, 50110, "加自己 = 50110（SOCIAL_TARGET_SELF）");
    const alreadyFriend = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: C.roleId } });
    checkEqual(alreadyFriend.code, 50111, "已是好友再加 = 50111（SOCIAL_ALREADY_FRIEND）");
    const selfEnemy = await api(baseUrl, "POST", "social/enemies", { token: A.token, body: { roleId: A.roleId } });
    checkEqual(selfEnemy.code, 50110, "标自己为敌人同样 50110（同一处拦截）");
    const missingRole = await api(baseUrl, "POST", "social/friends", { token: A.token, body: { roleId: "role_not_exists" } });
    checkEqual(missingRole.code, 50109, "roleId 不存在 = 50109（角色可能已被删）");

    //#endregion

    //#region 五、镜像行

    group("五、库里没有「单向」的好友行（镜像两行同状态）");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const lonely = db
      .prepare(
        `SELECT COUNT(*) AS n FROM role_friends f
          WHERE NOT EXISTS (
            SELECT 1 FROM role_friends g
             WHERE g.role_id = f.friend_id AND g.friend_id = f.role_id AND g.status = f.status
          )`,
      )
      .get();
    const totalPairs = db.prepare("SELECT COUNT(*) AS n FROM role_friends").get();
    const enemyRows = db.prepare("SELECT COUNT(*) AS n FROM role_enemies").get();
    db.close();
    checkEqual(lonely.n, 0, "没有孤立的好友行（每一行都有反方向的同状态行）");
    checkEqual(totalPairs.n, 4, "库里只剩两对关系各两行（A-C 已同意、A-B 待处理）");
    checkEqual(enemyRows.n, 0, "敌人行随解除一起删干净（没有残留）");

    //#endregion

    //#region 六、互见帧带身份与帮会

    group("六、互见帧带 roleId / guildId / guildName（客户端据此上色）");
    const guild = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "社交帮" } });
    checkEqual(guild.code, 0, "A 建了一个帮会（用来验互见帧里的同帮判定原料）");

    const ticketA = await api(baseUrl, "POST", "realtime/ticket", { token: A.token });
    const ticketB = await api(baseUrl, "POST", "realtime/ticket", { token: B.token });
    check(!!(ticketA.data && ticketA.data.ticket && ticketB.data && ticketB.data.ticket), "两个账号都取到实时票据");
    const wsBase = baseUrl.replace("http", "ws");
    const sessionA = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(ticketA.data.ticket)}`);
    const sessionB = connect(`${wsBase}/api/realtime?ticket=${encodeURIComponent(ticketB.data.ticket)}`);
    const bothWelcomed = await waitFor("两个连接都收到 welcome", async () =>
      sessionA.welcomes.length > 0 && sessionB.welcomes.length > 0 ? true : null,
    );
    check(!!bothWelcomed, "两条实时连接都握手成功");

    sessionA.send("worldJoin", { mapId: "1" });
    sessionA.send("pos", { mapId: "1", x: 100, y: 200, hp: 100, moving: false });
    // 等一拍：B 进图时 A 的在场条目得已经存在，B 才会在 worldJoin 的全量快照里看到它
    await sleep(150);
    sessionB.send("worldJoin", { mapId: "1" });
    sessionB.send("pos", { mapId: "1", x: 140, y: 200, hp: 100, moving: false });

    const frameWithA = await waitFor(
      "B 收到的 players 帧里出现 A",
      async () => {
        for (const frame of sessionB.players) {
          const entry = frame.players.find((item) => item.accountId !== undefined && item.username === "甲玩家");
          if (entry) return entry;
        }
        return null;
      },
      8_000,
    );
    check(!!frameWithA, "B 在互见帧里看到了 A（同图互见本身仍然工作）");
    checkEqual(frameWithA && frameWithA.roleId, A.roleId, "条目带 roleId（社交关系按角色记，客户端据此比对好友/敌人）");
    checkEqual(frameWithA && frameWithA.guildId, guild.data && guild.data.id, "条目带 guildId（同帮判定要「我的」与「他的」相等）");
    checkEqual(frameWithA && frameWithA.guildName, "社交帮", "条目带 guildName（悬浮提示 / 附近列表直接用）");

    sessionA.socket.close();
    sessionB.socket.close();

    //#endregion
  } finally {
    server.child.kill();
  }

  assertExpectedCount();
  if (failed > 0) {
    console.log(`\n❌ 社交 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 社交 e2e 全绿（${passed} 条断言）`);
  }
})();
