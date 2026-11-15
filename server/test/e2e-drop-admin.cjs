#!/usr/bin/env node
/**
 * 掉落管理端三个读页面的专项 e2e（server/test/e2e-drop-admin.cjs，#805）
 *
 * ## 这一套盯什么
 *
 * 写侧的证据已经有两套：`e2e-drop`（九步拾取校验 + 四种终态）与 `e2e-drop-records`
 * （流水读接口 + 两道保留闸）。这一套盯**新增的两个数据面**，以及它们与既有口径的一致性：
 *
 * 一、**当前地面**（`world_drops` 投影）：筛选（`mapId` 精确 / `keyword` 模糊匹配物品 id /
 *    `ownerName` 模糊且 `%` `_` 转义）、排序白名单、分页、`size` 上限
 * 二、**概况卡**：四格数字从同一次分组求和而来（明细求和 == 顶层数字），`capPerMap` 与
 *    运行时参数**同源**（不复制一个写死的上限到管理端）
 * 三、**怪物掉落反查**（配置面）：两种配置写法都摊平、`bound` 是「怪物强制 or 物品绑定」的
 *    或运算、排序稳定、按怪物 key / 物品 id 精确筛
 * 四、**区是上下文不是参数**：缺 `X-Zone-Id` → 400；`?zoneId=` 传了也不生效；别区的行不可见
 * 五、**权限**：`drop:read` 给到只读观察员（`gameConfig:read` 同量级），而对照的
 *    `event:read` 不给 —— 这么设计是因为掉落页的主角是物品，不是人
 *
 * ## 为什么用「直接往表里塞行」而不是先打一遍怪
 *
 * 这两个接口都是**纯读投影**：写侧（`DropService` 攒批 / 重启清场）已经有 `e2e-drop` 在盯，
 * 这里再打一遍怪只会让「一行数据怎么来的」多绕三层，还会把断言和战斗节奏绑在一起。
 * 塞进去的行是**测试自造的输入**，不是从配置算出来的期望值 —— 断言的是「筛选器把这几行
 * 挑对了没」，不是「地上应该有多少件」。
 *
 * 唯一例外是 `monster-index`：那是读配置，没有输入可造，所以只断言**自洽**（每行的
 * `bound` 与两个来源列一致、`tableId` 与 `source` 一致）与**稳定**（同样的查询两次一样），
 * 不断言「一共该有多少行」——那会随策划调表而假红。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const PERMISSION_MODULE = path.join(SERVER_DIR, "dist", "common", "constants", "permission.js");

const ADMIN_ZONE = 1;
/** 一个**只用来放一棵「别区的树」**的区：不建角色、只造一行地面掉落，验「别区看不见」 */
const OTHER_ZONE_NAME = "e2e-掉落隔离开区";
const ADMIN_CODE = "olua-e2e-drop-admin";
const PLAYER = "drop_admin_al";

