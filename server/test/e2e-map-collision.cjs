#!/usr/bin/env node
/**
 * 服务端 e2e：地图上的碰撞盒（#676）
 *
 * 这一套钉住的是「**地图文件从此只做显示**」这件事的最后一块：
 *
 * 1. **出厂就有**：11 张图的碰撞盒由 `db:migrate-map-collisions` 从 TMX 的 `collision`
 *    对象组搬进 `map_collisions`，坐标是世界坐标（`cy` 为负 / 0）。断言 `cy <= 0` 就是
 *    「迁移脚本没忘了把 y 取反」的判据 —— 忘了取反会整批变成正数。
 * 2. **能画**：POST 一个框 → 入库、详情多一行、列表 `collisionCount` 跟着变。
 * 3. **只校验两件事**：宽高 ≥ 1px（拖出来一个 0 宽的框等于没画）；图必须存在且有几何。
 *    **故意不判「在图内」** —— 见下一条。
 * 4. **越界是合法的，但「整块在图外」要标出来**：四面围墙本来就画在图外（`x = -64`、宽 8320），
 *    半截在外是正常数据；整块在外才是「画面上完全看不到」，只标 `fullyOutside`，不拒。
 * 5. **能改能删**：PATCH 整份覆盖（挪位置 = 改尺寸同一次动作）；删完再删 404；跨图 404。
 * 6. **快照**：玩家侧 `GET /game-config` 的 `maps[].collisions` 跟着改，且字段是
 *    `x / y / w / h`（下发客户端用，与 `cx / cy` 刻意不同名 —— 客户端拿到直接建节点）。
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

/** 起一台服务并等它就绪（内存库：每次跑都是出厂形态，碰撞盒来自 config-sync.sql） */
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

/** 注册并登录一个管理员，返回 token（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "/api/admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  return retry.body?.data?.token;
}

/** 注册并登录一个玩家，返回 token（配置快照要玩家令牌） */
async function registerPlayer(baseUrl, username) {
  const login = await api(baseUrl, "POST", "/api/auth/login", { body: { username, password: "pass1234" } });
  if (login.body?.data?.token) return login.body.data.token;
  const registered = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password: "pass1234" } });
  return registered.body?.data?.token;
}

