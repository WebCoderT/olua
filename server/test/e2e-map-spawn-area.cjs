#!/usr/bin/env node
/**
 * 服务端 e2e：刷怪区后台绘制（#667）
 *
 * 这一套钉住的是「**刷怪区从此归后台**」这件事本身，而不只是三个接口能通：
 *
 * 1. **能建**：给一个矩形 + 怪物 + 数量 → 入库、详情多一行、`min === max === count`
 *    （表里两列，接口只收一个数 —— 这条断言就是「只收一个数」的落库形态）。
 * 2. **四道校验都是真的**：怪物 key 不存在 / 同图重名 / 矩形太小 / 越界，各自一个码。
 *    越界尤其重要：以前导入时只告警（#586 的取舍），现在人在图上画，没有理由放行。
 * 3. **能改能删**：改怪、改数量、改位置；删掉之后详情少一行、再删一次 404。
 * 4. **跨图隔离**：拿 3 号图的 areaId 去改 0 号图 → 404（否则「改 A 图影响了 B 图」这种
 *    事故只能靠人发现）。
 * 5. **权限**：观察员能读、写 403；无令牌 401。
 * 6. **文档契约**：三个 operation 在 openapi.json 里，写模型是 `SaveSpawnArea`（五个字段，
 *    没有 mapId / id —— 路径里的东西不进 body）。
 *
 * 用法：npm run test:e2e:map-spawn-area（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "spawn-code";

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

/** 起一台服务并等它就绪（内存库：每次跑都是出厂形态，62 个区域来自 config-sync.sql） */
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
      JWT_SECRET: "e2e-spawn-area-secret",
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

