#!/usr/bin/env node
/**
 * 服务端 e2e：地图上的 NPC 点位与复活点（#672）
 *
 * 这一套钉住的是「**点位从此归后台**」这件事本身，而不只是接口能通：
 *
 * 1. **出厂就有**：11 张图各 1 个 NPC（`0002`）+ 1 个复活点，坐标是世界坐标（`cy` 为负），
 *    与 TMX 里的 y 只差一次取反 —— 这条断言就是「迁移脚本没算错」的判据。
 * 2. **能放**：POST 一个点 → 入库、详情多一行、列表计数跟着变。
 * 3. **三道校验都是真的**：NPC 不存在 / 同一个 NPC 在这张图上已有 / 越界，各自一个码。
 * 4. **能改能删**：PATCH 只挪位置（`npcId` 原样带回）；删完再删 404；跨图 404。
 * 5. **复活点是单值**：PUT 覆盖、DELETE 置空、**再 DELETE 也是 200**（幂等 —— 管理端那个
 *    「清除复活点」按钮连点两下不该报错）。
 * 6. **快照**：玩家侧 `GET /game-config` 的 `maps.npcs` / `maps.revive` 跟着改 ——
 *    这决定了「客户端下次进图看到的是新点位还是旧的」。
 * 7. **权限与契约**：观察员能读、写 403；五个 operation 在 openapi.json 里，
 *    写模型不含 `mapId` / `id`（路径里已经有了）。
 *
 * 用法：npm run test:e2e:map-npc（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "mapnpc-code";
// 出厂点位的期望从配置快照取（不锁死数值）：复活点是管理端可拖可清的运营配置，
// 用户拖过地图 0 的复活点之后，锁 4100/-4736 这种出厂数字只会误红 ——
// 钉住的是「详情接口返回的就是库里那一行」，坐标本身以 config-sync.sql 为准
const configSnapshot = require("./lib/config-snapshot.cjs");
const snapshotMap0 = configSnapshot.index("maps", "mapId")["0"] ?? {};

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

/** 起一台服务并等它就绪（内存库：每次跑都是出厂形态，11 个 NPC 点位 + 11 个复活点来自 config-sync.sql） */
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
      JWT_SECRET: "e2e-map-npc-secret",
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

