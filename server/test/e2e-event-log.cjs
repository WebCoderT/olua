#!/usr/bin/env node
/**
 * 服务端 e2e：玩家行为流水（#886 / J3）+ 审计补口（#884 / #885）
 *
 * 三件事必须钉死：
 *
 * 一、**十类事件的落点**（#886）：登录 / 进图 / 击杀 / 拾取 / 获得 / 消耗 / 邮件 / 任务
 *     八类各有一条真跑出来的行（交易 / 强化暂时放置，`total = 0` 且字典里仍占位）；
 *     每一行都要有**主语**（roleId / roleName）与**位置**（mapId）—— 少了它们，
 *     「某角色一晚干了什么」这个问题依然答不上来，而那正是这张表存在的理由。
 *
 * 二、**写库失败绝不拖垮主流程**：把 `event_logs` 改名（INSERT 必然失败）后，
 *     登录照样成功、照样发令牌。这是「世界状态是权威、流水可丢」的落地验证 ——
 *     没有这条，任何一次日志表故障都会变成「全服登录失败」。
 *
 * 三、**审计的两个缺口**（#884 / #885）：管理员注册（`@Public()` 跳过拦截器）自己要留痕，
 *     成功与两种失败都记；批量封禁 / 批量删除按目标逐条记明细 —— 拦截器那条永远
 *     `target_id = null`，查不到「封了谁」。
 *
 * 走的是 `dist/`，前置 `npm run build`。用法：npm run test:e2e:event-log
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt, placeRolesNear } = require("./lib/place-role.cjs");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_CODE = "e2e-event-admin";
const MAP_ID = "1";
/** 怪物 1 改成「必掉 drug_hp_1 ×2」：拾取 / 获得 / 消耗三段都靠这份掉落 */
const DROP_GOOD = "drug_hp_1";

//#region 断言小工具

