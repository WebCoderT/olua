#!/usr/bin/env node
/**
 * 服务端 e2e：实时通道（WebSocket 管道）
 *
 * 这一套用**真实 WS 客户端**打真实服务（跑 dist/ 产物），覆盖 issue #33 服务端侧的全部验收：
 *
 * - 取票据接口：无令牌 / 伪造令牌 / 管理端令牌（受众不符）全被拒；玩家取票拿到一次性票据
 * - 握手鉴权：有效票据能连上并先收 `welcome`；**非法 / 已用过 / 过期**的票据握手被拒，
 *   且拒绝形状与其它接口**同形**（HTTP 401 + `{code,message,data,timestamp}`），
 *   业务码复用既有的 `TOKEN_INVALID` / `TOKEN_EXPIRED`（「与安全审计同一个口径」）
 * - 消息与心跳：应用层 `ping` → `pong`；不认识的消息只回 `error` 帧、**不断开连接**
 * - 一账号一条连接：新连接上线顶掉旧连接（关闭码 `4000`）
 * - 存活探测：不回 `pong` 的连接被服务端断开（客户端看到 `1006`）
 * - 在线心跳（#547）：活连接逐拍续约 `online_heartbeat_at`；断线不清标记（重连窗口），
 *   心跳过期的在线标记被清算判为下线（标记与心跳一起清）；踢下线同一条路
 * - 优雅关闭：SIGTERM 后连接收 `1001`、进程自己退出、日志记下收了尾
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:realtime
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "realtime-code";

/**
 * 存活探测与票据有效期（毫秒）—— 这里刻意调小，否则这一套要跑几十秒
 *
 * 两个值的余量都留得很足，不是「刚好够」：
 * - 心跳 1000ms：正常连接有整整一秒还 pong（慢机器上也不会被误杀）；
 * - 票据 3000ms：除「过期」那条用例（它本来就等 3.3 秒）之外，其余用例取到票就立刻用，
 *   间隔是毫秒级 —— 不会出现「用例还没跑到，票先过期了」这种偶红。
 */
const HEARTBEAT_MS = 1000;
const TICKET_TTL_MS = 3000;