/** 0 号图（8192×8192）上的一个合法点位 */
function pointOf(overrides = {}) {
  return { npcId: "0001", cx: 4000, cy: -4000, ...overrides };
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "mapnpcroot", "MapNpc#1");
    check(Boolean(token), "超管注册并登录成功");

    //#region 一、出厂状态

    group("一、出厂状态：每张图 1 个 NPC + 1 个复活点，坐标是世界坐标");

    const list = await api(base, "GET", "/api/admin/maps", { token });
    const rows = list.body?.data?.list ?? [];
    check(rows.length > 0, "地图列表有行（具体几张由资源清单决定）", String(rows.length));
    check(
      rows.every((row) => row.npcPointCount === 1),
      "列表里每张图都有 1 个 NPC 点位（npcPointCount 来自 map_npcs 的行数）",
    );
    check(
      rows.every((row) => row.hasRevivePoint === true),
      "列表里每张图都标了「有复活点」",
    );

    const detail = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(detail.status, 200, "能读 0 号图详情");
    const points = detail.body?.data?.npcPoints ?? [];
    check(points.length > 0, "0 号图有 NPC 点位（点位数由 map_npcs 决定）", String(points.length));
    const first = points[0] ?? {};
    checkEqual(first.npcId, "0002", "NPC id 来自 TMX 的 id 属性（迁移脚本读的是对象属性，不是对象名）");
    checkEqual(first.npcLabel !== "", true, "NPC 名由服务端查 npcs 表拼出（前端不用认识 id）");
    // 世界坐标：x ∈ [0, 图宽]、y ∈ [-图高, 0]（y 轴向上，与 Tiled 的 y 差一次取反）。
    // 具体点位是资源数据，不钉数值 —— 判方向与形状
    check(Number(first.cx) > 0 && Number(first.cy) <= 0, "世界坐标 x 为正、y 非正（y 轴向上，与 Tiled 差一次取反）", `${first.cx},${first.cy}`);
    checkEqual(first.inBounds, true, "服务端判它在图内");
    check(Number.isInteger(first.id) && first.id > 0, "点位行带库里的 id（改 / 删用它定位）");

    const revive = detail.body?.data?.revivePoint ?? null;
    check(Boolean(revive), "0 号图出厂就带复活点");
    checkEqual(revive?.cx, snapshotMap0.reviveCx, "复活点世界坐标 x（= 快照 maps.reviveCx）");
    checkEqual(revive?.cy, snapshotMap0.reviveCy, "复活点世界坐标 y（= 快照 maps.reviveCy）");
    checkEqual(revive?.inBounds, true, "复活点在图内");

    //#endregion

    //#region 二、放置

    group("二、放置：点一下 → 选 NPC → 入库");

    const created = await api(base, "POST", "/api/admin/maps/0/npcs", { token, body: pointOf() });
    checkEqual(created.status, 201, "放置返回 201");
    const point = created.body?.data ?? {};
    check(Number.isInteger(point.id) && point.id > 0, "返回带库里的行 id");
    checkEqual(point.npcId, "0001", "npcId 原样返回");
    checkEqual(point.cx, 4000, "世界坐标 x 原样存下");
    checkEqual(point.cy, -4000, "世界坐标 y 原样存下（y 轴向上，故为负）");
    checkEqual(point.inBounds, true, "服务端判它在图内");

    const afterCreate = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterCreate.body?.data?.npcPoints?.length, 2, "详情多了 1 行（1 → 2）");
    checkEqual(afterCreate.body?.data?.npcPointCount, 2, "列表计数跟着变（详情继承列表字段，不做两处口径）");

    //#endregion

    //#region 三、三道校验

    group("三、三道校验：NPC 不存在 / 同图重复 / 越界");

    const badNpc = await api(base, "POST", "/api/admin/maps/0/npcs", { token, body: pointOf({ npcId: "no_such_npc" }) });
    checkEqual(badNpc.status, 404, "NPC 不存在 → 404");
    checkEqual(badNpc.body?.code, 50034, "业务码是 MAP_NPC_NOT_FOUND");

    const dup = await api(base, "POST", "/api/admin/maps/0/npcs", { token, body: pointOf() });
    checkEqual(dup.status, 409, "同一个 NPC 在这张图上已有 → 409（(map_id, npc_id) 唯一）");
    checkEqual(dup.body?.code, 20020, "业务码是 MAP_NPC_DUPLICATED");

    // 出厂那个 0002 也算「已经有了」：唯一索引不看它是迁移写进来的还是接口写的
    const dupSeed = await api(base, "POST", "/api/admin/maps/0/npcs", { token, body: pointOf({ npcId: "0002" }) });
    checkEqual(dupSeed.status, 409, "出厂点位同样占位（不是只拦接口新建的）");

    const outside = await api(base, "POST", "/api/admin/maps/0/npcs", { token, body: pointOf({ npcId: "1001", cx: 9000, cy: -100 }) });
    checkEqual(outside.status, 400, "点在图外 → 400（不是静默存进去）");
    checkEqual(outside.body?.code, 40000, "业务码是 PARAM_INVALID");
    check(
      String(outside.body?.message ?? "").includes("8192"),
      `越界文案带上地图尺寸（实际：「${outside.body?.message ?? ""}」）`,
    );

    checkEqual(
      (await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.npcPoints?.length,
      2,
      "三次失败之后库里还是 2 行（失败的请求没有留下半条记录）",
    );

    //#endregion

    //#region 四、改与跨图

    group("四、改：拖动只换坐标，跨图去改 404");

    const moved = await api(base, "PATCH", `/api/admin/maps/0/npcs/${point.id}`, {
      token,
      body: { npcId: "0001", cx: 2000, cy: -2000 },
    });
    checkEqual(moved.status, 200, "修改返回 200");
    checkEqual(moved.body?.data?.id, point.id, "改的是同一行（没有变成「删了再建」）");
    checkEqual(moved.body?.data?.npcId, "0001", "npcId 没变（拖动只换坐标）");
    checkEqual(moved.body?.data?.cx, 2000, "位置已挪");
    checkEqual(moved.body?.data?.cy, -2000, "新坐标已落库");

    const crossMap = await api(base, "PATCH", `/api/admin/maps/3/npcs/${point.id}`, {
      token,
      body: { npcId: "0001", cx: 1000, cy: -1000 },
    });
    checkEqual(crossMap.status, 404, "拿 0 号图的行 id 去改 3 号图 → 404");
    checkEqual(crossMap.body?.code, 50035, "业务码是 MAP_NPC_POINT_NOT_FOUND");

    const unchangedSibling = (await api(base, "GET", "/api/admin/maps/3", { token })).body?.data?.npcPoints ?? [];
    checkEqual(unchangedSibling.length, 1, "3 号图的点位没被顺带改动（改的是 id，不是整表）");

    //#endregion

    //#region 五、删

    group("五、删除：删掉就少一行，再删 404");

    const removed = await api(base, "DELETE", `/api/admin/maps/0/npcs/${point.id}`, { token });
    checkEqual(removed.status, 200, "删除返回 200");
    checkEqual(removed.body?.data?.deleted, true, "返回 deleted=true（不是 204 空响应）");
    checkEqual(removed.body?.data?.id, point.id, "返回被删掉的行 id");

    const afterDelete = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterDelete.body?.data?.npcPoints?.length, 1, "详情回到 1 行");
    check(
      !(afterDelete.body?.data?.npcPoints ?? []).some((item) => item.id === point.id),
      "删掉的那一行不在列表里",
    );

    const removeAgain = await api(base, "DELETE", `/api/admin/maps/0/npcs/${point.id}`, { token });
    checkEqual(removeAgain.status, 404, "再删一次 → 404（不是静默成功）");

    //#endregion

    //#region 六、复活点

    group("六、复活点：单值，PUT 覆盖 / DELETE 置空且幂等");

    const revPut = await api(base, "PUT", "/api/admin/maps/0/revive-point", { token, body: { cx: 1000, cy: -2000 } });
    checkEqual(revPut.status, 200, "设置复活点返回 200");
    checkEqual(revPut.body?.data?.cx, 1000, "新坐标已落库");
    checkEqual(revPut.body?.data?.inBounds, true, "服务端判它在图内");
    checkEqual(
      (await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.revivePoint?.cy,
      -2000,
      "详情里读到的是新值（不是只返回了却没写）",
    );

    const revOverwrite = await api(base, "PUT", "/api/admin/maps/0/revive-point", { token, body: { cx: 3000, cy: -3000 } });
    checkEqual(revOverwrite.status, 200, "再设一次是覆盖（一张图只有一个复活点）");
    checkEqual(revOverwrite.body?.data?.cx, 3000, "覆盖后是新坐标");

    const revOutside = await api(base, "PUT", "/api/admin/maps/0/revive-point", { token, body: { cx: -10, cy: -10 } });
    checkEqual(revOutside.status, 400, "复活点在图外 → 400");
    checkEqual(
      (await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.revivePoint?.cx,
      3000,
      "被拒之后库里还是上一次的值",
    );

    const revCleared = await api(base, "DELETE", "/api/admin/maps/0/revive-point", { token });
    checkEqual(revCleared.status, 200, "清除返回 200");
    checkEqual(revCleared.body?.data?.cleared, true, "返回 cleared=true");
    checkEqual((await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.revivePoint, null, "清除后详情里是 null（不是 (0,0) —— 那会让玩家一进图飞到左上角）");

    const revClearAgain = await api(base, "DELETE", "/api/admin/maps/0/revive-point", { token });
    checkEqual(revClearAgain.status, 200, "再清一次也是 200（幂等：按钮连点两下不该报错）");
    checkEqual(revClearAgain.body?.data?.cleared, true, "幂等时仍然返回 cleared=true");

    //#endregion

    //#region 七、玩家侧快照

    group("七、快照：客户端拿到的点位就是库里的点位");

    const playerToken = await registerPlayer(base, "mapnpc_player");
    check(Boolean(playerToken), "玩家注册并登录成功");

    const snapshot = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(snapshot.status, 200, "玩家令牌拉快照 → 200");
    const snapMaps = snapshot.body?.data?.maps ?? [];
    const map0 = snapMaps.find((row) => row.id === "0") ?? {};
    checkEqual(map0.npcs?.length, points.length, "快照里 0 号图的 NPC 点位数与详情一致（同一份数据）");
    checkEqual(map0.npcs?.[0]?.npcId, "0002", "点位带 npcId（客户端据此查外观）");
    checkEqual(map0.npcs?.[0]?.x, first.cx, "点位下发的是世界坐标 x（客户端不再换算）");
    checkEqual(map0.npcs?.[0]?.y, first.cy, "点位下发的是世界坐标 y");
    checkEqual(map0.revive, null, "刚被清掉的复活点在快照里是 null（客户端据此决定进图要不要定位）");
    check(
      (map0.spawnAreas ?? []).length > 0,
      "刷怪区中心点随快照下发（只给中心与 monsterKey，尺寸与数量不下发）",
    );
    check(
      (map0.spawnAreas ?? []).every((area) => typeof area.monsterKey === "string" && area.cy < 0),
      "区域中心也是世界坐标（cy 为负）",
    );

    //#endregion

    //#region 八、权限

    group("八、权限：观察员能读，写 403；无令牌 401");

    const viewerToken = await registerAdmin(base, "mapnpcviewer", "MapNpc#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token })).body?.data?.list?.find(
      (row) => row.username === "mapnpcviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    checkEqual((await api(base, "GET", "/api/admin/maps/0", { token: viewerToken, zoneId: ADMIN_ZONE })).status, 200, "观察员可读详情");
    checkEqual(
      (await api(base, "POST", "/api/admin/maps/0/npcs", { token: viewerToken, zoneId: ADMIN_ZONE, body: pointOf({ npcId: "1001" }) })).status,
      403,
      "观察员放 NPC → 403（他没有 gameConfig:write）",
    );
    checkEqual(
      (await api(base, "PUT", "/api/admin/maps/0/revive-point", { token: viewerToken, zoneId: ADMIN_ZONE, body: { cx: 100, cy: -100 } })).status,
      403,
      "观察员设复活点 → 403",
    );
    checkEqual((await api(base, "DELETE", "/api/admin/maps/0/revive-point", { token: viewerToken, zoneId: ADMIN_ZONE })).status, 403, "观察员清复活点 → 403");
    checkEqual((await api(base, "POST", "/api/admin/maps/0/npcs", { body: pointOf() })).status, 401, "无令牌 → 401");

    //#endregion

    //#region 九、文档契约

    group("九、文档契约：五个 operation + 两个写模型");

    const docsResponse = await fetch(`${base}/api-docs-json`);
    const doc = await docsResponse.json();
    checkEqual(docsResponse.status, 200, "能取到 openapi.json");
    const npcPath = doc.paths?.["/api/admin/maps/{id}/npcs"];
    const npcRowPath = doc.paths?.["/api/admin/maps/{id}/npcs/{npcRowId}"];
    const revivePath = doc.paths?.["/api/admin/maps/{id}/revive-point"];
    check(Boolean(npcPath?.post), "POST /admin/maps/{id}/npcs 在文档里");
    check(Boolean(npcRowPath?.patch), "PATCH /admin/maps/{id}/npcs/{npcRowId} 在文档里");
    check(Boolean(npcRowPath?.delete), "DELETE 同路径也在文档里");
    check(Boolean(revivePath?.put), "PUT /admin/maps/{id}/revive-point 在文档里");
    check(Boolean(revivePath?.delete), "DELETE 同路径也在文档里");
    checkEqual(npcPath?.post?.operationId, "adminMap.createNpc", "放置的 operationId 稳定（生成物按它建方法名）");
    checkEqual(npcRowPath?.patch?.operationId, "adminMap.updateNpc", "修改的 operationId");
    checkEqual(npcRowPath?.delete?.operationId, "adminMap.deleteNpc", "删除的 operationId");
    checkEqual(revivePath?.put?.operationId, "adminMap.setRevivePoint", "设复活点的 operationId");
    checkEqual(revivePath?.delete?.operationId, "adminMap.clearRevivePoint", "清复活点的 operationId");
    checkEqual(
      npcPath?.post?.["x-olua-permissions"]?.join(","),
      "gameConfig:write",
      "放置要写权限（读权限的人只能看）",
    );
    checkEqual(revivePath?.put?.["x-olua-permissions"]?.join(","), "gameConfig:write", "设复活点也要写权限");

    const schemas = doc.components?.schemas ?? {};
    checkEqual(
      Object.keys(schemas.SaveMapNpcDto?.properties ?? {}).sort().join(","),
      "cx,cy,npcId",
      "写模型三个字段：**没有 mapId / id**（路径里已经有点位了）",
    );
    checkEqual(
      Object.keys(schemas.SaveRevivePointDto?.properties ?? {}).sort().join(","),
      "cx,cy",
      "复活点写模型只有坐标（一张图一个，没有别的可填）",
    );
    checkEqual(
      npcPath?.post?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapNpcDto",
      "放置回显的是这一行的 DTO（前端直接铺回画布）",
    );
    checkEqual(
      revivePath?.put?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapRevivePointDto",
      "设复活点回显 MapRevivePointDto（管理端 cx/cy、下发客户端 x/y，刻意不同名）",
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
      console.log(`\n❌ 服务端 e2e（NPC 点位与复活点）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（NPC 点位与复活点）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
