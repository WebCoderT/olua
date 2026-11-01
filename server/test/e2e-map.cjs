#!/usr/bin/env node
/**
 * 服务端 e2e：管理端「地图管理」—— 玩法配置可改，资源本体不可改（#571 / #573）
 *
 * 这一套测的**不是 CRUD，是边界**。地图分两半：
 * - **资源本体**（TMX / 底图 / 预览图）在客户端资源包里，服务端连一列都没有；
 * - **玩法配置**（名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）归服务端 `maps` 表（#573 才搬过来）。
 *
 * 所以「管理端能改什么」这个问题，答案必须由测试钉住，而不是靠读代码时的自觉。
 *
 * ## 七条主线
 * 1. **列表按 id 数值升序**（`10` 不许排到 `2` 前面），两种计数各归各位 ——
 *    `monsterAreaCount` 是客户端 TMX 的矩形数，`spawnAreaCount` 是服务端库表的行数，
 *    混在一起看就会得出「刷怪区和资源不一致」的假结论。
 * 2. **两套坐标不能混**：`groups` 是 Tiled 原始口径（左上角原点、y 向下），`spawnAreas` 是
 *    世界坐标（原点左上角、y 向上）。**同一个矩形的中心必须对得上** —— 这是唯一能证明
 *    「两边说的是同一件事」的判据。
 * 3. **玩法配置保存即生效**：PATCH 之后列表 / 详情 / **玩家配置快照** 三处同步反映 ——
 *    第三处最关键，它决定「客户端下次进游戏能不能看到新门槛」。
 * 4. **资源本体写不动**：请求里塞 `src` 也会被丢掉（白名单剥离），返回仍是 `map/<id>/<id>`；
 *    POST / PUT / DELETE 一律 404（没有「新建 / 删除地图」这回事，图存不存在由 TMX 决定）。
 * 5. **参数越界要拒**：类型不在 0..3、等级 > 200、名称为空 → 400（不是静默存进去）。
 * 6. **权限**：观察员能读、写 403（写入口存在，但他是只读角色）；无令牌 401。
 * 7. **文档契约**：三个 operation（list / detail / save）、`save` 要 `gameConfig:write`、
 *    有 `SaveMapConfigDto`、**没有** Create / Delete 模型。
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

const EXPECTED_ASSERTIONS = 132;

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

/** 注册并登录一个玩家，返回 token（配置快照要玩家令牌） */
async function registerPlayer(baseUrl, username) {
  const login = await api(baseUrl, "POST", "/api/auth/login", { body: { username, password: "pass1234" } });
  if (login.body?.data?.token) return login.body.data.token;
  const registered = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password: "pass1234" } });
  return registered.body?.data?.token;
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const rootToken = await registerAdmin(base, "maproot", "MapAdmin#1");
    check(Boolean(rootToken), "超管注册并登录成功");

    //#region 一、列表

    group("一、列表：按 id 数值升序，两类计数各归各位");

    const list = await api(base, "GET", "/api/admin/maps", { token: rootToken });
    checkEqual(list.status, 200, "管理端能读地图列表");
    checkEqual(list.body?.data?.total, 11, "一共 11 张图（行由资源清单 seed 出来）");

    const rows = list.body?.data?.list ?? [];
    checkEqual(rows.length, 11, "list 长度与 total 一致（不分页）");
    checkEqual(
      rows.map((row) => row.id).join(","),
      "0,1,2,3,4,5,6,7,8,9,10",
      "按 id 数值升序（字典序会把 10 排到 2 前面）",
    );

    const types = list.body?.data?.types ?? [];
    checkEqual(types.length, 4, "列表带全部类型选项（编辑下拉要能选到当下没人用的类型）");
    checkEqual(types.map((item) => item.type).join(","), "0,1,2,3", "类型选项按声明顺序");
    checkEqual(types[0]?.label, "安全地图", "类型名由服务端给（客户端与后台都不再各抄一份）");

    const map0 = rows.find((row) => row.id === "0") ?? {};
    checkEqual(map0.label, "新手村", "0 号图名称来自出厂种子（库里的行）");
    checkEqual(map0.type, "0", "类型码原样带出");
    checkEqual(map0.typeLabel, "安全地图", "类型名由服务端拼（映射只有一处来源）");
    checkEqual(map0.level, 1, "进入等级来自库");
    checkEqual(map0.src, "map/0/0", "资源路径按目录约定拼出（不是存下来的字段）");
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

    // 边界约定（#586）：区域矩形必须整体落在图内 —— x ∈ [0, W]、y ∈ [-H, 0]。
    // 判据在服务端（`spawn-area-bounds.util.ts`），因为它校验的是**库表**：库表只在空库时按快照
    // seed 一次，旧口径时期 seed 过的库会一直把怪刷在图外，而只查快照的静态审计看不见这件事。
    checkEqual(area.inBounds, true, "刷怪区在图内（inBounds 由服务端按地图尺寸判）");
    checkEqual(
      Object.keys(area.overflow ?? {}).sort().join(","),
      "bottom,left,right,top",
      "越界量按四边分别给（只给一个布尔就只能自己去翻数据）",
    );
    checkEqual(
      [area.overflow.left, area.overflow.right, area.overflow.top, area.overflow.bottom].join(","),
      "0,0,0,0",
      "在图内时四边越界量都是 0（不是 null / undefined）",
    );
    check(areas.every((item) => item.inBounds === true), "这张图的 3 个刷怪区全部在图内");

    checkEqual((data.worldMonsters ?? []).length, 0, "没跑过世界的进程里 worldMonsters 是空数组（不是 500）");

    const sources = data.sources ?? [];
    checkEqual(sources.length, 7, "每一块数据都带来源说明（7 条）");
    checkEqual(
      sources.map((item) => item.section).join(","),
      "config,resource,size,layers,groups,spawnAreas,worldMonsters",
      "来源覆盖页面上的每一栏",
    );
    checkEqual(
      [...new Set(sources.map((item) => item.origin))].sort().join(","),
      "config,db,snapshot",
      "来源分三类：客户端资源 / 服务端快照 / 服务端库表",
    );
    check(
      sources
        .filter((item) => item.origin === "db")
        .every((item) => /^maps|map_spawn_areas|world_monsters/.test(item.ref)),
      "归到「库表」的三条写的是真表名（不是含糊的「服务端」）",
    );
    check(
      sources.filter((item) => item.origin === "config").every((item) => item.ref.includes("client/assets/")),
      "归到「客户端资源」的那条指着客户端路径（这一页最容易犯的错就是把资源当服务端数据）",
    );
    checkEqual(
      sources.find((item) => item.section === "config")?.origin,
      "db",
      "玩法配置（名称 / 类型 / 进入条件）归服务端库表 —— #573 就是从客户端搬过来的这一块",
    );

    //#endregion

    //#region 二·补、越界判据本身（纯函数，从 dist 直接测）

    group("二·补、越界判据：越出去多少要说得出，贴边不算越界");

    // 接口没有任何「写刷怪区」的入口（刷怪区只能由导入工具写），所以**越界这个分支没法用请求造出来** ——
    // 只能直接测那个纯函数。它是唯一一处判据，e2e 又跑在 build 之后，直接 require dist 里那份。
    const bounds = require(path.join(SERVER_DIR, "dist", "common", "utils", "spawn-area-bounds.util.js"));
    const mapSize = { width: 8192, height: 8192 };

    // 中心 (100, -100)、400×100 → 左边在 -100（越过左边界 100），其余三边都在图内
    const spilled = { cx: 100, cy: -100, w: 400, h: 100 };
    checkEqual(bounds.spawnAreaInBounds(spilled, mapSize), false, "左边越出图外 → 判为越界");
    checkEqual(
      JSON.stringify(bounds.spawnAreaOverflow(spilled, mapSize)),
      JSON.stringify({ left: 99, right: 0, top: 0, bottom: 0 }),
      "越界量只写在越出去的那一边（99 = 100 减去 1px 容差）",
    );
    // 左边差 1px：导入工具按浮点算中心、列是整数，取整会造出 0.x 的假越界，容差 1 吸收掉它
    checkEqual(bounds.spawnAreaInBounds({ cx: 201, cy: -4000, w: 400, h: 100 }, mapSize), true, "贴边差 1px 仍算在图内（容差 1）");
    checkEqual(
      bounds.spawnAreaInBounds({ cx: 100, cy: 4000, w: 400, h: 100 }, mapSize),
      false,
      "y 正方向越界也要判出来（y 轴向上，图的顶边是 0 —— 这里最容易把符号写反）",
    );

    // 11 张图的全部区域扫一遍：口径一错就是一大片越界，这个遍历是最省事的判据
    let totalAreas = 0;
    const outside = [];
    for (const row of rows) {
      const each = await api(base, "GET", `/api/admin/maps/${row.id}`, { token: rootToken });
      for (const item of each.body?.data?.spawnAreas ?? []) {
        totalAreas += 1;
        if (!item.inBounds) outside.push(`#${row.id} ${item.name}`);
      }
    }
    checkEqual(outside.length, 0, `11 张图共 ${totalAreas} 个刷怪区全部在图内（旧口径会在这一步大面积爆红）`);
    checkEqual(totalAreas, 62, "刷怪区总数 62（换图 / 加区域后同步这个数）");

    //#endregion

    //#region 三、玩法配置可改

    group("三、玩法配置：保存即生效（列表 / 详情 / 玩家快照三处同步）");

    const playerToken = await registerPlayer(base, "map_snap_player");
    check(Boolean(playerToken), "玩家注册并登录成功（快照要玩家令牌）");

    const beforeSnap = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(beforeSnap.status, 200, "玩家能拉配置快照");
    const snapMapsBefore = beforeSnap.body?.data?.maps ?? [];
    checkEqual(snapMapsBefore.length, 11, "快照里的地图行数 = 列表（客户端进游戏就靠它）");
    checkEqual(
      snapMapsBefore.find((row) => row.id === "0")?.label,
      "新手村",
      "改之前快照里 0 号图还是出厂名",
    );

    const saved = await api(base, "PATCH", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "新手村·改", type: "1", level: 5, combat: 0, soulOfWar: 0 },
    });
    checkEqual(saved.status, 200, "保存玩法配置 → 200");
    checkEqual(saved.body?.data?.label, "新手村·改", "返回的是保存后那一行");
    checkEqual(saved.body?.data?.type, "1", "类型改掉了");
    checkEqual(saved.body?.data?.typeLabel, "等级地图", "类型名跟着变（不是缓存住的旧值）");
    checkEqual(saved.body?.data?.level, 5, "进入等级改掉了");
    checkEqual(saved.body?.data?.src, "map/0/0", "返回里仍带资源路径（只读回显，不是入参）");

    const reread = await api(base, "GET", "/api/admin/maps/0", { token: rootToken });
    checkEqual(reread.body?.data?.label, "新手村·改", "重新读详情就是新值（没有缓存层挡着）");
    checkEqual(reread.body?.data?.level, 5, "等级也持久化了");

    const listAfter = await api(base, "GET", "/api/admin/maps", { token: rootToken });
    const rowAfter = (listAfter.body?.data?.list ?? []).find((row) => row.id === "0") ?? {};
    checkEqual(rowAfter.label, "新手村·改", "列表也反映新名字");
    checkEqual(rowAfter.typeLabel, "等级地图", "列表里的类型名同样跟着变");

    const afterSnap = await api(base, "GET", "/api/game-config", { token: playerToken });
    const snapMap0 = (afterSnap.body?.data?.maps ?? []).find((row) => row.id === "0") ?? {};
    checkEqual(snapMap0.label, "新手村·改", "玩家快照里也是新名字（客户端下次进游戏就换成这个）");
    checkEqual(snapMap0.level, 5, "玩家快照里的进入等级同步了 —— 这是「保存即生效」对玩家的那一半");
    checkEqual(snapMap0.type, "1", "快照里的类型码同步");
    checkEqual((afterSnap.body?.data?.mapTypes ?? []).length, 4, "快照同时下发类型分组（顺序即传送弹窗分组）");

    // 资源路径不可改：请求里塞 src 会被白名单剥掉，返回仍是目录约定算出来的那个
    const withSrc = await api(base, "PATCH", "/api/admin/maps/1", {
      token: rootToken,
      body: { label: "卧龙城", type: "0", level: 10, combat: 0, soulOfWar: 0, src: "map/evil/evil" },
    });
    checkEqual(withSrc.status, 200, "带多余字段的请求仍成功（白名单剥离，不是 400）");
    checkEqual(withSrc.body?.data?.src, "map/1/1", "塞进来的 src 被丢掉 —— 下发方永远改不到客户端加载哪张图");

    const audits = await api(base, "GET", "/api/admin/audit-logs?targetType=map&size=20", { token: rootToken });
    const auditRows = audits.body?.data?.list ?? [];
    check(
      auditRows.some((row) => row.action === "adminMap.save" && String(row.targetId) === "0"),
      "保存动作进了审计日志（targetType=map / action=adminMap.save）",
    );
    check(
      auditRows.every((row) => row.targetType === "map"),
      "审计按目标类型筛得出来（枚举只有一处来源，写与查共用）",
    );

    //#endregion

    //#region 四、参数校验

    group("四、参数校验：越界要拒，不是静默存进去");

    const badType = await api(base, "PATCH", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "x", type: "9", level: 1, combat: 0, soulOfWar: 0 },
    });
    checkEqual(badType.status, 400, "类型不在 0..3 → 400");

    const badLevel = await api(base, "PATCH", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "x", type: "0", level: 201, combat: 0, soulOfWar: 0 },
    });
    checkEqual(badLevel.status, 400, "进入等级超过上限 → 400（拦「把 999 拍进去」这类错误）");

    const negativeCombat = await api(base, "PATCH", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "x", type: "0", level: 1, combat: -1, soulOfWar: 0 },
    });
    checkEqual(negativeCombat.status, 400, "负战斗力 → 400");

    const emptyLabel = await api(base, "PATCH", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "", type: "0", level: 1, combat: 0, soulOfWar: 0 },
    });
    checkEqual(emptyLabel.status, 400, "空名称 → 400（列表里会显示成空白按钮）");

    const partial = await api(base, "PATCH", "/api/admin/maps/0", { token: rootToken, body: { label: "只传一个字段" } });
    checkEqual(partial.status, 400, "缺字段 → 400（整份覆盖，不是部分更新）");

    const stillThere = await api(base, "GET", "/api/admin/maps/0", { token: rootToken });
    checkEqual(stillThere.body?.data?.label, "新手村·改", "四次失败请求一次都没写进去（校验在落库之前）");

    //#endregion

    //#region 五、能力边界

    group("五、能力边界：没有新建 / 删除，也没有 PUT（资源本体不归后台）");

    const post = await api(base, "POST", "/api/admin/maps", {
      token: rootToken,
      body: { label: "新地图", type: "0", level: 0, combat: 0, soulOfWar: 0 },
    });
    checkEqual(post.status, 404, "POST 新建地图 → 404（一张图存不存在由客户端的 TMX 决定）");
    const put = await api(base, "PUT", "/api/admin/maps/0", {
      token: rootToken,
      body: { label: "改个名", type: "0", level: 1, combat: 0, soulOfWar: 0 },
    });
    checkEqual(put.status, 404, "PUT 整份替换 → 404（保存走 PATCH，语义是「改这五个字段」）");
    const del = await api(base, "DELETE", "/api/admin/maps/0", { token: rootToken });
    checkEqual(del.status, 404, "DELETE 删除地图 → 404");

    const outOfRange = await api(base, "GET", "/api/admin/maps/11", { token: rootToken });
    checkEqual(outOfRange.status, 404, "11 号图不存在 → 404");
    checkEqual(outOfRange.body?.code, 50032, "用地图专属业务码 50032（不是 50000 兜底）");
    const nonsense = await api(base, "GET", "/api/admin/maps/abc", { token: rootToken });
    checkEqual(nonsense.status, 404, "id 形态不对同样 404（不 400：客户端不该猜 id 长什么样）");
    checkEqual(nonsense.body?.code, 50032, "同一个业务码");

    const patchMissing = await api(base, "PATCH", "/api/admin/maps/99", {
      token: rootToken,
      body: { label: "幽灵图", type: "0", level: 0, combat: 0, soulOfWar: 0 },
    });
    checkEqual(patchMissing.status, 404, "改一张不存在的图 → 404");
    checkEqual(patchMissing.body?.code, 50032, "同样是 50032（不是「参数不合法」）");

    //#endregion

    //#region 六、权限

    group("六、权限：观察员能读，写 403");

    const viewerToken = await registerAdmin(base, "mapviewer", "MapAdmin#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token: rootToken })).body?.data?.list?.find(
      (row) => row.username === "mapviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: rootToken, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    const viewerList = await api(base, "GET", "/api/admin/maps", { token: viewerToken });
    checkEqual(viewerList.status, 200, "观察员可读列表（gameConfig:read 就够）");
    const viewerDetail = await api(base, "GET", "/api/admin/maps/3", { token: viewerToken });
    checkEqual(viewerDetail.status, 200, "观察员可读详情");
    const viewerWrite = await api(base, "PATCH", "/api/admin/maps/0", {
      token: viewerToken,
      body: { label: "观察员改的", type: "0", level: 1, combat: 0, soulOfWar: 0 },
    });
    checkEqual(viewerWrite.status, 403, "观察员改玩法配置 → 403（写入口存在，但他没有 gameConfig:write）");

    const detailNoToken = await api(base, "GET", "/api/admin/maps/0");
    checkEqual(detailNoToken.status, 401, "没有令牌读不到详情");

    //#endregion

    //#region 七、文档契约

    group("七、文档契约：三个 operation，只有 save 是写");

    const docs = await fetch(`${base}/api-docs-json`);
    const doc = await docs.json();
    const listPath = doc.paths?.["/api/admin/maps"];
    const detailPath = doc.paths?.["/api/admin/maps/{id}"];
    check(Boolean(listPath?.get && listPath?.post === undefined), "列表有 get、没有 post");
    check(Boolean(detailPath?.get && detailPath?.patch && detailPath?.put === undefined), "详情有 get + patch、没有 put");
    checkEqual(listPath?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "列表要求 gameConfig:read");
    checkEqual(detailPath?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "详情同样只要读权限");
    checkEqual(
      detailPath?.patch?.["x-olua-permissions"]?.join(","),
      "gameConfig:write",
      "保存要写权限（读权限的人只能看）",
    );
    checkEqual(listPath?.get?.["x-olua-audience"], "admin", "列表归管理端受众");
    checkEqual(
      listPath?.get?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapListDto",
      "列表响应类型是 MapListDto",
    );
    checkEqual(
      detailPath?.patch?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapSummaryDto",
      "保存响应类型是 MapSummaryDto（回显保存后的那一行）",
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
    check(Boolean(schemas.SaveMapConfigDto), "有 SaveMapConfigDto（写入口只有这一个形状）");
    checkEqual(
      Object.keys(schemas.SaveMapConfigDto?.properties ?? {}).sort().join(","),
      "combat,label,level,soulOfWar,type",
      "写模型只有五个字段：**没有 src / 尺寸 / 图层** —— 资源本体不是一个可编辑的字段",
    );
    check(
      Object.keys(schemas).every((name) => !/^(Create|Update|Delete)Map/.test(name)),
      "文档里没有 Map 的新建 / 删除模型（后台造不出一张没有 TMX 的地图）",
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
