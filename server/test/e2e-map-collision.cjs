#!/usr/bin/env node
/**
 * 服务端 e2e：地图上的碰撞多边形（#676 起归后台；#1190 从矩形升级为多边形）
 *
 * 这一套钉住的是「**地图文件从此只做显示**」这件事的最后一块：
 *
 * 1. **出厂就有**：0 号图的四面围墙在 `map_collisions` 里（config-sync 灌的，#1150 换图后
 *    只有图 0 带围墙），顶点是 JSON `[[x,y],...]` 世界坐标（y 轴向上，故绝大多数 y 为负）。
 *    断言「所有顶点 y ≤ 1000 且至少一个 y < 0」就是「忘了把 y 取反会整批变正几千」的判据。
 * 2. **能画**：POST 一圈顶点 → 入库、详情多一行、列表 `collisionCount` 跟着变。
 * 3. **语义校验**：顶点 3~64、每个顶点是 [x, y] 数字、相邻顶点间距 ≥ 1px、**不自交**；
 *    图必须存在且有几何。**故意不判「在图内」** —— 见下一条。
 * 4. **越界是合法的，但「整块在图外」要标出来**：四面围墙本来就画在图外（`x = -64`），
 *    半截在外是正常数据；整块在外才是「画面上完全看不到」，只标 `fullyOutside`，不拒。
 * 5. **能改能删**：PATCH 整份覆盖（拖顶点 / 增删点是同一次动作）；删完再删 404；跨图 404。
 * 6. **快照**：玩家侧 `GET /game-config` 的 `maps[].collisions` 跟着改，且字段是
 *    `points`（下发客户端用，客户端拿到直接建多边形碰撞体，不需要任何换算）。
 * 7. **权限与契约**：观察员能读、写 403；三个 operation 在 openapi.json 里，
 *    写模型没有 `mapId` / `id`（路径里已经有了）。
 *
 * ⚠️ 关于 `fullyOutside`：这一栏算错过一次（`top <= 0` 当成「在图上方」，导致 0 号图
 * 99 个里 97 个亮红灯）。所以这里除了「整块在外 → true」，还要有「半截在外 → false」
 * 和「图内的障碍 → false」两条反面判据，方向写反时三条会同时红。
 *
 * 用法：npm run test:e2e:map-collision（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "mapbox-code";

//#region 断言小工具（与其余几套同一骨架）

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

/** 取一个空闲端口 */
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

/** 起一台服务并等它就绪（内存库：每次跑都是出厂形态，碰撞多边形来自 config-sync.sql） */
async function startServer(env) {
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
      JWT_SECRET: "e2e-map-collision-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM") };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
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

/** 注册并登录一个管理员，返回 token（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "/api/admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return retry.body?.data?.token;
}

/** 注册并登录一个玩家，返回 token（配置快照要玩家令牌） */
async function registerPlayer(baseUrl, username) {
  const login = await api(baseUrl, "POST", "/api/auth/login", { body: { username, password: "pass1234" } });
  if (login.body?.data?.token) return login.body.data.token;
  const registered = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password: "pass1234" } });
  return registered.body?.data?.token;
}

