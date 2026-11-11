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
    sendPos(mapId, x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: true } }));
    },
    async joinWorld(mapId) {
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      await sleep(120);
    },
    /** 服务端此刻认的 x（从最近一帧 players 里找自己那一条） */
    observed() {
      for (let index = session.playersFrames.length - 1; index >= 0; index -= 1) {
        const entry = session.playersFrames[index].players.find((player) => player.accountId === session.userId);
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
    const patchMovement = (body) => api(baseUrl, "PATCH", "admin/runtime-params/movement", { token: adminToken, body });
    //#endregion

    //#region 一、配置口
    group("一、配置口：出厂 log、能热切、容差 < 1 被拒");
    const initial = await api(baseUrl, "GET", "admin/runtime-params/movement", { token: adminToken });
    check(initial.body?.code === 0, "GET /admin/runtime-params/movement 通");
    checkEqual(initial.body?.data?.mode, "log", "出厂档位是 log（跑一周看误伤率再切 enforce）");
    checkEqual(initial.body?.data?.maxSpeed, 400, "出厂速度上限 400px/s");
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
    const dropBefore = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken });
    await patchMovement({ maxSpeed: 500 });
    const dropAfter = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken });
    checkEqual(
      JSON.stringify(dropAfter.body?.data?.drop),
      JSON.stringify(dropBefore.body?.data?.drop),
      "改 movement 之后 drop 分组原样（没被写成 {}）",
    );
    const aiBefore = await api(baseUrl, "GET", "admin/runtime-params/monster-ai", { token: adminToken });
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { guild: { nameMin: 2 } } });
    const aiAfter = await api(baseUrl, "GET", "admin/runtime-params/monster-ai", { token: adminToken });
    checkEqual(JSON.stringify(aiAfter.body?.data), JSON.stringify(aiBefore.body?.data), "改三组参数之后 monster_ai 原样（movement 同理）");
    const moveAfter = await api(baseUrl, "GET", "admin/runtime-params/movement", { token: adminToken });
    checkEqual(moveAfter.body?.data?.maxSpeed, 500, "movement 也原样留在库里");
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
