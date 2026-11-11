#!/usr/bin/env node
/**
 * 服务端 e2e：服务端 A*（#811 第三道：`pathFind` / `path` 帧）
 *
 * ===========================================================================
 * 这一套钉住什么
 * ===========================================================================
 * 1. **起点不听客户端的**：`pathFind` 只带目标点，起点由服务端从在场表取。位置还没上报
 *    （刚进图）时回 `unreachable` —— 给一条「从 (0,0) 出发」的路比不给更危险；
 * 2. **绕得开墙**：路点逐段采样，任何一个采样点落在 `map_collisions` 的盒子里就红。
 *    这是这一套的核心断言：算出一条路 ≠ 算出一条能走的路；
 * 3. **拉直有效**：同一条开阔直线上的两点，路点长度贴近直线距离（< 1.25 倍）——
 *    没有拉直的话每个格子一个点，长度会变成阶梯的 ~1.08 倍并多出几十个路点；
 * 4. **吸附**：目标点落在碰撞盒里 → `snapped = true`、路点非空、末点不是原目标（被挪到最近可站立格）；
 * 5. **不可达**：目标在图外 / 起点不在网格内 → `unreachable = true` 且 `points` 为空
 *    （客户端**不许**退化成直线走，那是穿墙）；
 * 6. **格子口径与客户端同源**：中间路点的坐标是格心（`(col + 0.5) × cellSize`），
 *    `cellSize` 读的是 `runtime_params.auto_battle.cellSize`（出厂 40）—— 改配置两端一起变。
 *
 * ===========================================================================
 * 与 issue 验收的两处偏差（都是实测后的收窄，不是放水）
 * ===========================================================================
 * - issue 写「(100,-100) → (5000,-5000)，中间 3 个碰撞盒，路点/直线 < 1.5」：那是**合成场景**。
 *   这套跑的是真实地图 1（161 个碰撞盒 + 四道外墙），绕行必然更长 → 改锁「逐段不穿墙」
 *   （真正要保证的东西）+「开阔直线 < 1.25」（拉直有效的证明）。硬锁 1.5 只会得到一个
 *   随地图数据漂移的假红；
 * - issue 写「耗时 > 16ms 记 warn」：日志断言容易假绿（并行跑时抖动），改成**回执成功**即可，
 *   warn 由服务端自己按 16ms 阈值输出（见 `PathService.pathOf`）。
 *
 * 用法：npm run test:e2e:map-path（前置 npm run build）
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
const ADMIN_CODE = "path-code";

//#region 断言小工具

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
      JWT_SECRET: "e2e-map-path-secret",
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

/** 一条会话化的 WS 连接（收集 path 帧，按 seq 取） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    userId: "",
    paths: [],
    pathSeq: 0,
    sendPos(mapId, x, y, hp = 100) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: true } }));
    },
    /** 要一条路并等它的回执（按 seq 配对，过期回执自动跳过） */
    async requestPath(mapId, to) {
      // 服务端对同一连接 100ms 内的重复请求直接丢弃（防刷）—— 这里按客户端重寻路的
      // 节奏（repathInterval 出厂 400ms）留间隔，否则连发会拿到「没有回执」
      await sleep(150);
      session.pathSeq += 1;
      const seq = session.pathSeq;
      socket.send(JSON.stringify({ type: "pathFind", data: { mapId, to, seq } }));
      return waitFor(`seq=${seq} 的 path 帧`, async () => session.paths.find((frame) => frame.seq === seq) ?? null, 8_000);
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "welcome") session.userId = String(frame.data?.userId ?? "");
      if (frame.type === "path") session.paths.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 地图 1 的碰撞盒（与 `walkGeometryOf` 同一形状：中心 + 宽高） */
function boxesOf(dbPath, mapId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT cx, cy, w, h FROM map_collisions WHERE map_id = ?").all(mapId);
  } finally {
    db.close();
  }
}

/** 点是否在任一盒子里 */
function insideAnyBox(boxes, x, y) {
  return boxes.some((box) => Math.abs(x - box.cx) <= box.w / 2 && Math.abs(y - box.cy) <= box.h / 2);
}

/**
 * 逐段采样，返回第一个落在盒子里的点（没有则 null）
 *
 * **刻意不复用服务端的 `segmentHitsAabb`**：用同一份实现证明「它没穿墙」等于自证。
 * 采样步长 4px（最薄的盒子也有 16px，不会漏）。
 */
