#!/usr/bin/env node
/**
 * 服务端 e2e：移动三道校验的前两道（#811：速度 + 穿墙 + posCorrect 回拉）
 *
 * ===========================================================================
 * 这一套钉住什么
 * ===========================================================================
 * 1. **配置口**：`GET/PATCH /admin/runtime-params/movement` 存在、出厂 `log`、容差 < 1 被拒（40000）；
 * 2. **`log` 档（出厂）照旧采纳**：超速帧接受、不回 `posCorrect` —— 观察期的作用是量误伤率，
 *    不是用线上体验换数据（这段行为如果反了，切 `enforce` 前的那一周就没意义了）；
 * 3. **`enforce` 档单帧即拒**：超速帧不进在场表（别人看到的坐标不变），并**立刻**收到一帧
 *    `posCorrect`（`reason = speed`，坐标 = 上一次被接受的坐标）；
 * 4. **正常移动不误判**：4Hz 小步走 / 掉帧 600ms 后的大步走都照旧接受（上限按**实际间隔**算）；
 * 5. **穿墙**：一次跨越碰撞盒的位移在 `enforce` 档被判 `reason = wall`；
 * 6. **复活的合法重定位**：`hp` 从 ≤ 0 变 > 0 的那一帧一律接受（复活走存档进程的 HTTP 接口，
 *    实时进程不会被告知）；
 * 7. **`off` 档完全放行**：超速也不回帧（回滚口径）。
 *
 * ===========================================================================
 * 怎么观察「坐标有没有被采纳」
 * ===========================================================================
 * 在场表是内存态、没有查询接口，但它会随 `players` 广播帧发出去 —— **发帧人自己也收到自己
 * 那一条**（服务端不剔除发送者，客户端按 accountId 自己过滤）。所以「最后一次在帧里看到的
 * x」就是「服务端此刻认的 x」。广播节拍在这套里压到 50ms，等一个节拍就够。
 *
 * ===========================================================================
 * 没覆盖的一条（如实记着）
 * ===========================================================================
 * 「突进类技能（十步一杀）报落点换免检额度」没有自动化用例：1008 要 10 级才能放，
 * 而现网没有「管理端直接改等级」的接口，造一个 10 级角色的成本高于这条用例的价值。
 * 它的正确性靠三件事兜住：额度只在**结算成功**之后给（被拒的技能换不到额度）、
 * 上界 320px、一次性消费。重开条件：出现 10 级以上的测试准备工具（例如 e2e 建号带等级）。
 *
 * 用法：npm run test:e2e:map-movement（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "movement-code";

//#region 断言小工具（与其余几套同一骨架）

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}${detail === undefined ? "" : `（${detail}）`}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
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

/** 起一台服务（临时文件库：准备段要写 `roles.data.mapAt`；广播压到 50ms 便于逐帧观察） */
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
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      JWT_SECRET: "e2e-map-movement-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      PLAYER_SYNC_BROADCAST_MS: "50",
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
  return { status: response.status, body };
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(30);
  }
  check(false, `${label}（等待超时）`);
  return null;
}

/** 一条会话化的 WS 连接（收集 players / posCorrect / welcome） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    userId: "",
    playersFrames: [],
    corrections: [],
    moveSeq: 0,
    sendPos(mapId, x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: true } }));
    },
    /** 发一份 dir 意图（#1138；dx/dy 已是单位向量的样子由调用方保证） */
    sendIntentDir(dx, dy, run) {
      this.moveSeq += 1;
      socket.send(JSON.stringify({ type: "moveIntent", data: { seq: this.moveSeq, kind: "dir", dx, dy, run } }));
    },
    /** 发一份 target 意图（#1138） */
    sendIntentTarget(tx, ty, run) {
      this.moveSeq += 1;
      socket.send(JSON.stringify({ type: "moveIntent", data: { seq: this.moveSeq, kind: "target", tx, ty, run } }));
    },
    /** 停止移动（#1138 `moveStop`） */
    sendStop() {
      socket.send(JSON.stringify({ type: "moveStop", data: {} }));
    },
    async joinWorld(mapId) {
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      await sleep(120);
    },
    /** 服务端此刻认的 x（从最近一帧 players 里找自己那一条） */
    observed() {
      for (let index = session.playersFrames.length - 1; index >= 0; index -= 1) {
        const entry = session.playersFrames[index].players.find((player) => player.a === session.userId);
        if (entry) return entry;
      }
      return null;
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.userId = String(frame.data?.userId ?? "");
      if (frame.type === "players") session.playersFrames.push(frame.data);
      if (frame.type === "posCorrect") session.corrections.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 从库里挑一个「小块」碰撞盒（避开四面外墙：那些 w/h 上千，跨过去要几千像素） */
function pickBox(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT cx, cy, w, h FROM map_collisions WHERE map_id = '1' AND w BETWEEN 16 AND 96 AND h BETWEEN 16 AND 96 ORDER BY w * h DESC")
      .all();
    return rows.length > 0 ? rows[0] : null;
  } finally {
    db.close();
  }
}