/** 矩形（中心 + 宽高）→ 等价四点多边形（造数据用；0 号图 #1150 换图后是 2304×1856） */
function rectPoints(cx, cy, w, h) {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

/** 0 号图上一个图内的多边形（默认 = 中心 (1200, -900) 的 256×128 四边形） */
function polyOf(overrides = {}) {
  return { points: rectPoints(1200, -900, 256, 128), ...overrides };
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "mapboxroot", "MapBox#1");
    check(Boolean(token), "超管注册并登录成功");

    //#region 一、出厂状态

    group("一、出厂状态：围墙多边形来自 config-sync，顶点是世界坐标");

    const list = await api(base, "GET", "/api/admin/maps", { token });
    const rows = list.body?.data?.list ?? [];
    check(rows.length > 0, "地图列表有行（具体几张由资源清单决定）", String(rows.length));
    check(
      rows.some((row) => row.id === "0" && row.collisionCount > 0),
      "0 号图出厂就有碰撞多边形（#1150 换图后只有图 0 带四面围墙，其余图等运营画）",
    );

    const detail = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(detail.status, 200, "能读 0 号图详情");
    const boxes = detail.body?.data?.collisions ?? [];
    check(boxes.length > 0, "0 号图出厂就有碰撞多边形");
    checkEqual(boxes.length, detail.body?.data?.collisionCount, "详情条数与列表计数一致（同一张表，不做两处口径）");
    // y 轴向上、图占 y ∈ [-H, 0]：忘了取反的话这一批顶点会全变成正几千。
    // 围墙允许半截在图外（上墙顶点 y 为小正数），所以只判方向口径、不锁 y ≤ 0
    check(
      boxes.every((item) => item.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && y <= 1000)),
      "全部顶点 y ≤ 1000（世界坐标口径：y 轴向上，忘取反会是正几千）",
    );
    check(
      boxes.every((item) => item.points.length >= 3 && item.points.some(([, y]) => y < 0)),
      "每个多边形 ≥3 个顶点、至少一个顶点 y < 0（图在 y 负半轴）",
    );
    check(
      boxes.every((item) => Number.isInteger(item.id) && item.id > 0),
      "每行都带库里的 id（改 / 删用它定位 —— 碰撞多边形没有名字）",
    );
    // 反面判据：四面围墙是**半截**在图外（x = -64 起），不该被当成「整块在外」
    checkEqual(
      boxes.filter((item) => item.fullyOutside).length,
      0,
      "0 号图没有整块在图外的多边形（围墙半截在外不算；判据方向写反会整批红）",
    );

    //#endregion

    //#region 二、画一个

    group("二、画一个：点一圈顶点 → 入库 → 计数跟着变");

    const created = await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: polyOf() });
    checkEqual(created.status, 201, "绘制返回 201");
    const box = created.body?.data ?? {};
    check(Number.isInteger(box.id) && box.id > 0, "返回带库里的行 id");
    checkEqual(box.points.length, 4, "顶点数原样存下");
    checkEqual(box.points[0][0], 1072, "顶点 x 原样存下");
    checkEqual(box.points[0][1], -964, "顶点 y 原样存下（y 轴向上，故为负）");
    checkEqual(box.fullyOutside, false, "图内的多边形不标「整块在图外」");
    checkEqual(
      Object.keys(box).sort().join(","),
      "fullyOutside,id,points",
      "回显字段就这三个（没有 inBounds —— 碰撞多边形不做越界判定）",
    );

    const afterCreate = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterCreate.body?.data?.collisions?.length, boxes.length + 1, "详情多了一行");
    checkEqual(
      afterCreate.body?.data?.collisionCount,
      boxes.length + 1,
      "列表计数跟着变（详情继承列表字段，不做两处口径）",
    );

    // 拖出来的浮点收到两位（与刷怪区同口径：`123.4567` 进库没有意义）
    const rounded = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: polyOf({ points: rectPoints(1000.123456, -1000.987654, 33.33333, 44.44444) }),
    });
    checkEqual(rounded.status, 201, "带小数的顶点也收");
    checkEqual(rounded.body?.data?.points[0][0], 983.46, "x 收两位小数");
    checkEqual(rounded.body?.data?.points[0][1], -1023.21, "y 收两位小数（负数不是截断成 -1023.22）");
    await api(base, "DELETE", `/api/admin/maps/0/collisions/${rounded.body?.data?.id}`, { token });

    //#endregion

    //#region 三、语义校验

    group("三、校验：顶点数 / 边长 / 自交 / 图存在；越界**不**拦");

    const tooFew = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: polyOf({ points: [[0, -100], [100, -100]] }),
    });
    checkEqual(tooFew.status, 400, "2 个顶点 → 400（封闭最少要 3 点）");
    checkEqual(tooFew.body?.code, 40000, "业务码是 PARAM_INVALID");
    check(
      String(tooFew.body?.message ?? "").includes("3"),
      `文案说得出顶点下限（实际：「${tooFew.body?.message ?? ""}」）`,
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: { points: "abc" } })).status,
      400,
      "顶点不是数组 → 400（DTO 就拦下了，没进业务层）",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", {
        token,
        body: polyOf({ points: [[0, -100], ["a", -100], [100, -200]] }),
      })).status,
      400,
      "顶点坐标不是数字 → 400",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", {
        token,
        body: polyOf({ points: [[0, -100], [0.5, -100], [100, -200]] }),
      })).status,
      400,
      "相邻顶点间距 0.5px < 1px → 400（重复点 / 抖动点）",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", {
        token,
        // 蝴蝶结：两条对角边相交
        body: polyOf({ points: [[0, -100], [100, -200], [100, -100], [0, -200]] }),
      })).status,
      400,
      "自交（蝴蝶结）→ 400（射线法判不出哪边是里面）",
    );
    check(
      String(
        (
          await api(base, "POST", "/api/admin/maps/0/collisions", {
            token,
            body: polyOf({ points: [[0, -100], [100, -200], [100, -100], [0, -200]] }),
          })
        ).body?.message ?? "",
      ).includes("自交"),
      "自交文案说得出「不能自交」",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/99/collisions", { token, body: polyOf() })).status,
      404,
      "不存在的图 → 404（没有几何就没法判 fullyOutside）",
    );

    // 越界允许：这是这一轮最容易被「顺手加个校验」破坏的一条
    const outside = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: polyOf({ points: rectPoints(20000, -100, 100, 100) }),
    });
    checkEqual(outside.status, 201, "整块画在图外 → 仍然收下（围墙就在图外，不能拒）");
    checkEqual(outside.body?.data?.fullyOutside, true, "但它被标成「整块在图外」（画面上看不到）");

    const straddle = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      // 左墙同款：x 从 -64 跨到 128，半截在图外
      body: polyOf({ points: [[-64, -100], [128, -100], [128, -220], [-64, -220]] }),
    });
    checkEqual(straddle.status, 201, "半截在图外的围墙也收");
    checkEqual(straddle.body?.data?.fullyOutside, false, "半截在外不算「整块在图外」（判据方向就在这里）");

    const belowMap = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: polyOf({ points: rectPoints(4096, -9000, 200, 200) }),
    });
    checkEqual(belowMap.body?.data?.fullyOutside, true, "整块在图下方之外也算整块在外（y 轴向上的那一侧）");

    for (const extra of [outside, straddle, belowMap]) {
      await api(base, "DELETE", `/api/admin/maps/0/collisions/${extra.body?.data?.id}`, { token });
    }
    checkEqual(
      (await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.collisions?.length,
      boxes.length + 1,
      "失败的请求一次都没写进去（校验在落库之前）",
    );

    //#endregion

    //#region 四、改与跨图

    group("四、改：整份覆盖，跨图 404");

    const moved = await api(base, "PATCH", `/api/admin/maps/0/collisions/${box.id}`, {
      token,
      body: polyOf({ points: rectPoints(2000, -2000, 512, 128) }),
    });
    checkEqual(moved.status, 200, "修改返回 200");
    checkEqual(moved.body?.data?.id, box.id, "改的是同一行（没有变成「删了再建」）");
    checkEqual(moved.body?.data?.points[0][0], 1744, "顶点已挪");
    checkEqual(moved.body?.data?.points.length, 4, "顶点数可以一并改（拖顶点 / 增删点是同一次动作）");

    const crossMap = await api(base, "PATCH", `/api/admin/maps/3/collisions/${box.id}`, {
      token,
      body: polyOf({ points: rectPoints(1000, -1000, 64, 64) }),
    });
    checkEqual(crossMap.status, 404, "拿 0 号图的行 id 去改 3 号图 → 404");
    checkEqual(crossMap.body?.code, 50036, "业务码是 MAP_COLLISION_NOT_FOUND");

    const sibling = (await api(base, "GET", "/api/admin/maps/3", { token })).body?.data?.collisions ?? [];
    check(
      !sibling.some((item) => item.id === box.id),
      "3 号图里没有这行（改的是 id，不是整表）",
    );

    //#endregion

    //#region 五、删

    group("五、删除：删掉就少一行，再删 404");

    const removed = await api(base, "DELETE", `/api/admin/maps/0/collisions/${box.id}`, { token });
    checkEqual(removed.status, 200, "删除返回 200");
    checkEqual(removed.body?.data?.deleted, true, "返回 deleted=true（不是 204 空响应）");
    checkEqual(removed.body?.data?.id, box.id, "返回被删掉的行 id");

    const afterDelete = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterDelete.body?.data?.collisions?.length, boxes.length, "详情回到原来的行数");
    check(
      !(afterDelete.body?.data?.collisions ?? []).some((item) => item.id === box.id),
      "删掉的那一行不在列表里",
    );

    const removeAgain = await api(base, "DELETE", `/api/admin/maps/0/collisions/${box.id}`, { token });
    checkEqual(removeAgain.status, 404, "再删一次 → 404（不是静默成功）");
    checkEqual(removeAgain.body?.code, 50036, "同一个业务码");

    //#endregion

    //#region 六、玩家侧快照

    group("六、快照：客户端拿到的碰撞多边形字段是 points");

    const fresh = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: polyOf({ points: rectPoints(3000, -3000, 64, 64) }),
    });
    const freshId = fresh.body?.data?.id;
    check(Boolean(freshId), "先画一个多边形（后面要在快照里找它）");

    const playerToken = await registerPlayer(base, "mapbox_player");
    check(Boolean(playerToken), "玩家注册并登录成功");

    const snapshot = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(snapshot.status, 200, "玩家令牌拉快照 → 200");
    const map0 = (snapshot.body?.data?.maps ?? []).find((row) => row.id === "0") ?? {};
    const snapBoxes = map0.collisions ?? [];
    checkEqual(snapBoxes.length, boxes.length + 1, "快照里的条数与详情一致（客户端进图就按它铺碰撞体）");
    const hit = snapBoxes.find((item) => item.points?.[0]?.[0] === 2968 && item.points?.[0]?.[1] === -3032) ?? null;
    check(Boolean(hit), "刚画的那个多边形出现在快照里（重进游戏就生效）");
    checkEqual(
      Object.keys(hit ?? {}).sort().join(","),
      "points",
      "下发字段只有 points（客户端直接建多边形碰撞体，不需要 cx/cy 与 x/y/w/h 两套名字）",
    );
    check(
      snapBoxes.every((item) => Array.isArray(item.points) && item.points.length >= 3),
      "快照里每个多边形 ≥3 个顶点（坏行在下发前就被跳过）",
    );

    await api(base, "DELETE", `/api/admin/maps/0/collisions/${freshId}`, { token });

    //#endregion

    //#region 七、权限

    group("七、权限：观察员能读，写 403；无令牌 401");

    const viewerToken = await registerAdmin(base, "mapboxviewer", "MapBox#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token })).body?.data?.list?.find(
      (row) => row.username === "mapboxviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    checkEqual((await api(base, "GET", "/api/admin/maps/0", { token: viewerToken, zoneId: ADMIN_ZONE })).status, 200, "观察员可读详情");
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", { token: viewerToken, zoneId: ADMIN_ZONE, body: polyOf() })).status,
      403,
      "观察员画碰撞多边形 → 403（他没有 gameConfig:write）",
    );
    checkEqual(
      (await api(base, "DELETE", "/api/admin/maps/0/collisions/1", { token: viewerToken, zoneId: ADMIN_ZONE })).status,
      403,
      "观察员删碰撞多边形 → 403",
    );
    checkEqual((await api(base, "POST", "/api/admin/maps/0/collisions", { body: polyOf() })).status, 401, "无令牌 → 401");

    //#endregion

    //#region 八、文档契约

    group("八、文档契约：三个 operation + 两个模型");

    const docsResponse = await fetch(`${base}/api-docs-json`);
    const doc = await docsResponse.json();
    checkEqual(docsResponse.status, 200, "能取到 openapi.json");
    const pathNew = doc.paths?.["/api/admin/maps/{id}/collisions"];
    const pathRow = doc.paths?.["/api/admin/maps/{id}/collisions/{boxId}"];
    check(Boolean(pathNew?.post), "POST /admin/maps/{id}/collisions 在文档里");
    check(Boolean(pathRow?.patch), "PATCH /admin/maps/{id}/collisions/{boxId} 在文档里");
    check(Boolean(pathRow?.delete), "DELETE 同路径也在文档里");
    checkEqual(pathNew?.post?.operationId, "adminMap.createCollision", "绘制的 operationId 稳定（生成物按它建方法名）");
    checkEqual(pathRow?.patch?.operationId, "adminMap.updateCollision", "修改的 operationId");
    checkEqual(pathRow?.delete?.operationId, "adminMap.deleteCollision", "删除的 operationId");
    checkEqual(pathNew?.post?.["x-olua-permissions"]?.join(","), "gameConfig:write", "绘制要写权限");

    const schemas = doc.components?.schemas ?? {};
    checkEqual(
      Object.keys(schemas.SaveMapCollisionDto?.properties ?? {}).sort().join(","),
      "points",
      "写模型一个字段：**没有 mapId / id**（路径里已经有了）",
    );
    checkEqual(
      pathNew?.post?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapCollisionDto",
      "绘制回显的是这一行的 DTO（前端直接铺回画布）",
    );
    checkEqual(
      Object.keys(schemas.MapCollisionPolygonDto?.properties ?? {}).sort().join(","),
      "points",
      "下发模型只有几何（`MapCollisionPolygonDto` 就是客户端那个 `MapCollisionPolygon`）",
    );

    //#endregion
  } finally {
    server.kill();
  }
}

//#endregion

main()
  .then(() => {
    if (failed) {
      console.log(`\n❌ 服务端 e2e（地图碰撞多边形）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（地图碰撞多边形）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