//#region 断言小工具

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}`);
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

/** 起一台服务并等它就绪（实例留着，末段要 SIGTERM 它；extraEnv 供后段覆盖 DB_PATH 等） */
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: ":memory:",
      JWT_SECRET: "e2e-realtime-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      REALTIME_TICKET_TTL_MS: String(TICKET_TTL_MS),
      REALTIME_HEARTBEAT_MS: String(HEARTBEAT_MS),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 两边都收：日志断言看 stdout（Nest Logger），异常堆栈在 stderr
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

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
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
  return { status: response.status, body };
}

/** 轮询等待条件成立 */
async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
}

/**
 * 发起一次实时连接尝试，把过程记下来
 *
 * 三类结局各自有落点：
 * - `opened`：握手成功
 * - `rejected`：握手被拒 —— 服务端回的是**一个正常的 HTTP 响应**（不是「连上再关」），
 *   所以要从 `unexpected-response` 里把状态码与响应体读回来
 * - `close`：连上之后断开
 */
function openSocket(url, options) {
  const socket = new WebSocket(url, options);
  const record = { socket, opened: false, messages: [], close: null, rejected: null };
  socket.on("open", () => {
    record.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      record.messages.push(JSON.parse(raw.toString()));
    } catch {
      /* 不是 JSON 就不记（本协议只发 JSON） */
    }
  });
  socket.on("close", (code, reason) => {
    record.close = { code, reason: reason.toString() };
  });
  // 必须有 error 监听：被拒时的 error 没人接会让整个测试进程崩掉
  socket.on("error", () => {});
  socket.on("unexpected-response", (_request, response) => {
    let text = "";
    response.on("data", (chunk) => (text += chunk));
    response.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      record.rejected = { status: response.statusCode, body, raw: text };
    });
  });
  return record;
}

/** 等一次连接尝试出结果（成功 / 被拒 / 断开都算有结果） */
function waitForHandshake(label, record, timeoutMs = 5_000) {
  return waitFor(label, async () => (record.opened || record.rejected || record.close ? record : null), timeoutMs);
}

/** 从消息记录里挑一条（按类型） */
function messageOf(record, type) {
  return record.messages.find((message) => message.type === type) ?? null;
}

/** 注册一个玩家账号，返回令牌 */
async function registerPlayer(baseUrl, username) {
  const response = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password: "pass1234" } });
  return response.body?.data?.token;
}

async function main() {
  console.log("=== 服务端 e2e：实时通道 ===");

  const server = await startServer();
  /** 后段「在线心跳」用的第二台服务（独立文件库；组内自己收尾） */
  let heartbeatServer = null;
  const { baseUrl, port } = server;
  const wsUrl = (ticket) => `ws://127.0.0.1:${port}/api/realtime${ticket === null ? "" : `?ticket=${ticket}`}`;

  try {
    //#region 一、契约
    group("一、契约：新接口归「客户端」组，且带上了调用方标识");
    {
      const doc = JSON.parse(require("fs").readFileSync(path.join(SERVER_DIR, "openapi.json"), "utf8"));
      const operation = doc.paths?.["/realtime/ticket"]?.post;
      check(Boolean(operation), "POST /realtime/ticket 在契约里");
      checkEqual(operation?.tags?.[0], "客户端", "归「客户端」分组");
      checkEqual(operation?.operationId, "realtime.ticket", "operationId 是 realtime.ticket（决定生成到哪个模块的方法）");
      checkEqual(operation?.["x-olua-audience"], "player", "标明调用方是 player（管理端令牌不能取票）");
      check(
        JSON.stringify(operation?.["x-olua-data-schema"] ?? {}).includes("RealtimeTicketDto"),
        "data 的类型指向 RealtimeTicketDto（生成物据此产出返回类型）",
      );
    }
    //#endregion

    const tokenA = await registerPlayer(baseUrl, "realtime_a");
    const tokenB = await registerPlayer(baseUrl, "realtime_b");
    const meA = await api(baseUrl, "GET", "/api/auth/me", { token: tokenA });
    const accountIdA = meA.body?.data?.id;
    check(Boolean(tokenA && tokenB && accountIdA), "两个玩家账号已注册，且能读到自己的账号 id");

    //#region 二、取票据
    group("二、取票据：令牌校验走的是既有的那一套（没有第二套校验）");
    {
      const anonymous = await api(baseUrl, "POST", "/api/realtime/ticket");
      checkEqual(anonymous.status, 401, "不带令牌取票被拒（401）");
      checkEqual(anonymous.body?.code, 40100, "业务码是 40100（UNAUTHORIZED，与其它接口一致）");

      const forged = await api(baseUrl, "POST", "/api/realtime/ticket", { token: "not-a-real-token" });
      checkEqual(forged.status, 401, "伪造令牌取票被拒（401）");
      checkEqual(forged.body?.code, 40101, "业务码是 40101（TOKEN_INVALID）");

      // 管理端令牌：aud 不符 —— 受众校验是 AuthGuard 本来就有的，这里只是确认它同样生效
      await api(baseUrl, "POST", "/api/admin/auth/register", {
        body: { username: "realtime_admin", password: "Admin#1234", registerCode: ADMIN_CODE },
      });
      const adminLogin = await api(baseUrl, "POST", "/api/admin/auth/login", {
        body: { username: "realtime_admin", password: "Admin#1234" },
      });
      const adminToken = adminLogin.body?.data?.token;
      const crossed = await api(baseUrl, "POST", "/api/realtime/ticket", { token: adminToken });
      checkEqual(crossed.status, 401, "管理端令牌取票被拒（受众不符 → 401）");
      checkEqual(crossed.body?.code, 40101, "受众不符走的是同一个码 40101");

      const first = await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenA });
      checkEqual(first.status, 201, "玩家取票成功（201）");
      const ticket1 = first.body?.data?.ticket;
      check(
        typeof ticket1 === "string" && ticket1.length >= 20 && /^[A-Za-z0-9_-]+$/.test(ticket1),
        "票据是一串足够长、URL 安全的随机字节（不是可解析的令牌）",
      );
      checkEqual(first.body?.data?.expiresIn, TICKET_TTL_MS, "回包给出有效期，与配置一致");
      const second = await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenA });
      check(second.body?.data?.ticket !== ticket1, "两次取票得到不同的票据（不可枚举）");
    }
    //#endregion

    //#region 三、握手鉴权
    group("三、握手鉴权：能连 / 拒连，且拒绝的形状与其它接口同形");
    const ticketForLive = (await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenA })).body?.data?.ticket;
    const live = openSocket(wsUrl(ticketForLive));
    await waitForHandshake("有效票据的握手", live);
    check(live.opened === true, "有效票据能建立连接");

    const welcome = (await waitFor("welcome 到达", async () => messageOf(live, "welcome"), 3_000)) ?? {};
    check(Boolean(welcome.type), "连上先收到 welcome（客户端不用猜连接是否就绪）");
    checkEqual(welcome.data?.username, "realtime_a", "welcome 带上账号名");
    checkEqual(welcome.data?.userId, accountIdA, "welcome 带的 userId 就是令牌所属账号");
    checkEqual(welcome.data?.heartbeatMs, HEARTBEAT_MS, "welcome 带上服务端的心跳间隔（客户端据此配自己的定时器）");

    // 同一张票用第二次：票据是一次性的
    const replay = openSocket(wsUrl(ticketForLive));
    await waitForHandshake("复用同一张票据的握手", replay);
    checkEqual(replay.rejected?.status, 401, "同一张票用第二次被拒（401）");
    checkEqual(replay.rejected?.body?.code, 40101, "复用被拒的码是 40101（无效或已被使用）");
    check(replay.opened === false, "拒连时**没有**把连接建起来（不是连上再关）");

    const garbage = openSocket(wsUrl("garbage-ticket"));
    await waitForHandshake("垃圾票据的握手", garbage);
    checkEqual(garbage.rejected?.status, 401, "垃圾票据被拒（401）");
    checkEqual(garbage.rejected?.body?.code, 40101, "垃圾票据的码是 40101");

    const missing = openSocket(wsUrl(null));
    await waitForHandshake("不带票据的握手", missing);
    checkEqual(missing.rejected?.status, 401, "不传 ticket 参数的握手被拒（401）");
    checkEqual(missing.rejected?.body?.code, 40101, "不传票据的码是 40101");

    const wrongPath = openSocket(`ws://127.0.0.1:${port}/api/not-realtime`);
    await waitForHandshake("错误路径的握手", wrongPath);
    checkEqual(wrongPath.rejected?.status, 404, "别的路径的 Upgrade 被拒（404，不是静默断开）");
    checkEqual(wrongPath.rejected?.body?.code, 40400, "错误路径的码是 40400（NOT_FOUND）");

    const rejectedBody = replay.rejected?.body;
    check(rejectedBody?.data === null, "拒连响应的 data 是 null（与其余接口同形）");
    check(typeof rejectedBody?.timestamp === "number", "拒连响应带 timestamp（与其余接口同形）");

    // 过期票据：等到超过有效期再握手
    const staleTicket = (await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenB })).body?.data?.ticket;
    await sleep(TICKET_TTL_MS + 300);
    const stale = openSocket(wsUrl(staleTicket));
    await waitForHandshake("过期票据的握手", stale);
    checkEqual(stale.rejected?.status, 401, "过期票据被拒（401）");
    checkEqual(stale.rejected?.body?.code, 40102, "过期给的是 40102（TOKEN_EXPIRED），与「无效」区分开");
    //#endregion

    //#region 三·五、角色权威快照（roleUpdate，#541）
    group("三·五、roleUpdate：建号即推权威快照，改库后下一拍跟上");
    {
      // 管理端令牌（改阶位要用）：本段独立注册，不依赖上一段的块级变量
      await api(baseUrl, "POST", "/api/admin/auth/register", {
        body: { username: "role_update_admin", password: "Admin#1234", registerCode: ADMIN_CODE },
      });
      const roleAdminLogin = await api(baseUrl, "POST", "/api/admin/auth/login", {
        body: { username: "role_update_admin", password: "Admin#1234" },
      });
      const roleAdminToken = roleAdminLogin.body?.data?.token;

      // 建一个角色（首个角色自动在线）→ 下一轮轮询就该把权威快照推过来
      // #597：建号只交三样客户端数据，角色 id 由服务端生成
      const created = await api(baseUrl, "POST", "/api/roles", { token: tokenA, body: { name: "realtime_r1", occupation: "1", sex: "1" } });
      checkEqual(created.status, 201, "准备：给账号 A 建一个角色（自动在线）");
      const roleAId = created.body?.data?.id;
      const firstUpdate = await waitFor("首帧 roleUpdate", async () => messageOf(live, "roleUpdate"), 5_000);
      check(Boolean(firstUpdate), "建号后 roleUpdate 帧自动到达（权威基线不用客户端来拉）");
      // 建号上报的是 10 级，帧里必须是出厂值 1 —— 帧带的是**服务端的等级**，不是客户端报的那份（#554）
      checkEqual(firstUpdate?.data?.level, 1, "快照带上服务端等级（#597 起出厂 1 级，服务端造的）");
      checkEqual(firstUpdate?.data?.bindGold, 0, "快照带上货币（#597 起出厂账本 0；收敛后唯一字段 bindGold）");
      check(Array.isArray(firstUpdate?.data?.physicalAttack) && firstUpdate.data.physicalAttack.length === 2, "快照带八项属性（区间属性是 [下限, 上限]）");
      check(typeof firstUpdate?.data?.combat === "number" && firstUpdate.data.combat > 0, "快照的战斗力是服务端重算的");
      checkEqual(firstUpdate?.data?.revision, created.body?.data?.revision, "快照带上修订号（客户端拿它做存档基线）");

      // 改库（save 一份血量被压到 1 的存档 + 被篡改的账本与经验）→ 下一拍再推一次：
      // #596 起血蓝也归服务端（上报的 hp:1 会被结算基线覆盖），bindGold / exp 本来就归服务端
      // 一致存档：GET 最新文档原样带回，只改 hp / bindGold / exp（三者都归服务端，见 role-authority.ts）
      const beforeSave = await api(baseUrl, "GET", `/api/roles/${roleAId}`, { token: tokenA });
      const saved = await api(baseUrl, "PUT", `/api/roles/${roleAId}`, {
        token: tokenA,
        body: {
          data: {
            ...(beforeSave.body?.data?.data || {}),
            hp: 1,
            bindGold: 5555,
            exp: 777,
            // 体验状态（#596 云同步）：归客户端书写，帧要原样带回
            shortcutKeys: [{ label: "1", key: 49, skillId: "1001" }],
            guide: { step: 3, done: false, skipped: false },
            soulShow: true,
            // 时装（#596）：穿着态与清单归服务端 —— 上报的改包值帧里不能出现
            fashionCloth: "cloth_9",
            fashionsOwned: ["cloth_9"],
          },
          revision: beforeSave.body?.data?.revision,
        },
      });
      checkEqual(saved.status, 200, "准备：save 改一份 hp 与一份被篡改的账本 / 经验（顺带写三个体验字段）");
      const secondUpdate = await waitFor(
        "第二帧 roleUpdate",
        async () => live.messages.find((message) => message.type === "roleUpdate" && message.data?.revision === saved.body?.data?.revision) ?? null,
        5_000,
      );
      check(Boolean(secondUpdate), "改库后下一拍 roleUpdate 跟上（跨进程写库也逃不过轮询）");
      check(
        typeof secondUpdate?.data?.combat === "number" &&
          secondUpdate?.data?.revision === saved.body?.data?.revision &&
          secondUpdate?.data?.bindGold === 0 &&
          secondUpdate?.data?.exp === 0 &&
          secondUpdate?.data?.hp !== 1,
        "第二帧仍是服务端权威值（bindGold 5555 / exp 777 丢弃，血量也以服务端结算为准——上报 1 无效）",
      );
      // 体验状态原样带回（#596 换设备云同步）：帧不带它们，「另一台设备改了快捷键」就要重选角才看得见
      check(
        Array.isArray(secondUpdate?.data?.shortcutKeys) && secondUpdate.data.shortcutKeys[0]?.skillId === "1001",
        "帧带快捷键绑定（体验状态云同步）",
        JSON.stringify(secondUpdate?.data?.shortcutKeys),
      );
      check(secondUpdate?.data?.guide?.step === 3 && secondUpdate?.data?.soulShow === true, "帧带引导进度与战魂外显勾选", JSON.stringify({ guide: secondUpdate?.data?.guide, soulShow: secondUpdate?.data?.soulShow }));
      // 时装（#596）：穿着态被库值回填（库里没穿 → null）、清单被整份删除（独占字段）—— 改包拿不到时装
      check(
        secondUpdate?.data?.fashionCloth === null && secondUpdate?.data?.fashionsOwned === undefined,
        "帧里的时装以服务端为准（上报的穿着与清单都不出现）",
        JSON.stringify({ fashionCloth: secondUpdate?.data?.fashionCloth, fashionsOwned: secondUpdate?.data?.fashionsOwned }),
      );

      // 后台改阶位（#551）→ 下一拍帧带着新值：不重进也要看得见。
      // 这三个字段自 #548 起归服务端（改包会被回填），所以「改了但看不到」只能靠帧补。
      // 时装发放（#596）搭同一趟车：管理端 PATCH 是 grant 语义的唯一写路，帧要带回
      const patched = await api(baseUrl, "PATCH", `/api/admin/roles/${roleAId}`, {
        token: roleAdminToken,
        body: { title: 5, soulOfWar: 6, rank: 7, fashionCloth: "cloth_3", fashionsOwned: ["cloth_2", "cloth_3"] },
      });
      checkEqual(patched.status, 200, "准备：管理端改三个阶位 + 发放两套时装");
      const growthUpdate = await waitFor(
        "帧带上阶位",
        async () => live.messages.find((message) => message.type === "roleUpdate" && message.data?.title === 5) ?? null,
        5_000,
      );
      check(Boolean(growthUpdate), "后台改阶位后下一拍 roleUpdate 跟上（不用重新选角）");
      check(
        growthUpdate?.data?.soulOfWar === 6 && growthUpdate?.data?.rank === 7,
        "三个阶位一起带（称号 / 战魂 / 军衔）",
        JSON.stringify({ title: growthUpdate?.data?.title, soul: growthUpdate?.data?.soulOfWar, rank: growthUpdate?.data?.rank }),
      );
      check(
        growthUpdate?.data?.fashionCloth === "cloth_3" &&
          JSON.stringify(growthUpdate?.data?.fashionsOwned) === JSON.stringify(["cloth_2", "cloth_3"]),
        "帧带管理端发放的时装（穿着态 + 清单原样带回）",
        JSON.stringify({ fashionCloth: growthUpdate?.data?.fashionCloth, fashionsOwned: growthUpdate?.data?.fashionsOwned }),
      );
    }
    //#endregion

    //#region 四、消息与心跳
    group("四、消息与心跳：心跳可应答，不认识的消息不断开连接");
    {
      live.socket.send(JSON.stringify({ type: "ping" }));
      const pong = (await waitFor("pong 到达", async () => messageOf(live, "pong"), 3_000)) ?? {};
      checkEqual(pong.type, "pong", "应用层 ping 得到 pong");
      check(typeof pong.data?.serverTime === "number", "pong 带上服务端时间（客户端可据此算一次往返）");

      live.socket.send(JSON.stringify({ type: "something-unknown" }));
      const errorFrame = (await waitFor("error 帧到达", async () => messageOf(live, "error"), 3_000)) ?? {};
      checkEqual(errorFrame.type, "error", "不认识的消息回 error 帧");
      check(
        String(errorFrame.data?.message ?? "").includes("something-unknown"),
        "error 帧里点名了那个不认识的类型（便于排查版本不匹配）",
      );
      checkEqual(live.socket.readyState, WebSocket.OPEN, "收到 error 之后连接照旧（不为一条对不上的消息掐掉通道）");
    }
    //#endregion

    //#region 五、一账号一条连接
    group("五、一账号一条连接：新连接顶掉旧连接（关闭码 4000）");
    {
      const ticket2 = (await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenA })).body?.data?.ticket;
      const replacement = openSocket(wsUrl(ticket2));
      await waitForHandshake("第二条连接的握手", replacement);
      await waitFor("旧连接被顶掉", async () => live.close, 3_000);

      checkEqual(live.close?.code, 4000, "旧连接收到关闭码 4000（被新连接替换）");
      check(
        String(live.close?.reason ?? "").includes("已在别处"),
        "关闭原因写清了「已在别处建立新的连接」（客户端据此不要立刻抢回来）",
      );
      checkEqual(replacement.socket.readyState, WebSocket.OPEN, "新连接仍然活着");
      await waitFor("新连接的 welcome", async () => messageOf(replacement, "welcome"), 3_000);
      check(Boolean(messageOf(replacement, "welcome")), "新连接照常收到 welcome");
    }
    //#endregion

    //#region 六、存活探测
    group("六、存活探测：不回 pong 的连接会被服务端断开");
    {
      // 另用一个账号：上面的连接会被它顶掉，这里要的是一条独立的、**故意不还 pong**的连接
      const silentTicket = (await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenB })).body?.data?.ticket;
      const silent = openSocket(wsUrl(silentTicket), { autoPong: false });
      await waitForHandshake("静默连接的握手", silent);
      await waitFor("静默连接被断开", async () => silent.close, HEARTBEAT_MS * 4);

      check(Boolean(silent.close), "不回 pong 的连接被服务端断开（拔网线那类死连接不会一直占着内存）");
      checkEqual(silent.close?.code, 1006, "断开是异常断开（服务端 terminate，客户端看到 1006）");
    }
    //#endregion

    //#region 七、优雅关闭
    group("七、优雅关闭：SIGTERM 后连接收 1001、进程自己退出、日志记下收了尾");
    {
      const lastTicket = (await api(baseUrl, "POST", "/api/realtime/ticket", { token: tokenA })).body?.data?.ticket;
      const kept = openSocket(wsUrl(lastTicket));
      await waitForHandshake("关闭前那条连接的握手", kept);
      checkEqual(kept.socket.readyState, WebSocket.OPEN, "关闭前留一条活连接（否则这一组什么也没验到）");

      const exited = new Promise((resolve) => server.child.on("exit", (code, signal) => resolve({ code, signal })));
      const startedAt = Date.now();
      server.child.kill("SIGTERM");
      const outcome = await Promise.race([exited, sleep(8_000).then(() => "超时")]);

      check(outcome !== "超时", `进程在宽限期内退出（没有靠外部强杀）—— 实际用时 ${Date.now() - startedAt}ms`);
      await waitFor("连接被服务端关闭", async () => kept.close, 3_000);
      checkEqual(kept.close?.code, 1001, "连接收到 1001（going away：是服务端要走，不是网络断了）");
      check(
        String(kept.close?.reason ?? "").includes("服务端正在关闭"),
        "关闭原因写明是服务端在关（客户端可据此稍后重连）",
      );
      check(server.logs().includes("实时通道已关闭"), "服务端日志里记下了「实时通道已关闭」（onModuleDestroy 真的跑了）");
    }
    //#endregion

    //#region 八、在线心跳（#547）
    group("八、在线心跳：心跳在 = 在线可信，心跳不在 = 下线");
    {
      // 独立一台服务 + **文件库**：清算判据要以第三方读者身份直接改库里的心跳（:memory: 摸不到）。
      // 宽限 2500ms（在「下限 = 2×心跳 = 2000ms」之上）：活连接每 1000ms 续约一次不会被误清，
      // 而把心跳改旧之后最多两拍多就能等到清算，不用干等默认的 90 秒
      const dbPath = path.join(os.tmpdir(), `olua-e2e-heartbeat-${process.pid}-${Date.now()}.db`);
      heartbeatServer = await startServer({
        DB_PATH: dbPath,
        REALTIME_KICK_POLL_MS: "100",
        REALTIME_ONLINE_STALE_MS: "2500",
      });
      try {
        const hbUrl = heartbeatServer.baseUrl;
        const reader = new DatabaseSync(dbPath);
        const rowOf = (username) =>
          reader.prepare("SELECT online_role_id, online_heartbeat_at FROM accounts WHERE username = ?").get(username);

        const tokenC = await registerPlayer(hbUrl, "heartbeat_c");
        await api(hbUrl, "POST", "/api/roles", { token: tokenC, body: { name: "heartbeat_r1", occupation: "1", sex: "1" } });
        let row = rowOf("heartbeat_c");
        check(Boolean(row?.online_role_id), "建号自动在线：online_role_id 已置上");
        check(
          typeof row?.online_heartbeat_at === "number" && row.online_heartbeat_at > 0,
          "在线心跳与标记一起写上（置标记与写心跳是同一条语句，不存在半截行）",
        );
        const heartbeatAtCreate = row.online_heartbeat_at;

        // 连上 WS：活连接由存活探测逐拍续约，心跳应被推着往前走
        const liveTicket = (await api(hbUrl, "POST", "/api/realtime/ticket", { token: tokenC })).body?.data?.ticket;
        const live = openSocket(`ws://127.0.0.1:${heartbeatServer.port}/api/realtime?ticket=${liveTicket}`);
        await waitForHandshake("在线心跳段的连接", live);
        await sleep(HEARTBEAT_MS * 2 + 300); // 跨过两拍，续约一定发生过
        row = rowOf("heartbeat_c");
        check(
          typeof row?.online_heartbeat_at === "number" && row.online_heartbeat_at > heartbeatAtCreate,
          "活连接的在线心跳被实时进程逐拍续约（不是建号那一下就再也不动）",
        );

        // 断线**不**立刻清标记（刻意的：短暂掉线重连不该被拒存档），下线判据交给心跳清算。
        // 这里先等一拍再改旧心跳，避免「刚改旧就被下一拍续约推回新鲜」的竞态
        live.socket.close();
        await sleep(HEARTBEAT_MS + 300);
        row = rowOf("heartbeat_c");
        check(row?.online_role_id != null, "断线不清在线标记（重连窗口内在线状态不变）");

        reader.prepare("UPDATE accounts SET online_heartbeat_at = ? WHERE username = ?").run(Date.now() - 60_000, "heartbeat_c");
        const cleared = await waitFor(
          "心跳过期清算",
          async () => (rowOf("heartbeat_c")?.online_role_id == null ? true : null),
          6_000,
        );
        check(Boolean(cleared), "心跳不在 = 下线：过期标记被清算清空（崩溃 / 断网不再永久「在线」）");
        check(rowOf("heartbeat_c")?.online_heartbeat_at == null, "清算把心跳与标记一起清（不留半截行）");

        // 踢下线走同一条 setOnlineRole：标记与心跳一起清
        const adminRegister = await api(hbUrl, "POST", "/api/admin/auth/register", {
          body: { username: "hb_admin", password: "Admin#1234", registerCode: ADMIN_CODE },
        });
        const adminLogin = await api(hbUrl, "POST", "/api/admin/auth/login", {
          body: { username: "hb_admin", password: "Admin#1234" },
        });
        const adminToken = adminLogin.body?.data?.token ?? adminRegister.body?.data?.token;
        const tokenD = await registerPlayer(hbUrl, "heartbeat_d");
        const meD = await api(hbUrl, "GET", "/api/auth/me", { token: tokenD });
        const accountIdD = meD.body?.data?.id;
        await api(hbUrl, "POST", "/api/roles", { token: tokenD, body: { name: "heartbeat_r2", occupation: "1", sex: "1" } });
        check(Boolean(accountIdD && rowOf("heartbeat_d")?.online_role_id), "准备：账号 D 已建号并自动在线");
        const kick = await api(hbUrl, "POST", `/api/admin/accounts/${accountIdD}/offline`, { token: adminToken });
        checkEqual(kick.status, 201, "管理端踢下线成功");
        const rowD = rowOf("heartbeat_d");
        check(rowD?.online_role_id == null && rowD?.online_heartbeat_at == null, "踢下线把标记与心跳一起清（与清算同一条写点）");

        reader.close();
      } finally {
        if (heartbeatServer.child.exitCode === null && heartbeatServer.child.signalCode === null) {
          heartbeatServer.child.kill("SIGKILL");
        }
        try {
          require("node:fs").rmSync(dbPath, { force: true });
        } catch {
          /* 临时库清不掉就算了（tmpdir 会兜底回收） */
        }
      }
    }
    //#endregion

    //#region 九、互见位置仲裁（#596 → #811 换闸）
    group("九、互见位置仲裁：瞬移帧被屏蔽（enforce 档），且不再「连发两帧就跟随」");
    {
      // 独立一台服务：广播 50ms 一拍 —— 逐帧观察不用干等默认值。
      // 速度上限不再走 env（`PLAYER_POS_MAX_SPEED` 已在 #811 删除），改由 `runtime_params.movement` 热切。
      const presServer = await startServer({
        PLAYER_SYNC_BROADCAST_MS: "50",
      });
      try {
        const pUrl = presServer.baseUrl;
        // `enforce` 档 + 上限压到 500px/s、容差 1、抖动量 0：这样「跨半张图的瞬移」必然被拒，
        // 而正常小步必然放行，不用去凑默认的 400×1.35
        const adminReg = await api(pUrl, "POST", "/api/admin/auth/register", {
          body: { username: "presence_gm", password: "Admin#1234", registerCode: ADMIN_CODE },
        });
        const adminToken = adminReg.body?.data?.token;
        const patched = await api(pUrl, "PATCH", "/api/admin/runtime-params/movement", {
          token: adminToken,
          body: { mode: "enforce", maxSpeed: 500, tolerance: 1, jitterPx: 0 },
        });
        checkEqual(patched.body?.data?.mode, "enforce", "准备：档位切到 enforce（PATCH 回执带新值）");
        const tokenE = await registerPlayer(pUrl, "presence_e");
        const tokenF = await registerPlayer(pUrl, "presence_f");
        await api(pUrl, "POST", "/api/roles", { token: tokenE, body: { name: "presence_r1", occupation: "1", sex: "1" } });
        await api(pUrl, "POST", "/api/roles", { token: tokenF, body: { name: "presence_r2", occupation: "1", sex: "1" } });

        const tickE = (await api(pUrl, "POST", "/api/realtime/ticket", { token: tokenE })).body?.data?.ticket;
        const tickF = (await api(pUrl, "POST", "/api/realtime/ticket", { token: tokenF })).body?.data?.ticket;
        const mover = openSocket(`ws://127.0.0.1:${presServer.port}/api/realtime?ticket=${tickE}`);
        const watcher = openSocket(`ws://127.0.0.1:${presServer.port}/api/realtime?ticket=${tickF}`);
        await waitForHandshake("移动者的握手", mover);
        await waitForHandshake("观看者的握手", watcher);
        check(mover.opened && watcher.opened, "准备：两个连接都已建立");

        // 观看者进图：成为 mapId "0" 的观看者，之后同图增量都会发给他
        watcher.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId: "0" } }));
        await waitFor("观看者的 world 快照", async () => messageOf(watcher, "world"), 3_000);

        /** 从观看者的 players 帧里找移动者的最新坐标 */
        const seenPosition = () => {
          for (let i = watcher.messages.length - 1; i >= 0; i -= 1) {
            const frame = watcher.messages[i];
            if (frame.type !== "players") continue;
            const entry = (frame.data?.players ?? []).find((p) => p.username === "presence_r1");
            if (entry) return { x: entry.x, y: entry.y, hp: entry.hp };
          }
          return null;
        };

        // 锚点取新手村的复活点：那是「玩家出生就站在这里」的坐标，必然不在任何碰撞盒里
        // （随手挑一个 x/y 很容易撞上外墙 —— 外墙盒是横贯整张图的 8320×128 长条）
        const AX = 4057.2;
        const AY = -3688.04;
        // 正常上报：位置进在场表并广播（首见 sentX=NaN 必有增量）
        mover.socket.send(JSON.stringify({ type: "pos", data: { mapId: "0", x: AX, y: AY, hp: 50, moving: false } }));
        const firstSeen = await waitFor("观看者看到移动者", seenPosition, 3_000);
        check(Boolean(firstSeen), "正常上报的位置被互见广播");
        check(Math.abs((firstSeen?.x ?? 0) - AX) < 1, "首见坐标就是上报值", JSON.stringify(firstSeen));

        // 瞬移（跨半张地图）：`enforce` 档下 56000px / 单帧远超 500px/s → 帧被拒、不进在场表
        // → 位置维持旧值 → 增量判据（坐标没变）不触发 → 观看者永远看不到 40000
        mover.socket.send(JSON.stringify({ type: "pos", data: { mapId: "0", x: 40000, y: -9000, hp: 50, moving: true } }));
        await sleep(400); // 跨过几个广播节拍
        const afterJump = seenPosition();
        check(afterJump === null || afterJump.x !== 40000, "瞬移帧被拒（观看者看不到跳变）", JSON.stringify(afterJump));

        // 拒绝时服务端**立刻回一帧 `posCorrect`**（#811 拍板：单帧即回，不攒 3 次），
        // 回的是「上一次被接受的坐标」而不是把本帧夹到上限
        const corrected = await waitFor("瞬移被拒后的 posCorrect", async () => {
          for (let i = mover.messages.length - 1; i >= 0; i -= 1) {
            const frame = mover.messages[i];
            if (frame.type === "posCorrect") return frame.data;
          }
          return null;
        }, 3_000);
        check(Boolean(corrected), "被拒的帧立刻换回一帧 posCorrect（客户端不用自己猜）");
        checkEqual(corrected?.reason, "speed", "posCorrect 带 reason=speed");
        check(Math.abs((corrected?.x ?? 0) - AX) < 1, "回拉坐标 = 上一次被接受的坐标（锚点）", JSON.stringify(corrected));

        // 再发同一帧：**不再**「连续 2 帧即信任」（B44 删掉的那条宽容分支）——
        // 否则「连发两次」就是白送的瞬移，而这正是本次要收掉的东西
        mover.socket.send(JSON.stringify({ type: "pos", data: { mapId: "0", x: 40000, y: -9000, hp: 50, moving: true } }));
        await sleep(400);
        const afterSecondJump = seenPosition();
        check(afterSecondJump === null || afterSecondJump.x !== 40000, "连发第二帧同样被拒（不再有「持续异常即跟随」）", JSON.stringify(afterSecondJump));

        // 被拒之后基线没动，正常小步照常走：给够间隔（1 秒 ≈ 500px 额度）
        await sleep(600);
        mover.socket.send(JSON.stringify({ type: "pos", data: { mapId: "0", x: AX + 40, y: AY, hp: 50, moving: true } }));
        const movedOn = await waitFor("被拒后的正常移动", async () => {
          const pos = seenPosition();
          return pos && Math.abs(pos.x - (AX + 40)) < 1 ? pos : null;
        }, 3_000);
        check(Boolean(movedOn), "基线没被瞬移带偏：之后 60px 的正常移动照常广播", JSON.stringify(seenPosition()));

        // 垃圾帧（非有限数）：永不接受，位置维持旧值；也不消耗跟随计数。
        // 原始字符串发：JSON.stringify 会把 Infinity 变成 null，改包工具手里是任意字节
        mover.socket.send('{"type":"pos","data":{"mapId":"0","x":1e999,"y":0,"hp":50,"moving":true}}');
        await sleep(400);
        const afterGarbage = seenPosition();
        check(afterGarbage !== null && Number.isFinite(afterGarbage.x), "非有限坐标被拒绝（垃圾帧不进互见广播）", JSON.stringify(afterGarbage));

        // 自报血量的唯一收窄：负数夹 0（死亡判据 <=0 的输入不能被改成负数绕过）。
        // 坐标必须与当前位置一致 —— `enforce` 档下顺手带个位移会被拒，血量就永远等不到
        mover.socket.send(JSON.stringify({ type: "pos", data: { mapId: "0", x: AX + 40, y: AY, hp: -5, moving: false } }));
        const hpSeen = await waitFor("负血量上报", async () => {
          const pos = seenPosition();
          return pos && pos.hp === 0 ? pos : null;
        }, 3_000);
        check(Boolean(hpSeen), "负数血量被夹到 0（AI 死亡判据不被负值绕过）", JSON.stringify(hpSeen));
      } finally {
        if (presServer.child.exitCode === null && presServer.child.signalCode === null) presServer.child.kill("SIGKILL");
      }
    }
    //#endregion
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGKILL");
  }

  console.log("");
  if (failed > 0) {
    console.log(`❌ ${passed} 条通过 / ${failed} 条失败`);
    failures.forEach((item) => console.log(`   - ${item}`));
    process.exit(1);
  }
  console.log(`✅ ${passed} 条通过 / 0 条失败`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