(async () => {
  console.log("=== 服务端 e2e：移动校验（#811 前两道）===");

  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-movement-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备
    group("准备：一个玩家连接 + 管理员（档位要热切，走管理端 PATCH）");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "move_player", password: "pass1234" } });
    const token = registered.body?.data?.token;
    check(!!token, "准备：玩家账号注册成功");
    await api(baseUrl, "POST", "roles", { token, body: { name: "走位测试", occupation: "1", sex: "1" } });
    placeRolesAt(dbPath, "1");
    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body?.data?.ticket ?? "")}`);
    await waitFor("会话握手", async () => (session.opened && session.userId ? session : null));
    check(!!session.userId, "准备：握手成功且有账号 id（players 帧靠它认自己）");
    await session.joinWorld("1");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_move", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.body?.data?.token;
    check(!!adminToken, "准备：管理员账号注册成功");
    const patchMovement = (body) => api(baseUrl, "PATCH", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE, body });
    //#endregion

    //#region 一、配置口
    group("一、配置口：出厂 log、能热切、容差 < 1 被拒");
    const initial = await api(baseUrl, "GET", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE });
    check(initial.body?.code === 0, "GET /admin/runtime-params/movement 通");
    checkEqual(initial.body?.data?.mode, "log", "出厂档位是 log（跑一周看误伤率再切 enforce）");
    check(Number(initial.body?.data?.maxSpeed) > 0, "出厂就带速度上限（具体 px/s 是运营数据，不判）", String(initial.body?.data?.maxSpeed));
    checkEqual(initial.body?.data?.wallCheck, true, "出厂开穿墙校验");
    const badTolerance = await patchMovement({ tolerance: 0.5 });
    checkEqual(badTolerance.body?.code, 40000, "容差 0.5 被拒（比上限还严 = 正常移动全被误判）");
    const badMode = await patchMovement({ mode: "strict" });
    checkEqual(badMode.status, 400, "档位拼错直接 400（不会静默落一个不认识的档位进库）");
    //#endregion

    //#region 二、log 档：照旧采纳
    group("二、log 档（出厂）：超速帧照旧采纳、不回 posCorrect");
    // 先站稳：一帧建立在场条目
    session.sendPos("1", 300, -300, 100);
    await sleep(200);
    check(!!session.observed(), "log 档：首帧上报后别人能看到我（在场条目已建立）");
    const jumpX = 900;
    session.sendPos("1", jumpX, -300, 100);
    const loggedIn = await waitFor("log 档采纳了 600px 的跳跃", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - jumpX) < 1 ? entry : null;
    });
    check(!!loggedIn, "log 档：600px / 250ms（2400px/s）的帧被**接受**（观察期不改行为）", loggedIn && `x=${loggedIn.x}`);
    await sleep(300);
    checkEqual(session.corrections.length, 0, "log 档：没有发过 posCorrect（不拉回）");
    //#endregion

    //#region 三、enforce 档：单帧即拒 + 立刻回帧
    group("三、enforce 档：超速帧被拒、并立刻收到 posCorrect{speed}");
    const enforced = await patchMovement({ mode: "enforce" });
    checkEqual(enforced.body?.data?.mode, "enforce", "档位切到 enforce（热切，下一次 pos 帧就生效）");
    const base = session.observed();
    check(!!base, "enforce 档：拿到当前权威坐标当基线");
    const beforeCorrections = session.corrections.length;
    const cheatX = (base?.x ?? 0) + 800;
    session.sendPos("1", cheatX, base?.y ?? 0, 100);
    const correction = await waitFor("收到 posCorrect", async () => session.corrections[beforeCorrections] ?? null);
    check(!!correction, "enforce 档：伪造 800px 的帧收到 posCorrect");
    checkEqual(correction?.reason, "speed", "原因标成 speed（速度校验拒的）");
    check(!!correction && Math.abs(correction.x - (base?.x ?? 0)) < 1, "回的是**上一次被接受的**坐标（不是夹到上限的点）", correction && `x=${correction.x} 基线=${base?.x}`);
    await sleep(300);
    const afterReject = session.observed();
    check(!!afterReject && Math.abs(afterReject.x - (base?.x ?? 0)) < 1, "被拒的帧没进在场表（别人看到的坐标没变）", afterReject && `x=${afterReject.x}`);
    //#endregion

    //#region 四、正常移动不误判
    group("四、正常移动不误判：4Hz 小步走 / 掉帧后的大步走都照旧接受");
    let cursorX = base?.x ?? 0;
    const cursorY = base?.y ?? 0;
    const beforeWalk = session.corrections.length;
    for (let step = 1; step <= 4; step += 1) {
      session.sendPos("1", cursorX + step * 25, cursorY, 100);
      await sleep(250);
      if (process.env.DEBUG_MOVE) {
        const entry = session.observed();
        const last = session.corrections[session.corrections.length - 1];
        console.log(`    [dbg] step ${step} → observed ${entry && entry.x}, corrections ${session.corrections.length}, last ${JSON.stringify(last)}`);
      }
    }
    cursorX += 100;
    const walked = await waitFor("小步走被采纳", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - cursorX) < 1 ? entry : null;
    });
    check(!!walked, "4Hz 下每次 25px（100px/s）全部被接受", walked && `x=${walked.x}`);
    checkEqual(session.corrections.length, beforeWalk, "正常移动期间没有误发 posCorrect");
    // 掉帧：600ms 才报一帧，位移 240px（400px/s 的 0.6 倍容差余量内）
    await sleep(600);
    session.sendPos("1", cursorX + 240, cursorY, 100);
    const afterGap = await waitFor("掉帧后的大步走被采纳", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - (cursorX + 240)) < 1 ? entry : null;
    });
    check(!!afterGap, "掉帧 600ms 后走 240px 被接受（上限按**实际间隔**算，不是按固定 250ms）", afterGap && `x=${afterGap.x}`);
    //#endregion

    //#region 五、穿墙
    group("五、穿墙：跨过碰撞盒的位移判 wall（先把速度上限放到很大，隔离出穿墙这一项）");
    const box = pickBox(dbPath);
    check(!!box, "准备：从 map_collisions 挑到一个小块碰撞盒", box && JSON.stringify(box));
    if (box) {
      const leftX = box.cx + box.w / 2 + 40;
      const rightX = box.cx - box.w / 2 - 40;
      const lineY = box.cy;
      // ① 先关穿墙校验、把上限拉大，把角色摆到盒子右侧（这一步本身会跨过别的盒子，不能判墙）。
      //    `sleep` 是必需的：位移上限按**实际间隔**算，上一组刚走完（dt≈250ms）就跳 5000px
      //    仍然会被判超速 —— 这里等出足够长的间隔，才是在单独测穿墙
      const relaxed = await patchMovement({ maxSpeed: 20000, wallCheck: false });
      check(relaxed.body?.data?.wallCheck === false, "穿墙校验单独关掉（速度校验仍在）");
      await sleep(700);
      session.sendPos("1", leftX, lineY, 100);
      const placed = await waitFor("角色摆到盒子右侧", async () => {
        const entry = session.observed();
        return entry && Math.abs(entry.x - leftX) < 2 ? entry : null;
      }, 8_000);
      check(!!placed, "准备：角色已站在碰撞盒右侧（穿墙校验临时关掉）", placed && `x=${placed.x}`);
      // ② 打开穿墙校验，往左侧跨过盒子
      await patchMovement({ wallCheck: true });
      const beforeWall = session.corrections.length;
      session.sendPos("1", rightX, lineY, 100);
      const wallCorrection = await waitFor("收到 reason=wall 的 posCorrect", async () => session.corrections[beforeWall] ?? null);
      check(!!wallCorrection, "跨过碰撞盒的位移被判穿墙");
      checkEqual(wallCorrection?.reason, "wall", "原因标成 wall");
      check(!!wallCorrection && Math.abs(wallCorrection.x - leftX) < 2, "回的是盒子右侧（墙外）那个被接受的位置", wallCorrection && `x=${wallCorrection.x}`);
    }
    //#endregion

    //#region 六、复活的合法重定位
    group("六、复活：hp 从 ≤ 0 变 > 0 的那一帧一律接受（复活走存档进程的 HTTP 接口）");
    await patchMovement({ maxSpeed: 400, wallCheck: true, mode: "enforce" });
    const dead = session.observed();
    const deadX = dead?.x ?? 0;
    const deadY = dead?.y ?? 0;
    // 先躺下：hp = 0 的帧照常接受（血量不进位移校验）
    session.sendPos("1", deadX, deadY, 0);
    await sleep(200);
    const beforeRevive = session.corrections.length;
    const reviveX = deadX + 1200;
    session.sendPos("1", reviveX, deadY, 100);
    const revived = await waitFor("复活帧被接受", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - reviveX) < 2 ? entry : null;
    });
    check(!!revived, "hp 0 → 满血时的 1200px 位移被接受（复活点可能离尸体很远）", revived && `x=${revived.x}`);
    checkEqual(session.corrections.length, beforeRevive, "复活帧没有触发 posCorrect（否则人被拉回尸体上）");
    //#endregion

    //#region 七、off 档：完全放行
    group("七、off 档：超速也不回帧（回滚口径）");
    await patchMovement({ mode: "off" });
    const offBase = session.observed();
    const beforeOff = session.corrections.length;
    session.sendPos("1", (offBase?.x ?? 0) + 5000, offBase?.y ?? 0, 100);
    const offAccepted = await waitFor("off 档采纳 5000px 跳跃", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - ((offBase?.x ?? 0) + 5000)) < 2 ? entry : null;
    });
    check(!!offAccepted, "off 档：5000px 的跳跃被接受（与 #811 之前完全一致）", offAccepted && `x=${offAccepted.x}`);
    checkEqual(session.corrections.length, beforeOff, "off 档：不发 posCorrect");
    //#endregion

    //#region 八、别组参数不受影响
    group("八、改位移校验不会顺手清掉别的分组（整行 UPDATE 的纪律）");
    const dropBefore = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    await patchMovement({ maxSpeed: 500 });
    const dropAfter = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(
      JSON.stringify(dropAfter.body?.data?.drop),
      JSON.stringify(dropBefore.body?.data?.drop),
      "改 movement 之后 drop 分组原样（没被写成 {}）",
    );
    const aiBefore = await api(baseUrl, "GET", "admin/runtime-params/monster-ai", { token: adminToken, zoneId: ADMIN_ZONE });
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { guild: { nameMin: 2 } } });
    const aiAfter = await api(baseUrl, "GET", "admin/runtime-params/monster-ai", { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(JSON.stringify(aiAfter.body?.data), JSON.stringify(aiBefore.body?.data), "改三组参数之后 monster_ai 原样（movement 同理）");
    const moveAfter = await api(baseUrl, "GET", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(moveAfter.body?.data?.maxSpeed, 500, "movement 也原样留在库里");
    //#endregion

    //#region 九、玩家移动速度的配置口（#1138）
    group("九、playerMove 配置口（#1138）：四组之一、跑速 < 走速被拒、别组不受影响");
    const patchedMove = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { playerMove: { walkSpeedPxPerS: 200, runSpeedPxPerS: 400 } },
    });
    checkEqual(patchedMove.body?.code, 0, "PATCH /admin/runtime-params 带 playerMove 分组能存");
    if (process.env.DEBUG_MOVE) console.log("    [dbg] patch body:", JSON.stringify(patchedMove.body).slice(0, 2000));
    checkEqual(patchedMove.body?.data?.playerMove?.walkSpeedPxPerS, 200, "回读走路速度 = 200");
    checkEqual(patchedMove.body?.data?.playerMove?.runSpeedPxPerS, 400, "回读跑步速度 = 400");
    const badSpeed = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { playerMove: { walkSpeedPxPerS: 400, runSpeedPxPerS: 100 } },
    });
    checkEqual(badSpeed.body?.code, 40000, "跑速 < 走速被拒（跑得比走还慢，移动表现倒挂）");
    checkEqual(moveAfter.body?.data?.movement === undefined ? "absent" : "present", "absent", "GET /admin/runtime-params 不下发 movement（档位不告诉客户端）");
    checkEqual(
      (await api(baseUrl, "GET", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE })).body?.data?.maxSpeed,
      500,
      "改 playerMove 之后 movement 列原样（整行 UPDATE 的纪律，第二条）",
    );
    //#endregion

    //#region 十、dir 意图步进 + moveStop（#1138）
    // 摆位与「可走走廊」：先按兼容路径把角色一步步走过去（每步都被 #811 仲裁接受 = 这段
    // 路没有跨墙），后续意图就在这条**已证明可走**的走廊里来回走，不赌几何
    group("十、dir 意图步进 + moveStop（#1138）：服务端 10Hz 步进，pos 坐标不再被采纳");
    const corridorFrom = { x: 300, y: -300 };
    const corridorTo = { x: 500, y: -300 };
    session.sendPos("1", corridorFrom.x, corridorFrom.y, 100);
    await waitFor("走廊起点被接受", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - corridorFrom.x) < 1 ? entry : null;
    });
    for (let step = 1; step <= 8; step += 1) {
      session.sendPos("1", corridorFrom.x + step * 25, corridorFrom.y, 100);
      await sleep(250);
    }
    const walkedIn = await waitFor("走廊摆位完成（兼容仲裁一步步走到 x=500）", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - corridorTo.x) < 1 ? entry : null;
    });
    check(!!walkedIn, "准备：角色已站在走廊右端（每一步都被兼容仲裁接受 = 这段路可走）");

    // dir 意图：往回走（走廊方向已证明可走），服务端步进 → players 帧里坐标自己动
    const intentBase = session.observed();
    check(!!intentBase, "dir 意图：拿到步进起点");
    const beforeCorrectionsIntent = session.corrections.length;
    session.sendIntentDir(-1, 0, true);
    const movedByServer = await waitFor("dir 意图：服务端步进让坐标自己动起来", async () => {
      const entry = session.observed();
      // 走了 ≥ 40px 且方向正确（往回）才算「服务端在步进」—— 具体位移是运营数值，不判
      return entry && intentBase.x - entry.x >= 40 ? entry : null;
    }, 6_000);
    check(!!movedByServer, "dir 意图：服务端步进生效（players 帧里的坐标持续变化）", movedByServer && `x=${movedByServer.x}`);

    // 意图激活期间 pos 帧的坐标不被采纳：报一个走廊外的远点，权威位置不动心
    const fakeX = (movedByServer?.x ?? 0) + 2000;
    session.sendPos("1", fakeX, corridorFrom.y, 100);
    await sleep(400);
    const afterFake = session.observed();
    check(
      !!afterFake && Math.abs(afterFake.x - fakeX) > 500,
      "意图激活期间：pos 帧的坐标被忽略（服务端步进的位置没被伪造帧拽走）",
      afterFake && `x=${afterFake.x} 伪造=${fakeX}`,
    );

    // moveStop：停下之后坐标冻结
    session.sendStop();
    await sleep(300);
    const stoppedAt = session.observed();
    check(!!stoppedAt, "moveStop：拿到停下的位置");
    checkEqual(stoppedAt?.mv, false, "moveStop：移动标记落下（别人看到的是待机）");
    await sleep(500);
    const frozen = session.observed();
    check(
      !!frozen && stoppedAt !== null && Math.abs(frozen.x - stoppedAt.x) < 1 && Math.abs(frozen.y - stoppedAt.y) < 1,
      "moveStop：坐标冻结（服务端不再步进）",
      frozen && `x=${frozen.x} / 停在 ${stoppedAt?.x}`,
    );
    checkEqual(session.corrections.length, beforeCorrectionsIntent, "整个意图过程没有发 posCorrect（正常走路不该被拉回）");
    //#endregion

    //#region 十一、target 意图：到点停 + 形状垃圾静默丢弃（#1138）
    group("十一、target 意图（#1138）：走向目标点、到点自动停；垃圾意图静默丢弃");
    const targetBase = session.observed();
    check(!!targetBase, "target 意图：拿到步进起点");
    // 目标点选在走廊里（往回走：方向与起点之间的路已被兼容仲裁证明可走），服务端直线走过去必然到得了
    const target = { tx: targetBase.x - 60, ty: targetBase.y };
    session.sendIntentTarget(target.tx, target.ty, true);
    const arrived = await waitFor("target 意图：走到目标点附近", async () => {
      const entry = session.observed();
      return entry && Math.abs(entry.x - target.tx) < 3 ? entry : null;
    }, 6_000);
    check(!!arrived, "target 意图：服务端把人带到目标点（≤3px 容差）", arrived && `x=${arrived.x} 目标=${target.tx}`);
    await sleep(300);
    const settled = session.observed();
    checkEqual(settled?.mv, false, "target 意图：到点自动停（不需要 moveStop）");
    // 形状垃圾：NaN 方向、未知 kind —— 静默丢弃，不崩、不挪人
    session.socket.send(JSON.stringify({ type: "moveIntent", data: { seq: 99, kind: "dir", dx: "abc", dy: 0, run: true } }));
    session.socket.send(JSON.stringify({ type: "moveIntent", data: { seq: 100, kind: "warp" } }));
    await sleep(300);
    const afterGarbage = session.observed();
    check(
      !!afterGarbage && settled !== null && Math.abs(afterGarbage.x - settled.x) < 1,
      "垃圾意图被静默丢弃（人没被挪走，进程也没崩）",
      afterGarbage && `x=${afterGarbage.x}`,
    );
    //#endregion

    //#region 十二、enforce 档：目标点在墙里被拒 + posCorrect(wall)（#1138）
    group("十二、enforce 档（#1138）：target 落墙拒收 + posCorrect{wall}");
    const boxForIntent = pickBox(dbPath);
    check(!!boxForIntent, "准备：挑到一个小块碰撞盒", boxForIntent && JSON.stringify(boxForIntent));
    if (boxForIntent) {
      const switched = await patchMovement({ mode: "enforce" });
      checkEqual(switched.body?.data?.mode, "enforce", "档位切回 enforce");
      const wallBase = session.observed();
      check(!!wallBase, "enforce：拿到当前权威坐标");
      const beforeWallIntent = session.corrections.length;
      session.sendIntentTarget(boxForIntent.cx, boxForIntent.cy, true);
      const wallCorrect = await waitFor("收到 reason=wall 的 posCorrect", async () => session.corrections[beforeWallIntent] ?? null);
      check(!!wallCorrect, "enforce：目标点落在墙里的意图被拒");
      checkEqual(wallCorrect?.reason, "wall", "原因标成 wall");
      check(
        !!wallCorrect && wallBase !== null && Math.abs(wallCorrect.x - wallBase.x) < 1 && Math.abs(wallCorrect.y - wallBase.y) < 1,
        "回的是当前权威位置（人没有被拉去墙里）",
        wallCorrect && `x=${wallCorrect.x}`,
      );
      // dir 方向没有目标点可判：穿墙交给步进滑行，不判 wall —— 方向意图照收
      session.sendIntentDir(1, 0, true);
      await sleep(300);
      session.sendStop();
      const dirAccepted = session.observed();
      check(!!dirAccepted, "enforce：dir 意图不判墙（照收，撞墙由步进滑行兜住）");
      await patchMovement({ mode: "off" });
    }
    //#endregion
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    try {
      require("node:fs").rmSync(dbPath, { force: true });
    } catch {
      /* 库文件删不掉不影响结论 */
    }
  }

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
})();