function firstBlockedPoint(boxes, from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / 4));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (insideAnyBox(boxes, x, y)) return { x, y };
  }
  return null;
}

/** 折线总长 */
function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return total;
}

(async () => {
  console.log("=== 服务端 e2e：服务端 A*（#811 第三道）===");

  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-path-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;
    const boxes = boxesOf(dbPath, "1");

    //#region 准备
    group("准备：一个玩家连接 + 管理员（格子口径要跟着 auto_battle 走）");
    check(boxes.length > 0, "准备：地图 1 有碰撞盒（绕行断言的前提）", `共 ${boxes.length} 个`);
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "path_player", password: "pass1234" } });
    const token = registered.body?.data?.token;
    await api(baseUrl, "POST", "roles", { token, body: { name: "寻路测试", occupation: "1", sex: "1" } });
    placeRolesAt(dbPath, "1");
    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body?.data?.ticket ?? "")}`);
    await waitFor("会话握手", async () => (session.opened && session.userId ? session : null));
    check(!!session.userId, "准备：握手成功");
    session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId: "1" } }));
    await sleep(150);
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_path", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.body?.data?.token;
    const runtimeParams = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken });
    const cellSize = runtimeParams.body?.data?.autoBattle?.cellSize;
    const clearance = runtimeParams.body?.data?.autoBattle?.clearance;
    check(cellSize > 0 && clearance >= 0, "准备：拿到客户端同一组网格参数（auto_battle.cellSize / clearance）", `cellSize=${cellSize} clearance=${clearance}`);
    //#endregion

    //#region 一、位置未上报时不给路
    group("一、位置还没上报：回 unreachable（不给「从原点出发」的路）");
    const noPos = await session.requestPath("1", { x: 900, y: -900 });
    check(!!noPos, "刚进图（还没发过 pos）请求寻路拿到回执");
    check(noPos?.unreachable === true, "回执是 unreachable（起点未知时不猜）");
    checkEqual(noPos?.points?.length, 0, "unreachable 时 points 必为空（客户端不许退化成直线走）");
    //#endregion

    //#region 二、起点以服务端为准
    group("二、起点取服务端的在场坐标（客户端不传起点）");
    // 站在开阔地（264,-264）：附近 150px 内没有碰撞盒，先把基线落这里
    session.sendPos("1", 264, -264, 100);
    await sleep(250);
    const far = { x: 7000, y: -7000 };
    const pathFar = await session.requestPath("1", far);
    check(!!pathFar && pathFar.unreachable === false, "到对角 (7000,-7000) 算出了路（可达）", pathFar && `points=${pathFar.points.length}`);
    check(!!pathFar && pathFar.points.length > 1, "路点多于一个（不是「直线捅过去」）", pathFar && `points=${pathFar.points.length}`);
    //#endregion

    //#region 三、绕得开墙（核心断言）
    group("三、绕得开墙：逐段 4px 采样，没有一个点落在碰撞盒里");
    {
      const points = [ { x: 264, y: -264 }, ...(pathFar?.points ?? []) ];
      let blocked = null;
      for (let index = 1; index < points.length && !blocked; index += 1) {
        blocked = firstBlockedPoint(boxes, points[index - 1], points[index]);
      }
      check(!blocked, "整条路（含起点）没有穿过任何碰撞盒", blocked && `在 (${blocked.x.toFixed(0)}, ${blocked.y.toFixed(0)}) 撞上`);
      const straight = Math.hypot(far.x - 264, far.y + 264);
      const length = polylineLength(points);
      check(length >= straight * 0.99, "路点长度不小于直线距离（几何自洽）", `路点 ${length.toFixed(0)}px / 直线 ${straight.toFixed(0)}px`);
      // 真实地图 161 个盒子，绕行必然比 issue 的合成场景（3 个盒子）长 —— 锁 3 倍是「没有绕远路」的判据
      check(length <= straight * 3, "绕行倍率 < 3（没有绕出远路）", `比值 ${(length / straight).toFixed(2)}`);
      // 坐标落在格心上 = 服务端用的是 auto_battle.cellSize（与客户端同一张网格）
      const midPoints = (pathFar?.points ?? []).slice(0, -1);
      const onCellCenter = midPoints.every(
        (point) => Math.abs((point.x - cellSize / 2) % cellSize) < 0.01 || Math.abs(point.x % cellSize) < 0.01,
      );
      check(midPoints.length === 0 || onCellCenter, "中间路点是格心（网格口径 = auto_battle.cellSize）", `cellSize=${cellSize}`);
    }
    //#endregion

    //#region 四、拉直有效
    group("四、拉直有效：同一片开阔区域里两点，路点长度贴近直线");
    {
      // (264,-264) → (464,-264)：这一段没有盒子（准备段按「附近 150px 无盒」挑的点）
      const near = { x: 464, y: -264 };
      check(!insideAnyBox(boxes, near.x, near.y), "准备：目标点在开阔地（不在任何盒子里）");
      const pathNear = await session.requestPath("1", near);
      check(!!pathNear && pathNear.unreachable === false, "短距离也能算出路");
      const total = polylineLength([{ x: 264, y: -264 }, ...(pathNear?.points ?? [])]);
      const straight = Math.hypot(near.x - 264, near.y + 264);
      check(total <= straight * 1.25, "开阔直线上的路点长度 < 直线 × 1.25（拉直生效）", `路点 ${total.toFixed(0)}px / 直线 ${straight.toFixed(0)}px`);
      check((pathNear?.points ?? []).length <= 2, "路点不多于 2 个（没有被切成每格一个点）", `points=${pathNear?.points?.length}`);
    }
    //#endregion

    //#region 五、目标在墙里 → 吸附
    group("五、目标点落在碰撞盒里：吸附到最近可站立格（snapped）");
    {
      // 挑「中等大小」的盒子：太大了目标格 6 圈内找不到可站立格（吸附半径是 6 格 × cellSize）
      const box = boxes.find((item) => item.w >= 64 && item.h >= 64 && item.w <= 160 && item.h <= 160);
      check(!!box, "准备：挑到一个够大的盒子当目标点", box && JSON.stringify(box));
      if (box) {
        const inWall = { x: box.cx, y: box.cy };
        const snappedPath = await session.requestPath("1", inWall);
        check(!!snappedPath && snappedPath.unreachable === false, "点在墙里也能给出路（吸附后可站）", snappedPath && `points=${snappedPath.points.length}`);
        check(snappedPath?.snapped === true, "回执标了 snapped（客户端据此提示「走不到那儿」）");
        const last = snappedPath?.points?.[snappedPath.points.length - 1];
        check(!!last && (Math.abs(last.x - inWall.x) > 1 || Math.abs(last.y - inWall.y) > 1), "末点不是原目标（被挪到了能站的地方）", last && `末点 (${last.x.toFixed(0)}, ${last.y.toFixed(0)})`);
      }
    }
    //#endregion

    //#region 六、图外 → 不可达
    group("六、目标在图外：unreachable（不给路）");
    const outside = await session.requestPath("1", { x: 99999, y: -100 });
    check(!!outside && outside.unreachable === true, "图外的点判不可达");
    checkEqual(outside?.points?.length, 0, "不可达时 points 为空");
    const negative = await session.requestPath("1", { x: 100, y: 500 });
    check(!!negative && negative.unreachable === true, "y 为正（图外上方）同样判不可达 —— 世界坐标 y 恒为负");
    //#endregion

    //#region 七、格参数热切
    group("七、格参数改了立刻生效（读 auto_battle，没有第二份常量）");
    {
      const before = await session.requestPath("1", { x: 1200, y: -1200 });
      const patched = await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { autoBattle: { cellSize: 80 } } });
      check(patched.body?.data?.autoBattle?.cellSize === 80, "cellSize 改成 80");
      const after = await session.requestPath("1", { x: 1200, y: -1200 });
      check(!!after && after.unreachable === false, "换格尺寸后照样能算出路");
      const centers = (after?.points ?? []).slice(0, -1);
      const onEighty = centers.every((point) => Math.abs((point.x - 40) % 80) < 0.01 || Math.abs(point.x % 80) < 0.01);
      check(centers.length === 0 || onEighty, "中间路点变成 80 格心（没有缓存旧网格）", `points=${centers.length}`);
      check(!!before, "（对照）改之前也算出过路");
      await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, body: { autoBattle: { cellSize: 40 } } });
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