/** 一个合法的矩形（世界坐标；0 号图 8192×8192，所以远在图内） */
function boxOf(overrides = {}) {
  return { name: "e2e 刷怪区", monsterKey: "1", count: 3, cx: 4000, cy: -4000, w: 256, h: 256, ...overrides };
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "spawnroot", "SpawnAdmin#1");
    check(Boolean(token), "超管注册并登录成功");

    //#region 一、先看家底

    group("一、起始状态：0 号图 3 个刷怪区（来自出厂快照）");

    const before = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(before.status, 200, "能读 0 号图详情");
    const beforeAreas = before.body?.data?.spawnAreas ?? [];
    checkEqual(beforeAreas.length, 3, "0 号图出厂 3 个刷怪区");
    check(
      beforeAreas.every((area) => area.inBounds === true),
      "出厂区域全部在图内（越界的话后面「新建在图内」的断言就没有对照组了）",
    );
    const usedName = beforeAreas[0]?.name ?? "";

    //#endregion

    //#region 二、新建

    group("二、新建：拖一个框 → 填怪与数量 → 入库");

    const created = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token,
      body: boxOf({ name: "e2e 新建区", monsterKey: "1", count: 5 }),
    });
    checkEqual(created.status, 201, "新建返回 201");
    const area = created.body?.data ?? {};
    check(Number.isInteger(area.id) && area.id > 0, "返回带库里的行 id（前端不用再猜）");
    checkEqual(area.name, "e2e 新建区", "区域名原样返回");
    checkEqual(area.monsterKey, "1", "怪物 key 原样返回");
    checkEqual(area.monsterLabel !== "", true, "怪物名由服务端查表拼出（不要求客户端认识 key）");
    checkEqual(area.min, 0, "min 恒为 0（#852：密度目标的下限，count 只落 max）");
    checkEqual(area.max, 5, "max 落库 = 提交的数量（密度目标的基准）");
    checkEqual(area.cx, 4000, "世界中心 x 原样存下");
    checkEqual(area.cy, -4000, "世界中心 y 原样存下（y 轴向上，故为负）");
    checkEqual(area.w, 256, "区域宽原样存下");
    checkEqual(area.h, 256, "区域高原样存下");
    checkEqual(area.inBounds, true, "服务端判它在图内");
    checkEqual(
      [area.overflow?.left, area.overflow?.right, area.overflow?.top, area.overflow?.bottom].join(","),
      "0,0,0,0",
      "四边越界量全是 0",
    );

    const afterCreate = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterCreate.body?.data?.spawnAreas?.length, 4, "详情多了一行（3 → 4）");
    checkEqual(afterCreate.body?.data?.spawnAreaCount, 4, "列表计数跟着变（同一个数不做两处口径）");
    check(
      (afterCreate.body?.data?.spawnAreas ?? []).some((item) => item.id === area.id),
      "新建的那一行在列表里（不是只返回了却没入库）",
    );

    //#endregion

    //#region 三、四道校验

    group("三、四道校验：怪不存在 / 重名 / 太小 / 越界");

    const badMonster = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token,
      body: boxOf({ name: "怪不存在区", monsterKey: "no_such_monster" }),
    });
    checkEqual(badMonster.status, 404, "怪物 key 不存在 → 404");
    checkEqual(badMonster.body?.code, 50019, "业务码是 MONSTER_NOT_FOUND（前端能对着码做提示）");

    const dupName = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token,
      body: boxOf({ name: usedName }),
    });
    checkEqual(dupName.status, 409, "同图重名 → 409");
    checkEqual(dupName.body?.code, 20019, "业务码是 MAP_SPAWN_AREA_NAME_TAKEN");
    check(
      String(dupName.body?.message ?? "").includes(usedName),
      `冲突文案里带上了这个名字（实际：「${dupName.body?.message ?? ""}」）`,
    );

    const tooSmall = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token,
      body: boxOf({ name: "针尖区", w: 8, h: 8 }),
    });
    checkEqual(tooSmall.status, 400, "宽高小于 16px → 400（手抖点一下不该落一个 1×1 的区域）");
    check(
      String(tooSmall.body?.message ?? "").includes("16"),
      `文案里说明了最小尺寸（实际：「${tooSmall.body?.message ?? ""}」）`,
    );

    const outside = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token,
      body: boxOf({ name: "越界区", cx: 100, cy: -100, w: 512, h: 512 }),
    });
    checkEqual(outside.status, 400, "矩形越出地图边界 → 400（不是告警放行）");
    checkEqual(outside.body?.code, 40000, "业务码是 PARAM_INVALID");
    check(
      String(outside.body?.message ?? "").includes("越") || String(outside.body?.message ?? "").includes("边界"),
      `越界文案说人话（实际：「${outside.body?.message ?? ""}」）`,
    );
    check(
      String(outside.body?.message ?? "").includes("8192"),
      "文案里带上地图尺寸，方便判断是画错了还是这张图几何不对",
    );

    checkEqual(
      (await api(base, "GET", "/api/admin/maps/0", { token })).body?.data?.spawnAreas?.length,
      4,
      "四次失败之后库里还是 4 行（失败的请求没有留下半条记录）",
    );

    //#endregion

    //#region 四、改

    group("四、修改：换怪 / 改数量 / 挪位置（整份覆盖）");

    const updated = await api(base, "PATCH", `/api/admin/maps/0/spawn-areas/${area.id}`, {
      token,
      body: boxOf({ name: "e2e 改名区", monsterKey: "2", count: 7, cx: 2000, cy: -2000, w: 384, h: 384 }),
    });
    checkEqual(updated.status, 200, "修改返回 200");
    checkEqual(updated.body?.data?.id, area.id, "改的是同一行（没有变成「删了再建」）");
    checkEqual(updated.body?.data?.name, "e2e 改名区", "名字已改");
    checkEqual(updated.body?.data?.monsterKey, "2", "怪物已换");
    checkEqual(updated.body?.data?.max, 7, "数量已改");
    checkEqual(updated.body?.data?.min, 0, "min 不跟着 max 变（#852 起恒为 0）");
    checkEqual(updated.body?.data?.cx, 2000, "位置已挪");
    checkEqual(updated.body?.data?.w, 384, "宽已改");
    checkEqual(updated.body?.data?.inBounds, true, "改完仍在图内");

    const unchangedSibling = (await api(base, "GET", "/api/admin/maps/3", { token })).body?.data?.spawnAreas ?? [];
    checkEqual(unchangedSibling.length, 18, "3 号图的 18 个区域没被顺带改动（改的是 id，不是整表）");

    const crossMap = await api(base, "PATCH", `/api/admin/maps/3/spawn-areas/${area.id}`, {
      token,
      body: boxOf({ name: "串图区" }),
    });
    checkEqual(crossMap.status, 404, "拿 0 号图的 areaId 去改 3 号图 → 404");
    checkEqual(crossMap.body?.code, 50033, "业务码是 MAP_SPAWN_AREA_NOT_FOUND");

    const keepName = await api(base, "PATCH", `/api/admin/maps/0/spawn-areas/${area.id}`, {
      token,
      body: boxOf({ name: "e2e 改名区", monsterKey: "2", count: 7, cx: 2000, cy: -2000, w: 384, h: 384 }),
    });
    checkEqual(keepName.status, 200, "改回自己的名字不算重名（查重要排除自己那一行）");

    //#endregion

    //#region 五、删

    group("五、删除：删掉就少一行，再删 404");

    const removed = await api(base, "DELETE", `/api/admin/maps/0/spawn-areas/${area.id}`, { token });
    checkEqual(removed.status, 200, "删除返回 200");
    checkEqual(removed.body?.data?.deleted, true, "返回 deleted=true（不是 204 空响应）");
    checkEqual(removed.body?.data?.id, area.id, "返回被删掉的行 id");

    const afterDelete = await api(base, "GET", "/api/admin/maps/0", { token });
    checkEqual(afterDelete.body?.data?.spawnAreas?.length, 3, "详情回到 3 行");
    check(
      !(afterDelete.body?.data?.spawnAreas ?? []).some((item) => item.id === area.id),
      "删掉的那一行不在列表里",
    );

    const removeAgain = await api(base, "DELETE", `/api/admin/maps/0/spawn-areas/${area.id}`, { token });
    checkEqual(removeAgain.status, 404, "再删一次 → 404（不是静默成功）");

    //#endregion

    //#region 六、参数与存在性

    group("六、参数与存在性：DTO 拦格式，service 拦业务");

    const noName = await api(base, "POST", "/api/admin/maps/0/spawn-areas", { token, body: boxOf({ name: "" }) });
    checkEqual(noName.status, 400, "空名字 → 400（DTO 的 Length 拦下，到不了 service）");

    const zeroCount = await api(base, "POST", "/api/admin/maps/0/spawn-areas", { token, body: boxOf({ count: 0 }) });
    checkEqual(zeroCount.status, 400, "数量 0 → 400");

    const hugeCount = await api(base, "POST", "/api/admin/maps/0/spawn-areas", { token, body: boxOf({ count: 201 }) });
    checkEqual(hugeCount.status, 400, "数量 201 → 400（上限 200）");

    const noMap = await api(base, "POST", "/api/admin/maps/999/spawn-areas", { token, body: boxOf() });
    checkEqual(noMap.status, 404, "地图不存在 → 404");
    checkEqual(noMap.body?.code, 50032, "业务码是 MAP_NOT_FOUND");

    //#endregion

    //#region 七、权限

    group("七、权限：观察员能读，写 403；无令牌 401");

    const viewerToken = await registerAdmin(base, "spawnviewer", "SpawnAdmin#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token })).body?.data?.list?.find(
      (row) => row.username === "spawnviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    checkEqual((await api(base, "GET", "/api/admin/maps/0", { token: viewerToken })).status, 200, "观察员可读详情");
    const viewerCreate = await api(base, "POST", "/api/admin/maps/0/spawn-areas", {
      token: viewerToken,
      body: boxOf({ name: "观察员画的" }),
    });
    checkEqual(viewerCreate.status, 403, "观察员新建 → 403（他没有 gameConfig:write）");
    const viewerDelete = await api(base, "DELETE", "/api/admin/maps/0/spawn-areas/1", { token: viewerToken });
    checkEqual(viewerDelete.status, 403, "观察员删除 → 403");

    checkEqual((await api(base, "POST", "/api/admin/maps/0/spawn-areas", { body: boxOf() })).status, 401, "无令牌 → 401");

    //#endregion

    //#region 八、文档契约

    group("八、文档契约：三个 operation + 写模型");

    const docsResponse = await fetch(`${base}/api-docs-json`);
    const doc = await docsResponse.json();
    const createPath = doc.paths?.["/api/admin/maps/{id}/spawn-areas"];
    const updatePath = doc.paths?.["/api/admin/maps/{id}/spawn-areas/{areaId}"];
    checkEqual(docsResponse.status, 200, "能取到 openapi.json");
    check(Boolean(createPath?.post), "POST /admin/maps/{id}/spawn-areas 在文档里");
    check(Boolean(updatePath?.patch), "PATCH /admin/maps/{id}/spawn-areas/{areaId} 在文档里");
    check(Boolean(updatePath?.delete), "DELETE 同路径也在文档里");
    checkEqual(createPath?.post?.operationId, "adminMap.createSpawnArea", "新建的 operationId 稳定（生成物按它建方法名）");
    checkEqual(updatePath?.patch?.operationId, "adminMap.updateSpawnArea", "修改的 operationId");
    checkEqual(updatePath?.delete?.operationId, "adminMap.deleteSpawnArea", "删除的 operationId");
    check(
      String(createPath?.post?.description ?? "").includes("生效"),
      "描述里写清了生效时机（世界只在该图分域没有实例时播种）",
    );

    checkEqual(
      createPath?.post?.["x-olua-permissions"]?.join(","),
      "gameConfig:write",
      "新建要写权限（读权限的人只能看）",
    );
    checkEqual(
      updatePath?.delete?.["x-olua-permissions"]?.join(","),
      "gameConfig:write",
      "删除也要写权限",
    );
    checkEqual(
      createPath?.post?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapSpawnAreaDto",
      "新建回显的是这一行的 DTO（前端直接铺回列表）",
    );
    checkEqual(
      updatePath?.patch?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapSpawnAreaDto",
      "修改同样回显 MapSpawnAreaDto",
    );
    const bodyRef = createPath?.post?.requestBody?.content?.["application/json"]?.schema?.$ref ?? "";
    checkEqual(bodyRef, "#/components/schemas/SaveSpawnAreaDto", "请求体指向 SaveSpawnAreaDto（不是随手的 object）");
    const schemas = doc.components?.schemas ?? {};
    checkEqual(
      Object.keys(schemas.SaveSpawnAreaDto?.properties ?? {}).sort().join(","),
      "count,cx,cy,densityOff,densityPeak,h,monsterKey,name,peakHours,w",
      "写模型十个字段：**没有 id / mapId**（路径里已经有地图了），三个密度字段可空",
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
      console.log(`\n❌ 服务端 e2e（刷怪区绘制）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（刷怪区绘制）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
