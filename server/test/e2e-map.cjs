#!/usr/bin/env node
/**
 * 服务端 e2e：管理端「地图管理」只读模块（#571）
 *
 * 这一套测的**不是 CRUD，是边界**。地图的真相在客户端资源里（`resources/map/*.tmx`
 * + `configs/map.ts`），服务端存的是对它整理出来的东西（尺寸 / 刷怪区 / 场上怪物）。
 * 所以「管理端能不能改地图」这个问题，答案必须由测试钉住，而不是靠读代码时的自觉。
 *
 * ## 六条主线
 * 1. **列表 11 张、按 id 数字升序**：`10` 不许排到 `2` 前面（`Object.keys` 的字典序就是这样）；
 *    两种计数各归各位 —— `monsterAreaCount` 是客户端 TMX 的矩形数，`spawnAreaCount` 是服务端
 *    库表的行数，混在一起看就会得出「刷怪区和资源不一致」的假结论。
 * 2. **两套坐标不能混**：`groups` 是 Tiled 原始口径（左上角原点、y 向下），`spawnAreas` 是
 *    世界坐标（原点左上角、y 向上）。**同一个矩形的中心必须对得上** —— 这是唯一能证明
 *    「两边说的是同一件事」的判据，也是这一页存在的理由。
 * 3. **只读是能力边界，不是权限**：POST / PUT / PATCH / DELETE 一律 404（路由不存在），
 *    超管也一样 404。403 是「你没权限」、404 是「这件事没有入口」，两者不能混。
 * 4. **不存在的图**：404 + 专属业务码 50032（不是 50000 兜底）。
 * 5. **权限与受众**：观察员（`gameConfig:read`）能看，写入口本来就不存在；无令牌 401。
 * 6. **文档契约**：两个 GET 的标签 / 权限 / 响应类型；文档里也没有写方法；没有 Map 写模型。
 *
 * 用法：npm run test:e2e:map（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "map-code";

//#region 断言小工具（与其余几套同一骨架）

const EXPECTED_ASSERTIONS = 88;

function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（README.md；make audit 会比对）");
  process.exit(1);
}

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

/** 起一台服务并等它就绪 */
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
      JWT_SECRET: "e2e-map-secret",
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

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const rootToken = await registerAdmin(base, "maproot", "MapReadonly#1");
    check(Boolean(rootToken), "超管注册并登录成功");

    //#region 一、列表

    group("一、列表：11 张图，两类计数各归各位");

    const list = await api(base, "GET", "/api/admin/maps", { token: rootToken });
    checkEqual(list.status, 200, "管理端能读地图列表");
    checkEqual(list.body?.data?.total, 11, "一共 11 张图（清单由客户端 configs/map.ts 固定）");

    const rows = list.body?.data?.list ?? [];
    checkEqual(rows.length, 11, "list 长度与 total 一致（不分页）");
    checkEqual(
      rows.map((row) => row.id).join(","),
      "0,1,2,3,4,5,6,7,8,9,10",
      "按 id 数值升序（字典序会把 10 排到 2 前面）",
    );

    const map0 = rows.find((row) => row.id === "0") ?? {};
    checkEqual(map0.label, "新手村", "0 号图名称来自客户端配置");
    checkEqual(map0.type, "0", "类型码原样带出");
    checkEqual(map0.typeLabel, "安全地图", "类型名在生成快照里就拼好了（服务端不再维护第二份码表）");
    checkEqual(map0.level, 1, "进入等级原样带出");
    checkEqual(map0.src, "map/0/0", "客户端资源路径原样带出");
    checkEqual(map0.cols, 64, "横向格数来自 TMX 头");
    checkEqual(map0.tileWidth, 128, "单格宽来自 TMX 头");
    checkEqual(map0.width, 8192, "像素宽 = 格数 × 单格宽");
    checkEqual(map0.height, 8192, "像素高");
    checkEqual(map0.layerCount, 2, "图层数（ground / wall）");
    checkEqual(map0.monsterAreaCount, 3, "客户端 TMX 的刷怪矩形数");
    checkEqual(map0.npcCount, 1, "TMX 里 klass=npc 的对象数");
    checkEqual(map0.reviveCount, 1, "TMX 里 klass=revive 的对象数");
    checkEqual(map0.collisionCount, 99, "TMX 碰撞矩形数");
    checkEqual(map0.spawnAreaCount, 3, "服务端 map_spawn_areas 的行数（与上面那个 3 是两件事）");
    checkEqual(map0.worldMonsterCount, 0, "没跑过世界时场上怪物数是 0（不是 null）");

    checkEqual(rows.find((row) => row.id === "3")?.spawnAreaCount, 18, "3 号图 18 个刷怪区（启动时从快照 seed 进库）");
    checkEqual(rows.find((row) => row.id === "4")?.monsterAreaCount, 7, "4 号图 7 个刷怪矩形");

    const listNoToken = await api(base, "GET", "/api/admin/maps");
    checkEqual(listNoToken.status, 401, "没有令牌读不到列表");

    //#endregion

    //#region 二、详情：两套坐标

    group("二、详情：Tiled 原始坐标与服务器世界坐标并排，且能对上");

    const detail = await api(base, "GET", "/api/admin/maps/0", { token: rootToken });
    checkEqual(detail.status, 200, "详情可读");
    const data = detail.body?.data ?? {};
    checkEqual(data.id, "0", "详情里带着列表字段（继承不是复制粘贴）");
    checkEqual(data.spawnAreaCount, 3, "详情里的服务端刷怪区数与列表一致");

    const layers = data.layers ?? [];
    checkEqual(layers.length, 2, "两个图层");
    checkEqual(layers[0]?.name, "ground", "图层名按 TMX 顺序");
    checkEqual(layers[0]?.width, 64, "图层尺寸（格）");

    const groups = data.groups ?? [];
    checkEqual(
      groups.map((item) => item.name).join(","),
      "monster,npc,collision",
      "对象组按 TMX 顺序（monster / npc / collision）",
    );

    const monsterGroup = groups.find((item) => item.name === "monster") ?? { objects: [] };
    checkEqual(monsterGroup.objects.length, 3, "monster 组 3 个矩形");
    const tiledRect = monsterGroup.objects[0] ?? {};
    checkEqual(tiledRect.name, "1号怪物", "对象名来自 Tiled");
    checkEqual(tiledRect.klass, "", "普通矩形没有 class（空串，不是 undefined）");
    checkEqual(tiledRect.x, 384, "Tiled 原始 x（左上角原点）");
    checkEqual(tiledRect.y, 2048, "Tiled 原始 y（左上角原点、y 向下）");
    checkEqual(tiledRect.width, 1664, "矩形宽");
    checkEqual(tiledRect.height, 1664, "矩形高");
    checkEqual(tiledRect.properties?.id, "1", "自定义属性是原件：键值都是字符串");
    checkEqual(tiledRect.properties?.max, "10", "max 也没被转成数字（有导出的格式就丢信息）");

    const npcGroup = groups.find((item) => item.name === "npc") ?? { objects: [] };
    checkEqual(npcGroup.objects.length, 2, "npc 组 2 个点对象（复活点 + 传送）");
    checkEqual(npcGroup.objects[0]?.klass, "revive", "复活点靠 klass=revive 识别（不靠名字）");
    checkEqual(npcGroup.objects[1]?.klass, "npc", "传送点 klass=npc");
    checkEqual(npcGroup.objects[1]?.width, 0, "点对象宽为 0");

    const areas = data.spawnAreas ?? [];
    checkEqual(areas.length, 3, "服务端刷怪区 3 行（map_spawn_areas）");
    const area = areas[0] ?? {};
    checkEqual(area.name, "1号怪物", "区域名沿用 Tiled 对象名（两栏才对得上）");
    checkEqual(area.monsterKey, "1", "怪物 key 是 configs/monster 的关联键");
    checkEqual(area.monsterLabel, "赤焰斗鸡", "怪物名从快照查出来（查不到才回落成 key）");
    checkEqual(area.min, 0, "区域最少只数");
    checkEqual(area.max, 10, "区域最多只数（播种按它展开）");
    checkEqual(area.w, 1664, "区域宽与 Tiled 矩形一致");
    checkEqual(area.h, 1664, "区域高与 Tiled 矩形一致");
    checkEqual(area.cx, 1216, "区域中心 x（世界坐标）");
    checkEqual(area.cy, -2880, "区域中心 y 为负 —— y 轴向上，与 Tiled 的 y 向下差一次取反");

    // 唯一能证明「两栏说的是同一个矩形」的判据：Tiled 矩形中心 (x + w/2, y + h/2)
    const tiledCenterX = tiledRect.x + tiledRect.width / 2;
    const tiledCenterY = tiledRect.y + tiledRect.height / 2;
    checkEqual(tiledCenterX, area.cx, "Tiled 矩形中心 x 等于服务端 cx（同一个矩形，没挪位置）");
    checkEqual(-tiledCenterY, area.cy, "Tiled 矩形中心 y 取反等于 cy（只换了 y 的正方向）");

    checkEqual((data.worldMonsters ?? []).length, 0, "没跑过世界的进程里 worldMonsters 是空数组（不是 500）");

    const sources = data.sources ?? [];
    checkEqual(sources.length, 6, "每一块数据都带来源说明（6 条）");
    checkEqual(
      sources.map((item) => item.section).join(","),
      "config,size,layers,groups,spawnAreas,worldMonsters",
      "来源覆盖页面上的每一栏",
    );
    checkEqual(
      [...new Set(sources.map((item) => item.origin))].sort().join(","),
      "config,db,snapshot",
      "来源分三类：客户端配置 / 服务端快照 / 服务端库表",
    );
    check(
      sources.filter((item) => item.origin === "db").every((item) => /^map_spawn_areas|world_monsters/.test(item.ref)),
      "归到「库表」的两条写的是真表名（不是含糊的「服务端」）",
    );
    check(
      sources.filter((item) => item.origin === "config").every((item) => item.ref.includes("client/assets/")),
      "归到「客户端配置」的那条指着客户端路径（这一页最容易犯的错就是把资源当服务端数据）",
    );

    //#endregion

    //#region 三、只读边界

    group("三、只读边界：四个写方法都不存在（404 而不是 403）");

    const post = await api(base, "POST", "/api/admin/maps", { token: rootToken, body: { label: "新地图" } });
    checkEqual(post.status, 404, "POST 地图 → 404（路由不存在）");
    const put = await api(base, "PUT", "/api/admin/maps/0", { token: rootToken, body: { label: "改个名" } });
    checkEqual(put.status, 404, "PUT 地图 → 404");
    const patch = await api(base, "PATCH", "/api/admin/maps/0", { token: rootToken, body: { level: 99 } });
    checkEqual(patch.status, 404, "PATCH 地图 → 404");
    const del = await api(base, "DELETE", "/api/admin/maps/0", { token: rootToken });
    checkEqual(del.status, 404, "DELETE 地图 → 404");
    check(
      post.status === 404 && put.status === 404 && patch.status === 404 && del.status === 404,
      "超管也写不动：这是「没有入口」，不是「你没权限」（否则会有人去补权限）",
    );

    //#endregion

    //#region 四、不存在的图

    group("四、不存在的图：404 + 专属业务码");

    const outOfRange = await api(base, "GET", "/api/admin/maps/11", { token: rootToken });
    checkEqual(outOfRange.status, 404, "11 号图不存在 → 404");
    checkEqual(outOfRange.body?.code, 50032, "用地图专属业务码 50032（不是 50000 兜底）");
    const nonsense = await api(base, "GET", "/api/admin/maps/abc", { token: rootToken });
    checkEqual(nonsense.status, 404, "id 形态不对同样 404（不 400：客户端不该猜 id 长什么样）");
    checkEqual(nonsense.body?.code, 50032, "同一个业务码");

    //#endregion

    //#region 五、权限

    group("五、权限：观察员能看，写入口本来就没有");

    const viewerToken = await registerAdmin(base, "mapviewer", "MapReadonly#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token: rootToken })).body?.data?.list?.find(
      (row) => row.username === "mapviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: rootToken, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    const viewerList = await api(base, "GET", "/api/admin/maps", { token: viewerToken });
    checkEqual(viewerList.status, 200, "观察员可读列表（gameConfig:read 就够）");
    const viewerDetail = await api(base, "GET", "/api/admin/maps/3", { token: viewerToken });
    checkEqual(viewerDetail.status, 200, "观察员可读详情");
    const viewerWrite = await api(base, "PATCH", "/api/admin/maps/0", { token: viewerToken, body: { level: 1 } });
    checkEqual(viewerWrite.status, 404, "观察员写也是 404（写入口对所有角色都不存在）");

    const detailNoToken = await api(base, "GET", "/api/admin/maps/0");
    checkEqual(detailNoToken.status, 401, "没有令牌读不到详情");

    //#endregion

    //#region 六、文档契约

    group("六、文档契约：只有两个 GET，没有 Map 写模型");

    const docs = await fetch(`${base}/api-docs-json`);
    const doc = await docs.json();
    const listPath = doc.paths?.["/api/admin/maps"];
    const detailPath = doc.paths?.["/api/admin/maps/{id}"];
    check(Boolean(listPath?.get && detailPath?.get), "两个 GET 都在文档里");
    checkEqual(listPath?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "列表要求 gameConfig:read（只读权限点）");
    checkEqual(detailPath?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "详情同样只要读权限");
    checkEqual(listPath?.get?.["x-olua-audience"], "admin", "列表归管理端受众");
    checkEqual(
      listPath?.get?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapListDto",
      "列表响应类型是 MapListDto",
    );
    checkEqual(
      detailPath?.get?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapDetailDto",
      "详情响应类型是 MapDetailDto",
    );
    checkEqual(
      Object.keys(listPath ?? {}).join(","),
      "get",
      "列表路径只有 get（文档里也没有写方法，生成链不会漏看）",
    );
    checkEqual(
      Object.keys(detailPath ?? {}).join(","),
      "get",
      "详情路径也只有 get（路径参数写在 operation 里，不是另一个键）",
    );

    const schemas = doc.components?.schemas ?? {};
    const detailSchema = schemas.MapDetailDto?.properties ?? {};
    check(
      Boolean(detailSchema.id && detailSchema.label),
      "MapDetailDto 里带着列表字段（继承在文档里也是扁平的，读文档的人不用翻父类）",
    );
    check(
      Boolean(detailSchema.layers && detailSchema.spawnAreas && detailSchema.sources),
      "MapDetailDto 有图层 / 刷怪区 / 来源三块",
    );
    checkEqual(
      detailSchema.spawnAreas?.items?.$ref,
      "#/components/schemas/MapSpawnAreaDto",
      "spawnAreas 指向 MapSpawnAreaDto（不是随手的 object）",
    );
    check(
      Object.keys(schemas).every((name) => !/^(Create|Update|Save)Map/.test(name)),
      "文档里没有任何 Map 写模型（少一个 DTO 比留一个永远没人调的写接口更诚实）",
    );

    //#endregion
  } finally {
    server.kill();
  }
}

//#endregion

main()
  .then(() => {
    assertExpectedCount(passed, failed);
    if (failed) {
      console.log(`\n❌ 服务端 e2e（地图管理）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（地图管理）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