//#region 断言小工具（与其余 e2e 同款口径）

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function group(label) {
  console.log(`\n▶ ${label}`);
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

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-drop-admin-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      // 世界照常跑（它每 100ms 刷一次投影），但没有任何玩家进图 —— 本套塞的行不会被动到
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_MAP_IDLE_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;

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

async function stopServer(server) {
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGTERM");
  await sleep(300);
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
  await sleep(200);
}

/** 调接口，连 HTTP 状态一起返回（400 / 401 / 403 要看状态码，不能只看 body） */
async function apiRaw(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
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

async function api(baseUrl, method, route, options = {}) {
  return apiRaw(baseUrl, method, route, options);
}

/**
 * 往 `world_drops` 直接塞行（测试自造输入）
 *
 * 服务端已经开了 WAL + `busy_timeout`，这里也给自己设一个：两个连接同时写时
 * 宁可等 5 秒，也别抛 `SQLITE_BUSY` 把断言搅成一片红。
 */
function seedGround(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const insert = db.prepare(
      `INSERT INTO world_drops (
         drop_id, zone_id, map_id, good_id, count, bound, x, y,
         owner_account_id, owner_role_id, owner_name, party_id,
         monster_key, monster_label, monster_instance_id, origin_role, origin_at,
         created_at, expire_at, protect_until
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.dropId,
        row.zoneId,
        row.mapId,
        row.goodId,
        row.count,
        row.bound,
        row.x,
        row.y,
        `acc_${row.ownerName}`,
        `role_${row.ownerName}`,
        row.ownerName,
        null,
        row.monsterKey,
        row.monsterKey,
        "m1_z1_1",
        null,
        null,
        row.createdAt,
        row.expireAt,
        row.protectUntil,
      );
    }
  } finally {
    db.close();
  }
}

(async () => {
  const port = await freePort();
  const dbPath = path.join(os.tmpdir(), `olua-e2e-drop-admin-${process.pid}-${Date.now()}.db`);
  let server = null;

  try {
    server = await startServer(dbPath, port);
    const { baseUrl } = server;

    //#region 预置：管理员 / 观察员 / 第二个区 / 地面行

    group("预置");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "drop_admin_root", password: "DropAdmin#1", registerCode: ADMIN_CODE },
    });
    const rootLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "drop_admin_root", password: "DropAdmin#1", zoneId: ADMIN_ZONE },
    });
    const rootToken = rootLogin.body && rootLogin.body.data && rootLogin.body.data.token;
    check(!!rootToken, "超级管理员登录拿票", `${rootLogin.status}`);

    // 第二个管理员：注册出来是超管，降级成观察员 —— `drop:read` 的设计意图就是「观察员也能看」
    const viewerRegistered = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "drop_admin_viewer", password: "DropViewer#1", registerCode: ADMIN_CODE },
    });
    const viewerToken = viewerRegistered.body && viewerRegistered.body.data && viewerRegistered.body.data.token;
    const viewerId = viewerRegistered.body && viewerRegistered.body.data && viewerRegistered.body.data.admin.id;
    const demote = await apiRaw(baseUrl, "PATCH", `admin/admins/${viewerId}`, {
      token: rootToken,
      zoneId: ADMIN_ZONE,
      body: { role: "viewer" },
    });
    check(demote.status === 200, "把第二个管理员降级成只读观察员", `${demote.status}`);

    // 一个从没建过角色的区：只用来放「别区的行」，验跨区不可见
    const createdZone = await api(baseUrl, "POST", "admin/zones", {
      token: rootToken,
      zoneId: ADMIN_ZONE,
      body: { name: OTHER_ZONE_NAME },
    });
    const otherZoneId = createdZone.body && createdZone.body.data && createdZone.body.data.id;
    check(Number.isInteger(otherZoneId) && otherZoneId !== ADMIN_ZONE, "开一个只用来放「别区数据」的区", `id=${otherZoneId}`);

    const now = Date.now();
    const at = (ms) => now + ms;
    /** 本区的四行：两张图、两种「状态」（保护中 / 即将过期）、一个配置里不存在的物品 id */
    const zoneRows = [
      {
        dropId: "d_1_1_1",
        zoneId: ADMIN_ZONE,
        mapId: "1",
        goodId: "drug_hp_1",
        count: 1,
        bound: 0,
        x: 100,
        y: 200,
        ownerName: "drop_adm_x",
        monsterKey: "slime_1",
        createdAt: at(-30_000),
        expireAt: at(50_000), // 60 秒窗口内 → 算「即将过期」
        protectUntil: at(-3_600_000), // 早就过了保护期
      },
      {
        dropId: "d_1_1_2",
        zoneId: ADMIN_ZONE,
        mapId: "1",
        goodId: "drug_mp_1",
        count: 3,
        bound: 1,
        x: 110,
        y: 210,
        ownerName: "alice",
        monsterKey: "slime_1",
        createdAt: at(-30_000),
        expireAt: at(180_000),
        protectUntil: at(3_600_000), // 保护中
      },
      {
        dropId: "d_1_1_4",
        zoneId: ADMIN_ZONE,
        mapId: "1",
        goodId: "drug_hp_2",
        count: 2,
        bound: 0,
        x: 120,
        y: 220,
        ownerName: "bob",
        monsterKey: "slime_1",
        createdAt: at(-30_000),
        expireAt: at(120_000),
        protectUntil: at(-3_600_000),
      },
      {
        dropId: "d_1_2_3",
        zoneId: ADMIN_ZONE,
        mapId: "2",
        goodId: "no_such_good_xyz",
        count: 1,
        bound: 0,
        x: 10,
        y: 20,
        // 这个归属者名故意写成「若 `_` 当通配符就会误会」的形状
        ownerName: "dropAadmB",
        monsterKey: "slime_2",
        createdAt: at(-30_000),
        expireAt: at(300_000),
        protectUntil: at(-3_600_000),
      },
    ];
    const otherZoneRow = {
      dropId: "d_other_1_1",
      zoneId: otherZoneId,
      mapId: "1",
      goodId: "drug_hp_1",
      count: 1,
      bound: 0,
      x: 5,
      y: 5,
      ownerName: "carol",
      monsterKey: "slime_1",
      createdAt: at(-30_000),
      expireAt: at(60_000),
      protectUntil: at(-3_600_000),
    };
    seedGround(dbPath, [...zoneRows, otherZoneRow]);
    check(true, "塞进 4 行本区地面掉落 + 1 行别区（服务端的 100ms 批量写只会碰它自己内存里的那些）");

    //#endregion

    //#region 一、当前地面的筛选与字段

    group("当前地面 · 筛选与字段");

    // 用 URLSearchParams 拼参：手写字符串在「默认 size + 覆盖 size」时会拼出两个同名参数，
    // express 取第一个 —— 翻页那两条断言就这么假红过一次
    const ground = (extra = {}) =>
      api(baseUrl, "GET", `admin/drops/ground?${new URLSearchParams({ size: "100", ...extra })}`, {
        token: rootToken,
        zoneId: ADMIN_ZONE,
      });

    const all = await ground();
    check(all.status === 200 && all.body && all.body.code === 0, "当前地面列表可读", `${all.status}/${all.body && all.body.code}`);
    const rowsAll = (all.body && all.body.data && all.body.data.list) || [];
    check(rowsAll.length === zoneRows.length, "只返回本区的行（别区那行不可见）", `${rowsAll.length} 行 / 塞了 ${zoneRows.length} 行`);
    check(
      rowsAll.length > 0 && rowsAll.every((row) => row.zoneId === ADMIN_ZONE),
      "每一行的 zoneId 都是当前区",
      JSON.stringify(rowsAll.map((row) => row.zoneId)),
    );

    const known = rowsAll.find((row) => row.goodId === "drug_hp_1");
    const unknown = rowsAll.find((row) => row.goodId === "no_such_good_xyz");
    check(!!known && known.goodLabel !== known.goodId, "配置里有的物品：goodLabel 按配置拼出来（不是 id）", known && known.goodLabel);
    check(!!unknown && unknown.goodLabel === unknown.goodId, "配置里没有的物品：goodLabel 回落成 id 本身", unknown && unknown.goodLabel);

    const byMap = await ground({ mapId: "2" });
    const rowsMap2 = (byMap.body && byMap.body.data && byMap.body.data.list) || [];
    check(
      rowsMap2.length > 0 && rowsMap2.every((row) => row.mapId === "2") && byMap.body.data.total === rowsMap2.length,
      "mapId 精确筛选（total 跟着变，不是只筛当前页）",
      `total=${byMap.body && byMap.body.data && byMap.body.data.total}`,
    );

    const byKeyword = await ground({ keyword: "drug_hp" });
    const rowsKeyword = (byKeyword.body && byKeyword.body.data && byKeyword.body.data.list) || [];
    check(
      rowsKeyword.length > 0 && rowsKeyword.every((row) => row.goodId.includes("drug_hp")),
      "keyword 模糊匹配的是**物品 id**",
      JSON.stringify(rowsKeyword.map((row) => row.goodId)),
    );

    const byWildcard = await ground({ keyword: "%" });
    check(
      byWildcard.body && byWildcard.body.data && byWildcard.body.data.total === 0,
      "keyword 里的 `%` 被转义（不是「匹配全部」）",
      `total=${byWildcard.body && byWildcard.body.data && byWildcard.body.data.total}`,
    );

    const byOwner = await ground({ ownerName: "drop_adm" });
    const rowsOwner = (byOwner.body && byOwner.body.data && byOwner.body.data.list) || [];
    check(
      rowsOwner.length === 1 && rowsOwner[0].ownerName === "drop_adm_x",
      "ownerName 里的 `_` 被转义（否则 drop_adm 会把 dropAadmB 也算进来）",
      JSON.stringify(rowsOwner.map((row) => row.ownerName)),
    );

    //#endregion

    //#region 二、排序、分页与上限

    group("当前地面 · 排序与分页");

    const expiresOf = (result) => ((result.body && result.body.data && result.body.data.list) || []).map((row) => row.expireAt);
    const monotonic = (values) => values.every((value, index) => index === 0 || values[index - 1] <= value);
    const reversed = (values) => values.every((value, index) => index === 0 || values[index - 1] >= value);

    check(monotonic(expiresOf(all)), "默认按 expireAt 升序（最先消失的排在最上面）", JSON.stringify(expiresOf(all)));
    const desc = await ground({ sort: "expireAt", order: "desc" });
    check(reversed(expiresOf(desc)), "order=desc 反向", JSON.stringify(expiresOf(desc)));

    const badSort = await ground({ sort: ";DROP TABLE world_drops--" });
    check(
      badSort.status === 200 && JSON.stringify(expiresOf(badSort)) === JSON.stringify(expiresOf(all)),
      "白名单外的 sort 静默退回默认排序（200，不 500、不删表）",
      `${badSort.status}`,
    );

    const bigSize = await apiRaw(baseUrl, "GET", "admin/drops/ground?size=101", { token: rootToken, zoneId: ADMIN_ZONE });
    check(bigSize.status === 400, "size 超过上限被拒（400）", `${bigSize.status}`);

    const page2 = await ground({ page: "2", size: "3" });
    const page3 = await ground({ page: "3", size: "3" });
    check(
      page2.body && page2.body.data && page2.body.data.list.length === 1 && page2.body.data.total === zoneRows.length,
      "第 2 页只剩 1 行，total 仍是全量",
      `list=${page2.body && page2.body.data && page2.body.data.list.length}`,
    );
    check(
      page3.body && page3.body.data && page3.body.data.list.length === 0 && page3.body.data.total === zoneRows.length,
      "翻到末尾之后是空列表（total 不变）",
      `list=${page3.body && page3.body.data && page3.body.data.list.length}`,
    );

    //#endregion

    //#region 三、区是上下文不是参数

    group("区是上下文，不是参数");

    const noZone = await apiRaw(baseUrl, "GET", "admin/drops/ground", { token: rootToken });
    check(noZone.status === 400, "缺 X-Zone-Id → 400（管理端没有「无区」会话）", `${noZone.status}`);

    const wrongZone = await apiRaw(baseUrl, "GET", "admin/drops/ground?zoneId=99", { token: rootToken, zoneId: ADMIN_ZONE });
    check(
      wrongZone.status === 200 && wrongZone.body && wrongZone.body.data.total === zoneRows.length,
      "`?zoneId=` 传了也不生效（区只认请求头）",
      `total=${wrongZone.body && wrongZone.body.data && wrongZone.body.data.total}`,
    );

    const otherZone = await api(baseUrl, "GET", "admin/drops/ground?size=100", { token: rootToken, zoneId: otherZoneId });
    const rowsOther = (otherZone.body && otherZone.body.data && otherZone.body.data.list) || [];
    check(
      rowsOther.length === 1 && rowsOther[0].zoneId === otherZoneId,
      "换一个区头就只看得到那个区的行",
      JSON.stringify(rowsOther.map((row) => row.zoneId)),
    );

    const noToken = await apiRaw(baseUrl, "GET", "admin/drops/ground", { zoneId: ADMIN_ZONE });
    check(noToken.status === 401, "不带令牌 → 401", `${noToken.status}`);

    //#endregion

    //#region 四、概况卡（四格数字同源）

    group("当前地面 · 概况卡");

    const summary = await api(baseUrl, "GET", "admin/drops/ground/summary", { token: rootToken, zoneId: ADMIN_ZONE });
    const sum = summary.body && summary.body.data;
    check(!!sum && summary.body.code === 0, "概况可读", `${summary.status}`);
    check(!!sum && sum.total === rowsAll.length, "概况的 total 与同条件列表的 total 一致", `${sum && sum.total} / ${rowsAll.length}`);

    const byMapList = (sum && sum.byMap) || [];
    check(
      byMapList.reduce((acc, item) => acc + item.total, 0) === sum.total,
      "按图明细求和 == 顶层 total（同一次分组查询，不是三次 COUNT）",
      JSON.stringify(byMapList.map((item) => [item.mapId, item.total])),
    );
    check(
      byMapList.reduce((acc, item) => acc + item.protectedTotal, 0) === sum.protectedTotal &&
        byMapList.reduce((acc, item) => acc + item.expiringTotal, 0) === sum.expiringTotal,
      "保护中 / 即将过期同样是明细求和",
      `${sum.protectedTotal} / ${sum.expiringTotal}`,
    );
    check(sum.protectedTotal === 1 && sum.expiringTotal === 1, "保护中与「1 分钟内过期」各数到该数的那一行", `${sum.protectedTotal} / ${sum.expiringTotal}`);

    const params = await api(baseUrl, "GET", "admin/runtime-params", { token: rootToken, zoneId: ADMIN_ZONE });
    const capParam = params.body && params.body.data && params.body.data.drop && params.body.data.drop.maxGroundPerMap;
    const expectedCap = Number.isFinite(Number(capParam)) && Number(capParam) > 0 ? Math.floor(Number(capParam)) : null;
    check(
      sum.capPerMap === expectedCap && byMapList.every((item) => item.cap === expectedCap),
      "capPerMap 与运行时参数同源（管理端不复制一份写死的上限）",
      `快照=${expectedCap} / 概况=${sum.capPerMap}`,
    );
    check(Number.isFinite(sum.serverNow) && sum.serverNow > 0, "概况带 serverNow（页面算剩余秒数不读本机时钟）", `${sum.serverNow}`);

    const nowForRows = sum.serverNow;
    check(
      rowsAll.every((row) => row.remainMs > 0 && row.remainMs <= row.totalMs && row.protecting === row.protectUntil > nowForRows),
      "remainMs / totalMs / protecting 都是服务端算好的（与 serverNow 同口径）",
      JSON.stringify(rowsAll.map((row) => [row.remainMs, row.totalMs, row.protecting])),
    );

    //#endregion

    //#region 五、怪物掉落反查（配置面）

    group("怪物掉落反查");

    const index = await api(baseUrl, "GET", "admin/drops/monster-index?size=100", { token: rootToken, zoneId: ADMIN_ZONE });
    const indexRows = (index.body && index.body.data && index.body.data.list) || [];
    check(index.status === 200 && indexRows.length > 0, "反查可读（出厂配置里每只怪都有掉落池）", `total=${index.body && index.body.data && index.body.data.total}`);

    check(
      indexRows.every((row) => row.bound === (row.bindDrops || row.bindOnDrop)),
      "bound 是「怪物强制掉落 or 物品绑定」的或运算",
      JSON.stringify(indexRows.slice(0, 3).map((row) => [row.bindDrops, row.bindOnDrop, row.bound])),
    );
    check(
      indexRows.every((row) => (row.source === "table" ? row.tableId !== null : row.tableId === null)),
      "tableId 只在 source=table 时出现（内联条目池没有表 id）",
      JSON.stringify(indexRows.slice(0, 3).map((row) => [row.source, row.tableId])),
    );
    check(
      indexRows.every((row) => row.source === "entries" || row.source === "table"),
      "没配掉落（source=none）的怪不产生行",
      JSON.stringify([...new Set(indexRows.map((row) => row.source))]),
    );
    check(
      indexRows.every((row) => typeof row.weight === "number" && row.chance >= 0 && row.chance <= 1 && row.minCount <= row.maxCount),
      "权重 / 概率 / 件数区间形状正常",
      JSON.stringify(indexRows.slice(0, 3).map((row) => [row.weight, row.chance, row.minCount, row.maxCount])),
    );
    check(
      indexRows.every((row) => typeof row.monsterLabel === "string" && row.monsterLabel.length > 0),
      "怪物显示名不为空（查不到配置时回落成 key）",
      indexRows[0] && `${indexRows[0].monsterKey} → ${indexRows[0].monsterLabel}`,
    );

    const sortedByKey = indexRows.every((row, i) => {
      if (i === 0) return true;
      const prev = indexRows[i - 1];
      if (prev.monsterKey !== row.monsterKey) return prev.monsterKey < row.monsterKey;
      return prev.goodId <= row.goodId;
    });
    check(sortedByKey, "排序稳定：先怪物 key、再物品 id", JSON.stringify(indexRows.slice(0, 3).map((row) => [row.monsterKey, row.goodId])));

    const again = await api(baseUrl, "GET", "admin/drops/monster-index?size=100", { token: rootToken, zoneId: ADMIN_ZONE });
    check(
      JSON.stringify((again.body && again.body.data && again.body.data.list) || []) === JSON.stringify(indexRows),
      "同样的查询两次结果完全一致（稳定排序，翻页不会漏行重行）",
    );

    const sample = indexRows[0];
    const byGood = await api(
      baseUrl,
      "GET",
      `admin/drops/monster-index?size=100&goodId=${encodeURIComponent(sample.goodId)}`,
      { token: rootToken, zoneId: ADMIN_ZONE },
    );
    const rowsByGood = (byGood.body && byGood.body.data && byGood.body.data.list) || [];
    check(
      rowsByGood.length > 0 && rowsByGood.every((row) => row.goodId === sample.goodId),
      "按 goodId 精确反查（「这件东西谁掉」）",
      `${rowsByGood.length} 只 / total=${byGood.body && byGood.body.data && byGood.body.data.total}`,
    );

    const byMonster = await api(
      baseUrl,
      "GET",
      `admin/drops/monster-index?size=100&monsterKey=${encodeURIComponent(sample.monsterKey)}`,
      { token: rootToken, zoneId: ADMIN_ZONE },
    );
    const rowsByMonster = (byMonster.body && byMonster.body.data && byMonster.body.data.list) || [];
    check(
      rowsByMonster.length > 0 && rowsByMonster.every((row) => row.monsterKey === sample.monsterKey),
      "按 monsterKey 精确反查（「这只怪掉什么」）",
      `${rowsByMonster.length} 行`,
    );

    const missing = await api(baseUrl, "GET", "admin/drops/monster-index?goodId=no_such_good_xyz", {
      token: rootToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      missing.body && missing.body.data && missing.body.data.total === 0 && missing.body.data.list.length === 0,
      "查一个没人掉的物品 → 空列表（不是 404）",
      `${missing.body && missing.body.data && missing.body.data.total}`,
    );

    const p1 = await api(baseUrl, "GET", "admin/drops/monster-index?size=1&page=1", { token: rootToken, zoneId: ADMIN_ZONE });
    const p2 = await api(baseUrl, "GET", "admin/drops/monster-index?size=1&page=2", { token: rootToken, zoneId: ADMIN_ZONE });
    const first = p1.body && p1.body.data && p1.body.data.list[0];
    const second = p2.body && p2.body.data && p2.body.data.list[0];
    check(
      !!first && !!second && !(first.monsterKey === second.monsterKey && first.goodId === second.goodId),
      "size=1 时第 1 / 第 2 页是两行不同的配置",
      `${first && first.monsterKey}:${first && first.goodId} / ${second && second.monsterKey}:${second && second.goodId}`,
    );
    check(
      !!p1.body && !!p2.body && p1.body.data.total === p2.body.data.total,
      "分页不改 total（内存分页，不把答案切碎）",
      `${p1.body && p1.body.data.total}`,
    );

    const indexOtherZone = await api(baseUrl, "GET", "admin/drops/monster-index?size=100", {
      token: rootToken,
      zoneId: otherZoneId,
    });
    check(
      JSON.stringify((indexOtherZone.body && indexOtherZone.body.data && indexOtherZone.body.data.list) || []) === JSON.stringify(indexRows),
      "反查不分区（配置全区共用一份），换区头内容一样",
    );

    const indexNoZone = await apiRaw(baseUrl, "GET", "admin/drops/monster-index", { token: rootToken });
    check(indexNoZone.status === 400, "反查虽然不拿区筛数据，仍要求区头（管理端只有一种请求习惯）", `${indexNoZone.status}`);

    //#endregion

    //#region 六、权限（drop:read 的范围）

    group("权限");

    const viewerGround = await apiRaw(baseUrl, "GET", "admin/drops/ground", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerGround.status === 200, "只读观察员能看当前地面（drop:read 给到观察员）", `${viewerGround.status}`);

    const viewerRecords = await apiRaw(baseUrl, "GET", "admin/drops/records", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerRecords.status === 200, "只读观察员能看掉落流水（#803 的两个接口一并迁到 drop:read）", `${viewerRecords.status}`);

    const viewerEvents = await apiRaw(baseUrl, "GET", "admin/event-logs", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(
      viewerEvents.status === 403,
      "对照组：观察员读玩家行为流水被拒（event:read 含来源 IP，属于查人数据）",
      `${viewerEvents.status}`,
    );

    const { AdminRole, ROLE_PERMISSIONS, Permission } = require(PERMISSION_MODULE);
    check(
      ROLE_PERMISSIONS[AdminRole.VIEWER].includes(Permission.DROP_READ),
      "ROLE_PERMISSIONS[VIEWER] 里确实登记了 drop:read（不是靠上一行的巧合）",
    );
    check(
      !ROLE_PERMISSIONS[AdminRole.VIEWER].includes(Permission.EVENT_READ),
      "ROLE_PERMISSIONS[VIEWER] 里没有 event:read（两个页面的分野在权限表里写着）",
    );

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 掉落管理端（监控 / 反查 / 权限）：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-40).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server) await stopServer(server);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