/** 0 号图（8192×8192）上一个图内的框 */
function boxOf(overrides = {}) {
  return { cx: 4096, cy: -4096, w: 256, h: 128, ...overrides };
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "mapboxroot", "MapBox#1");
    check(Boolean(token), "超管注册并登录成功");

    //#region 一、出厂状态

    group("一、出厂状态：碰撞盒来自 TMX 迁移，坐标是世界坐标");

    const list = await api(base, "GET", "/api/admin/maps", { token });
    const rows = list.body?.data?.list ?? [];
    check(rows.length > 0, "地图列表有行（具体几张由资源清单决定）", String(rows.length));
    check(
      rows.every((row) => typeof row.collisionCount === "number" && row.collisionCount > 0),
      "每张图都有碰撞盒（collisionCount 来自 map_collisions 的行数）",
    );

    const detail = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(detail.status, 200, "能读 0 号图详情");
    const boxes = detail.body?.data?.collisions ?? [];
    check(boxes.length > 0, "0 号图出厂就有碰撞盒");
    checkEqual(boxes.length, detail.body?.data?.collisionCount, "详情条数与列表计数一致（同一张表，不做两处口径）");
    // y 轴向上、图占 y ∈ [-H, 0]：忘了取反的话这一批会全变成正数
    check(boxes.every((item) => item.cy <= 0), "全部碰撞盒的 cy ≤ 0（世界坐标口径：y 轴向上）");
    check(boxes.every((item) => item.w > 0 && item.h > 0), "全部碰撞盒宽高为正（零面积的在迁移时被跳过）");
    check(
      boxes.every((item) => Number.isInteger(item.id) && item.id > 0),
      "每行都带库里的 id（改 / 删用它定位 —— 碰撞盒没有名字）",
    );
    // 反面判据：四面围墙是**半截**在图外（x = -64、宽 8320），不该被当成「整块在外」
    checkEqual(
      boxes.filter((item) => item.fullyOutside).length,
      0,
      "0 号图没有整块在图外的盒子（围墙半截在外不算；判据方向写反会是 97）",
    );

    //#endregion

    //#region 二、画一个

    group("二、画一个：拖框 → 入库 → 计数跟着变");

    const created = await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: boxOf() });
    checkEqual(created.status, 201, "绘制返回 201");
    const box = created.body?.data ?? {};
    check(Number.isInteger(box.id) && box.id > 0, "返回带库里的行 id");
    checkEqual(box.cx, 4096, "世界坐标 x 原样存下");
    checkEqual(box.cy, -4096, "世界坐标 y 原样存下（y 轴向上，故为负）");
    checkEqual(box.w, 256, "宽原样存下");
    checkEqual(box.h, 128, "高原样存下");
    checkEqual(box.fullyOutside, false, "图内的框不标「整块在图外」");
    checkEqual(
      Object.keys(box).sort().join(","),
      "cx,cy,fullyOutside,h,id,w",
      "回显字段就这六个（没有 inBounds —— 碰撞盒不做越界判定）",
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
      body: boxOf({ cx: 1000.123456, cy: -1000.987654, w: 33.33333, h: 44.44444 }),
    });
    checkEqual(rounded.status, 201, "带小数的框也收");
    checkEqual(rounded.body?.data?.cx, 1000.12, "x 收两位小数");
    checkEqual(rounded.body?.data?.cy, -1000.99, "y 收两位小数（负数不是截断成 -1000.98）");
    checkEqual(rounded.body?.data?.w, 33.33, "宽收两位小数");
    await api(base, "DELETE", `/api/admin/maps/0/collisions/${rounded.body?.data?.id}`, { token });

    //#endregion

    //#region 三、只校验两件事

    group("三、校验：宽高不能是 0，图必须存在；越界**不**拦");

    const tooThin = await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: boxOf({ w: 0 }) });
    checkEqual(tooThin.status, 400, "宽 0 → 400（拖出来的零宽框等于没画）");
    checkEqual(tooThin.body?.code, 40000, "业务码是 PARAM_INVALID");
    check(
      String(tooThin.body?.message ?? "").includes("1"),
      `文案说得出下限（实际：「${tooThin.body?.message ?? ""}」）`,
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: boxOf({ h: 0.4 }) })).status,
      400,
      "高 0.4 收两位后变 0.4 → 仍小于 1 → 400",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: { cx: "abc", cy: -1, w: 10, h: 10 } })).status,
      400,
      "中心不是数字 → 400（DTO 就拦下了，没进业务层）",
    );
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/99/collisions", { token, body: boxOf() })).status,
      404,
      "不存在的图 → 404（没有几何就没法判 fullyOutside）",
    );

    // 越界允许：这是这一轮最容易被「顺手加个校验」破坏的一条
    const outside = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: { cx: 20000, cy: -100, w: 100, h: 100 },
    });
    checkEqual(outside.status, 201, "整块画在图外 → 仍然收下（围墙就在图外，不能拒）");
    checkEqual(outside.body?.data?.fullyOutside, true, "但它被标成「整块在图外」（画面上看不到）");

    const straddle = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: { cx: 4096, cy: 0, w: 8320, h: 128 },
    });
    checkEqual(straddle.status, 201, "半截在图外的围墙也收");
    checkEqual(straddle.body?.data?.fullyOutside, false, "半截在外不算「整块在图外」（判据方向就在这里）");

    const belowMap = await api(base, "POST", "/api/admin/maps/0/collisions", {
      token,
      body: { cx: 4096, cy: -9000, w: 200, h: 200 },
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
      body: { cx: 2000, cy: -2000, w: 512, h: 128 },
    });
    checkEqual(moved.status, 200, "修改返回 200");
    checkEqual(moved.body?.data?.id, box.id, "改的是同一行（没有变成「删了再建」）");
    checkEqual(moved.body?.data?.cx, 2000, "位置已挪");
    checkEqual(moved.body?.data?.w, 512, "尺寸也一起改了（挪位置与改尺寸是同一次动作）");

    const crossMap = await api(base, "PATCH", `/api/admin/maps/3/collisions/${box.id}`, {
      token,
      body: boxOf({ cx: 1000, cy: -1000 }),
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

    group("六、快照：客户端拿到的碰撞盒字段是 x / y / w / h");

    const fresh = await api(base, "POST", "/api/admin/maps/0/collisions", { token, body: boxOf({ cx: 3000, cy: -3000 }) });
    const freshId = fresh.body?.data?.id;
    check(Boolean(freshId), "先画一个盒子（后面要在快照里找它）");

    const playerToken = await registerPlayer(base, "mapbox_player");
    check(Boolean(playerToken), "玩家注册并登录成功");

    const snapshot = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(snapshot.status, 200, "玩家令牌拉快照 → 200");
    const map0 = (snapshot.body?.data?.maps ?? []).find((row) => row.id === "0") ?? {};
    const snapBoxes = map0.collisions ?? [];
    checkEqual(snapBoxes.length, boxes.length + 1, "快照里的条数与详情一致（客户端进图就按它铺碰撞体）");
    const hit = snapBoxes.find((item) => item.x === 3000 && item.y === -3000) ?? null;
    check(Boolean(hit), "刚画的那个盒子出现在快照里（重进游戏就生效）");
    checkEqual(
      Object.keys(hit ?? {}).sort().join(","),
      "h,w,x,y",
      "下发字段是 x / y / w / h（客户端 setWorldPosition + new Size，不需要 cx/cy）",
    );
    check(
      snapBoxes.every((item) => item.y <= 0 && item.w > 0 && item.h > 0),
      "快照里每个盒子的 y ≤ 0、宽高为正（零面积的在下发前被过滤）",
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

    checkEqual((await api(base, "GET", "/api/admin/maps/0", { token: viewerToken })).status, 200, "观察员可读详情");
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/collisions", { token: viewerToken, body: boxOf() })).status,
      403,
      "观察员画碰撞盒 → 403（他没有 gameConfig:write）",
    );
    checkEqual(
      (await api(base, "DELETE", "/api/admin/maps/0/collisions/1", { token: viewerToken })).status,
      403,
      "观察员删碰撞盒 → 403",
    );
    checkEqual((await api(base, "POST", "/api/admin/maps/0/collisions", { body: boxOf() })).status, 401, "无令牌 → 401");

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
      "cx,cy,h,w",
      "写模型四个字段：**没有 mapId / id**（路径里已经有了盒子）",
    );
    checkEqual(
      pathNew?.post?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapCollisionDto",
      "绘制回显的是这一行的 DTO（前端直接铺回画布）",
    );
    checkEqual(
      Object.keys(schemas.MapCollisionBoxDto?.properties ?? {}).sort().join(","),
      "h,w,x,y",
      "下发模型只有几何（`MapCollisionBoxDto` 就是客户端那个 `MapCollisionBox`）",
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
      console.log(`\n❌ 服务端 e2e（地图碰撞盒）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（地图碰撞盒）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