let passed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push(detail === undefined ? label : `${label}（实际：${detail}）`);
  console.log(`  ✗ ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, label, JSON.stringify(actual));
}

function finish(message) {
  console.log("");
  if (failures.length === 0) {
    console.log(`${message}（共 ${passed} 条断言）`);
    process.exit(0);
  }
  console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
  failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  process.exit(1);
}

//#endregion

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * 直读库里的流水
 *
 * 服务端在跑（WAL），这里用只读句柄开同一个文件 —— 读到的必然包含「已经返回给客户端的
 * 那次操作」写下的行，因为写是**同步**的（`EventLogService` 的硬约束）。
 */
function query(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 某类型的全部流水（按时间倒序） */
const eventsOf = (dbPath, type) =>
  query(dbPath, "SELECT * FROM event_logs WHERE type = ? ORDER BY created_at DESC, id DESC", [type]);

/** 某类型最新一条（没有则 null） */
const latestEvent = (dbPath, type) => eventsOf(dbPath, type)[0] ?? null;

/** 把 detail 列解成对象（坏数据不该让整条用例炸掉） */
function detailOf(row) {
  if (!row || !row.detail) return null;
  try {
    return JSON.parse(row.detail);
  } catch {
    return null;
  }
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
      JWT_SECRET: "e2e-event-log-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      // 流水保留策略放进测试要用的值（不为清零服务，只为「保留策略真的在跑」有个可断言的面）
      EVENT_LOG_MAX_ROWS: "100000",
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
  if (options.userAgent) headers["User-Agent"] = options.userAgent;
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

/** 一条 WS 连接：只收 world / settle / picked 三种帧 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    settles: [],
    pickeds: [],
    errors: [],
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.filter((frame) => frame.castId === castId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "picked") session.pickeds.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-event-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：玩家、角色（空背包）与管理员");

    const playerReg = await api(baseUrl, "POST", "auth/register", {
      body: { username: "event_player", password: "pass1234" },
    });
    const token = playerReg.data && playerReg.data.token;
    const accountId = playerReg.data && playerReg.data.account && playerReg.data.account.id;
    check(!!token && !!accountId, "准备：玩家注册拿到令牌与账号 id", playerReg.message);

    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "流水观察者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    // 初始存档的 bag 不是网格（服务端不扩容）：换成规范化的 4×10 空网格，拾取才有地方放
    const initial = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
    const savedGrid = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: initial.data && initial.data.revision, data: { ...((initial.data && initial.data.data) || {}), bag: emptyGrid } },
    });
    check(savedGrid.code === 0, "准备：背包换成规范空网格", savedGrid.message);

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "event_admin", password: "Event#123", registerCode: ADMIN_CODE },
      userAgent: "e2e-agent/1.0",
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const adminId = adminReg.data && adminReg.data.admin && adminReg.data.admin.id;
    check(!!adminToken && !!adminId, "准备：管理员已注册并拿到令牌", adminReg.message);

    //#endregion

    //#region 一、#884 管理员注册留痕

    group("一、#884：管理员注册（@Public 跳过拦截器）自己也要留痕");

    const registerRows = query(
      dbPath,
      "SELECT * FROM audit_logs WHERE action = 'adminAuth.register' AND target_id = ? ORDER BY created_at DESC",
      [adminId],
    );
    check(registerRows.length === 1, "首个管理员注册写下一条操作日志", `rows=${registerRows.length}`);
    const registerRow = registerRows[0] ?? {};
    checkEqual(registerRow.success, 1, "注册日志记为成功");
    checkEqual(registerRow.actor_name, "event_admin", "注册日志的操作人就是新管理员");
    const registerDetail = detailOf(registerRow);
    checkEqual(registerDetail && registerDetail.role, "super_admin", "首个注册者被记为 super_admin");
    checkEqual(registerDetail && registerDetail.firstAdmin, true, "detail 标出 firstAdmin = true");
    checkEqual(registerDetail && registerDetail.userAgent, "e2e-agent/1.0", "detail 记下 User-Agent");
    check(!!registerRow.ip, "注册日志带来源 IP", registerRow.ip);

    // 失败一：用户名已存在
    const dupReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "event_admin", password: "Event#123", registerCode: ADMIN_CODE },
    });
    check(dupReg.code !== 0, "重复用户名注册被拒", dupReg.message);
    const dupRows = query(
      dbPath,
      "SELECT * FROM audit_logs WHERE action = 'adminAuth.register' AND success = 0 ORDER BY created_at DESC",
    );
    check(dupRows.length >= 1, "失败注册也留痕（否则「谁在试注册」查不到）", `rows=${dupRows.length}`);
    checkEqual(dupRows[0] && dupRows[0].error_code, dupReg.code, "失败日志的业务码与响应一致");
    checkEqual(dupRows[0] && dupRows[0].actor_name, null, "失败注册没有操作人（留空而不是乱填）");

    // 失败二：注册码错
    const wrongCode = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "event_intruder", password: "Event#123", registerCode: "wrong-code" },
    });
    check(wrongCode.code !== 0, "注册码错被拒", wrongCode.message);
    const wrongRows = query(
      dbPath,
      "SELECT * FROM audit_logs WHERE action = 'adminAuth.register' AND success = 0 ORDER BY created_at DESC",
    );
    check(wrongRows.length >= 2, "注册码错也单独留一条", `rows=${wrongRows.length}`);
    checkEqual(detailOf(wrongRows[0]) && detailOf(wrongRows[0]).username, "event_intruder", "失败日志记下尝试的账号名");

    //#endregion

    //#region 二、登录事件

    group("二、登录：成功与失败都进流水");

    checkEqual(eventsOf(dbPath, "login").length, 0, "注册本身不算登录事件（注册不写 login）");

    const okLogin = await api(baseUrl, "POST", "auth/login", { body: { username: "event_player", password: "pass1234" } });
    check(okLogin.code === 0, "玩家登录成功", okLogin.message);
    const okLoginEvent = latestEvent(dbPath, "login");
    check(!!okLoginEvent && okLoginEvent.success === 1, "成功登录写下一条 success = 1 的流水");
    checkEqual(okLoginEvent && okLoginEvent.account_id, accountId, "流水关联到账号");
    check(!!okLoginEvent && !!okLoginEvent.ip, "流水带来源 IP", okLoginEvent && okLoginEvent.ip);
    checkEqual(detailOf(okLoginEvent) && detailOf(okLoginEvent).username, "event_player", "detail 记下登录名");

    const badLogin = await api(baseUrl, "POST", "auth/login", { body: { username: "event_player", password: "wrong-pass" } });
    check(badLogin.code !== 0, "错误口令登录被拒", badLogin.message);
    const badLoginEvent = latestEvent(dbPath, "login");
    check(!!badLoginEvent && badLoginEvent.success === 0, "失败登录写下 success = 0 的流水");
    checkEqual(badLoginEvent && badLoginEvent.account_id, accountId, "口令错的失败仍挂到该账号（账号是存在的）");
    checkEqual(detailOf(badLoginEvent) && detailOf(badLoginEvent).reason, "账号或密码错误", "失败原因写进 detail.reason");

    const ghostLogin = await api(baseUrl, "POST", "auth/login", { body: { username: "no_such_account", password: "whatever" } });
    check(ghostLogin.code !== 0, "不存在的账号登录被拒", ghostLogin.message);
    const ghostEvent = latestEvent(dbPath, "login");
    checkEqual(ghostEvent && ghostEvent.account_id, null, "账号不存在时流水里 account_id 为空（不编一个 id 出来）");

    //#endregion

    //#region 三、进图 / 击杀 / 拾取

    group("三、进图 / 击杀 / 拾取：走真实实时通道");

    // 怪物 1 压成一刀死（maxHp 是独立列，改完即时生效），掉落固定成 drug_hp_1 ×2
    const squishy = await api(baseUrl, "PATCH", "admin/monsters/1", { token: adminToken, body: { maxHp: 5 } });
    check(squishy.code === 0, "准备：怪物 1 改成一刀死", squishy.message);
    const dropSet = await api(baseUrl, "PATCH", "admin/monster-drops/1", {
      token: adminToken,
      body: { tableId: null, picks: 1, entries: [{ goodId: DROP_GOOD, weight: 100, chance: 1, count: [2, 2] }] },
    });
    check(dropSet.code === 0, "准备：怪物 1 必掉 drug_hp_1 ×2", dropSet.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const wsUrl = `${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`;
    const session = connect(wsUrl);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    check(session.opened, "准备：实时连接已建立");

    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
  // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
  placeRolesAt(dbPath, "1");
  // 任务交互要过 NPC 距离校验（#862/#863）：把位置摆到传送官旁边（map_npcs 的坐标）
  placeRolesNear(dbPath, "1", "0002");
  const world = await session.joinWorld(MAP_ID);
    check(!!(world && world.monsters.length > 0), "worldJoin 拿到权威快照", JSON.stringify(world && world.monsters.length));
    await sleep(120);

    const enterEvent = latestEvent(dbPath, "enter_map");
    check(!!enterEvent, "进图写下一条 enter_map");
    checkEqual(enterEvent && enterEvent.map_id, MAP_ID, "进图流水带 mapId");
    checkEqual(enterEvent && enterEvent.role_id, roleId, "进图流水挂到角色");
    checkEqual(enterEvent && enterEvent.role_name, "流水观察者", "进图流水冗余了角色名（角色被删也认得出）");
    checkEqual(enterEvent && enterEvent.account_id, accountId, "进图流水挂到账号");

    const mob = world && world.monsters.find((item) => item.alive);
    check(!!mob, "快照里有活着的怪", JSON.stringify(mob && mob.instanceId));

    let castSeq = 0;
    const castOnce = async (body) => {
      castSeq += 1;
      const id = castSeq;
      await paceCast();
      session.socket.send(JSON.stringify({ type: "cast", data: { castId: id, ...body } }));
      return session.waitForSettle(id);
    };

    const first = await castOnce({ skillId: "1000", targetId: mob && mob.instanceId, monsterKey: mob && mob.monsterKey });
    check(!!(first && first.ok), "首次出手结算成功", JSON.stringify(first));
    check(!!(first && first.killed), "一刀把 5 血的怪打死（killed = true）", JSON.stringify(first && first.killed));

    const killEvent = latestEvent(dbPath, "kill");
    check(!!killEvent, "击杀写下一条 kill");
    checkEqual(killEvent && killEvent.target, mob && mob.monsterKey, "击杀流水的 target 是怪物 key");
    checkEqual(killEvent && killEvent.amount, 1, "一条击杀 = 一只（amount = 1，便于 SUM）");
    checkEqual(killEvent && killEvent.map_id, MAP_ID, "击杀流水带 mapId");
    const killDetail = detailOf(killEvent);
    check(
      !!(killDetail && typeof killDetail.x === "number" && typeof killDetail.y === "number"),
      "击杀流水带死亡坐标（能回答「在哪杀的」）",
      JSON.stringify(killDetail),
    );
    check(!!(killDetail && killDetail.tier), "击杀流水带 tier（normal / elite / boss）", JSON.stringify(killDetail && killDetail.tier));

    // 拾取：等 picked 帧；账本下标从 0 起
    const pickBefore = session.pickeds.length;
    session.socket.send(JSON.stringify({ type: "pick", data: { castId: first && first.castId, index: 0 } }));
    const picked = await waitFor("picked 帧", async () => {
      const hits = session.pickeds.slice(pickBefore);
      return hits.length > 0 ? hits[hits.length - 1] : null;
    });
    check(!!(picked && picked.ok), "掉落拾取成功", JSON.stringify(picked));

    const pickEvent = latestEvent(dbPath, "pick");
    check(!!pickEvent, "拾取写下一条 pick");
    checkEqual(pickEvent && pickEvent.target, DROP_GOOD, "拾取流水的 target 是物品 id");
    checkEqual(pickEvent && pickEvent.amount, 2, "拾取流水记下数量（2 个）");
    checkEqual(pickEvent && pickEvent.map_id, MAP_ID, "拾取流水带 mapId");
    checkEqual(pickEvent && pickEvent.role_name, "流水观察者", "拾取流水带角色名");

    //#endregion

    //#region 四、获得 / 消耗（HTTP 写入口）

    group("四、获得 / 消耗：卖出与丢弃各一条");

    const revAfterPick = (picked && picked.revision) || 0;
    const sold = await api(baseUrl, "POST", `roles/${roleId}/sell`, {
      token,
      body: { revision: revAfterPick, entries: [{ goodId: DROP_GOOD, count: 1 }] },
    });
    check(sold.code === 0, "卖出一件药", sold.message);
    const sellEvent = latestEvent(dbPath, "consume");
    check(!!sellEvent, "卖出写下一条 consume");
    checkEqual(sellEvent && sellEvent.target, DROP_GOOD, "消耗流水的 target 是物品 id");
    checkEqual(sellEvent && sellEvent.amount, 1, "消耗流水记下数量");
    checkEqual(detailOf(sellEvent) && detailOf(sellEvent).reason, "sell", "detail.reason = sell");
    check((detailOf(sellEvent) && detailOf(sellEvent).unitPrice) > 0, "卖出流水带单价（事后能对账）", JSON.stringify(detailOf(sellEvent)));

    const revAfterSell = (sold.data && sold.data.revision) || revAfterPick + 1;
    // 背包里还剩 1 个：找到它的格子再丢
    const bagNow = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const grid = (bagNow.data && bagNow.data.data && bagNow.data.data.bag) || [];
    let slot = null;
    grid.forEach((line, row) => {
      (line || []).forEach((cell, col) => {
        if (!slot && cell && cell.id === DROP_GOOD) slot = { row, col };
      });
    });
    check(!!slot, "背包里还剩一个可丢弃的药", JSON.stringify(slot));

    const discarded = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
      token,
      body: { revision: revAfterSell, action: "discard", row: slot && slot.row, col: slot && slot.col },
    });
    check(discarded.code === 0, "丢弃按钮把药扔了", discarded.message);
    const discardEvent = latestEvent(dbPath, "consume");
    checkEqual(detailOf(discardEvent) && detailOf(discardEvent).reason, "discard", "丢弃也记成 consume（reason = discard）");
    checkEqual(discardEvent && discardEvent.id === sellEvent.id, false, "丢弃是一条**新的**流水（不是复用卖出那条）");

    //#endregion

    //#region 五、邮件

    group("五、邮件：领取记 mail，附件记 gain（source = mail）");

    const mailSent = await api(baseUrl, "POST", `admin/game-mail/roles/${roleId}`, {
      token: adminToken,
      body: { channel: "reward", title: "e2e 补偿", bindGold: 100, items: [{ goodId: DROP_GOOD, count: 1 }] },
    });
    check(mailSent.code === 0, "管理端补发一封带附件的邮件", mailSent.message);
    const mailId = mailSent.data && mailSent.data.id;

    const claimedMail = await api(baseUrl, "POST", `mails/${mailId}/claim`, { token });
    check(claimedMail.code === 0, "玩家领取附件", claimedMail.message);

    const mailEvent = latestEvent(dbPath, "mail");
    check(!!mailEvent, "领取写下一条 mail");
    checkEqual(mailEvent && mailEvent.target, mailId, "mail 流水的 target 是邮件 id（能回答「这封补偿有没有人领」）");
    checkEqual(detailOf(mailEvent) && detailOf(mailEvent).title, "e2e 补偿", "mail 流水带标题（人眼看时有信息量）");
    checkEqual(detailOf(mailEvent) && detailOf(mailEvent).bindGold, 100, "mail 流水带附件绑定元宝");

    // 一封「绑定元宝 + 物品」的邮件会写出**两条** gain（各一行）：绑定元宝一行、物品一行，
    // 同一毫秒写入 → 谁排在前面由兜底键决定，所以这里按 target 找，不认「第一条」
    const mailGains = eventsOf(dbPath, "gain").filter((row) => (detailOf(row) || {}).source === "mail");
    check(mailGains.length >= 2, "邮件附件另记 gain（source = mail，绑定元宝与物品各一行）", JSON.stringify(mailGains.map((row) => row.target)));
    const mailBindGold = mailGains.find((row) => row.target === "bindGold");
    checkEqual(mailBindGold && mailBindGold.target, "bindGold", "附件绑定元宝记成 gain / target = bindGold（唯一货币）");
    checkEqual(mailBindGold && mailBindGold.amount, 100, "附件绑定元宝数量正确");
    check(!!mailGains.find((row) => row.target === DROP_GOOD), "附件物品也各记一行 gain");

    //#endregion

    //#region 六、任务

    group("六、任务：交付记 quest，奖励记 gain（source = quest）");

    const accepted = await api(baseUrl, "POST", "quests/accept", { token, body: { questId: "8001" } });
    check(accepted.code === 0, "接取主线 8001（talk 型，不用打怪）", accepted.message);
    const talked = await api(baseUrl, "POST", "quests/npc-talk", { token, body: { npcId: "0002" } });
    check(talked.code === 0, "与 NPC 对话推进进度", talked.message);
    const submitted = await api(baseUrl, "POST", "quests/submit", { token, body: { questId: "8001" } });
    check(submitted.code === 0, "交付任务", submitted.message);

    const questEvent = latestEvent(dbPath, "quest");
    check(!!questEvent, "交付写下一条 quest");
    checkEqual(questEvent && questEvent.target, "8001", "quest 流水的 target 是任务 id");
    checkEqual(detailOf(questEvent) && detailOf(questEvent).kind, "main", "quest 流水带 kind = main");
    checkEqual(questEvent && questEvent.role_name, "流水观察者", "quest 流水带角色名");

    const questGain = eventsOf(dbPath, "gain").find((row) => (detailOf(row) || {}).source === "quest");
    check(!!questGain, "任务奖励记成 gain（source = quest）", JSON.stringify(eventsOf(dbPath, "gain").map((row) => detailOf(row))));

    //#endregion

    //#region 七、类型字典（十类登记、八类有数据）

    group("七、类型字典：十类都登记，暂时放置的两类 total = 0");

    const types = await api(baseUrl, "GET", "admin/event-logs/types", { token: adminToken });
    check(types.code === 0, "类型清单可查", types.message);
    const typeList = (types.data && types.data.types) || [];
    checkEqual(typeList.length, 10, "字典里十类都在（含暂时放置的两类）");
    const typeMap = Object.fromEntries(typeList.map((item) => [item.value, item]));
    for (const value of ["login", "enter_map", "kill", "pick", "gain", "consume", "mail", "quest"]) {
      check(!!(typeMap[value] && typeMap[value].total > 0), `实做的 ${value} 有数据`, JSON.stringify(typeMap[value]));
    }
    checkEqual(typeMap.trade && typeMap.trade.total, 0, "trade 暂时放置：total = 0（没有交易模块）");
    checkEqual(typeMap.enhance && typeMap.enhance.total, 0, "enhance 暂时放置：total = 0（没有强化链路）");
    checkEqual(typeMap.kill && typeMap.kill.label, "击杀", "类型清单带中文名");

    //#endregion

    //#region 八、查询接口

    group("八、查询接口：类型 / 角色 / 地图三种筛选");

    const byRole = await api(baseUrl, "GET", `admin/event-logs?roleId=${roleId}&size=100`, { token: adminToken });
    check(byRole.code === 0, "按角色筛可查", byRole.message);
    const roleRows = (byRole.data && byRole.data.list) || [];
    check(roleRows.length > 0 && roleRows.every((row) => row.roleId === roleId), "按角色筛只回该角色的流水", `rows=${roleRows.length}`);
    checkEqual(byRole.data && byRole.data.total, roleRows.length, "total 与当前页一致（同一套筛选条件）");

    const byType = await api(baseUrl, "GET", "admin/event-logs?type=kill&size=100", { token: adminToken });
    const killRows = (byType.data && byType.data.list) || [];
    check(killRows.length > 0 && killRows.every((row) => row.type === "kill"), "按类型筛只回该类型", `rows=${killRows.length}`);
    checkEqual(killRows[0] && killRows[0].typeLabel, "击杀", "列表带 typeLabel");

    const byMap = await api(baseUrl, "GET", `admin/event-logs?mapId=${MAP_ID}&type=pick&size=100`, { token: adminToken });
    const mapRows = (byMap.data && byMap.data.list) || [];
    check(mapRows.length > 0 && mapRows.every((row) => row.mapId === MAP_ID), "按地图 + 类型交叉筛可用", `rows=${mapRows.length}`);

    const badType = await api(baseUrl, "GET", "admin/event-logs?type=not_a_type", { token: adminToken });
    check(badType.code !== 0, "非法类型被拒（不是静默回空列表）", badType.message);

    const playerRead = await api(baseUrl, "GET", "admin/event-logs", { token });
    check(playerRead.code !== 0, "玩家令牌进不来（只有 event:read 才可读）", playerRead.message);

    //#endregion

    //#region 九、#885 批量操作按目标写明细

    group("九、#885：批量封禁 / 批量删角色按目标逐条留痕");

    // 造 3 个待封账号（不需要角色）
    const victims = [];
    for (const name of ["event_v1", "event_v2", "event_v3"]) {
      const row = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      victims.push(row.data && row.data.account && row.data.account.id);
    }
    check(victims.every(Boolean), "准备：3 个账号已注册", JSON.stringify(victims));

    const banned = await api(baseUrl, "POST", "admin/accounts/batch-status", {
      token: adminToken,
      body: { ids: victims, status: "disabled", reason: "e2e 批量封禁" },
    });
    check(banned.code === 0 && banned.data.updated === 3, "批量封禁 3 个账号成功", JSON.stringify(banned.data));

    const banRows = query(
      dbPath,
      "SELECT * FROM audit_logs WHERE action = 'adminAccount.batchStatus' ORDER BY created_at DESC",
    );
    const banItems = banRows.filter((row) => (detailOf(row) || {}).item === true);
    checkEqual(banItems.length, 3, "批量封 3 人产生 3 行明细");
    checkEqual(new Set(banItems.map((row) => row.target_id)).size, 3, "3 行明细的 target_id 互不相同（终于查得到封了谁）");
    check(
      banItems.every((row) => victims.includes(row.target_id)),
      "明细行指向的正是被封的那 3 个账号",
      JSON.stringify(banItems.map((row) => row.target_id)),
    );
    checkEqual(detailOf(banItems[0]) && detailOf(banItems[0]).batchSize, 3, "明细行带 batchSize（一次操作共几个目标）");
    checkEqual(banItems[0] && banItems[0].target_type, "account", "明细行的 target_type = account");
    checkEqual(banItems[0] && banItems[0].actor_name, "event_admin", "明细行带操作人（不用回主行猜）");

    // 批量删角色：造 2 个角色再删
    const roleIds = [];
    for (const name of ["event_r1", "event_r2"]) {
      const reg = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const made = await api(baseUrl, "POST", "roles", {
        token: reg.data && reg.data.token,
        body: { name, occupation: "1", sex: "1" },
      });
      roleIds.push(made.data && made.data.id);
    }
    check(roleIds.every(Boolean), "准备：2 个角色已创建", JSON.stringify(roleIds));

    const removed = await api(baseUrl, "POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: roleIds } });
    check(removed.code === 0 && removed.data.deleted === 2, "批量删除 2 个角色成功", JSON.stringify(removed.data));
    const roleAudit = query(dbPath, "SELECT * FROM audit_logs WHERE action = 'adminRole.batchRemove' ORDER BY created_at DESC");
    const roleItems = roleAudit.filter((row) => (detailOf(row) || {}).item === true);
    checkEqual(roleItems.length, 2, "批量删 2 个角色产生 2 行明细");
    check(roleItems.every((row) => roleIds.includes(row.target_id)), "明细行指向的正是被删的那 2 个角色", JSON.stringify(roleItems.map((row) => row.target_id)));
    const removedNames = roleItems.map((row) => (detailOf(row) || {}).name);
    check(
      removedNames.includes("event_r1") && removedNames.includes("event_r2"),
      "明细行还记下了角色名（角色已删，主表查不到）",
      JSON.stringify(removedNames),
    );

    //#endregion

    //#region 十、写库失败不影响主流程

    group("十、反证：流水表写不进去时，主流程照常");

    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE event_logs RENAME TO event_logs_broken");
    db.close();
    const loginWithBrokenLog = await api(baseUrl, "POST", "auth/login", {
      body: { username: "event_player", password: "pass1234" },
    });
    check(loginWithBrokenLog.code === 0, "日志表不可写时登录**依然成功**（世界状态是权威）", loginWithBrokenLog.message);
    check(!!(loginWithBrokenLog.data && loginWithBrokenLog.data.token), "照样发得出令牌", JSON.stringify(loginWithBrokenLog.data && !!loginWithBrokenLog.data.token));

    const dbBack = new DatabaseSync(dbPath);
    dbBack.exec("ALTER TABLE event_logs_broken RENAME TO event_logs");
    dbBack.close();
    const countAfterRestore = eventsOf(dbPath, "login").length;
    checkEqual(countAfterRestore, 3, "恢复后行数没变（失败的那次**一条也没写**，不是写了半条）");

    const afterRestoreLogin = await api(baseUrl, "POST", "auth/login", {
      body: { username: "event_player", password: "pass1234" },
    });
    check(afterRestoreLogin.code === 0, "恢复后登录继续正常", afterRestoreLogin.message);
    checkEqual(eventsOf(dbPath, "login").length, 4, "恢复后流水继续落库");

    //#endregion

    finish("玩家行为流水（#886）+ 审计补口（#884 / #885）全部通过");
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
