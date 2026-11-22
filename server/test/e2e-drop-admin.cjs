#!/usr/bin/env node
/**
 * 管理端掉落三件套的读接口 + 清空链路专项 e2e（server/test/e2e-drop-admin.cjs，#805）
 *
 * ## 这一套盯什么
 *
 * 写侧证据在 `e2e-drop`（四种终态各写一行流水），流水读侧在 `e2e-drop-records`。
 * 这一套盯 #805 新加的那一层 —— **管理端能不能把「地上有什么 / 已经结束的 / 谁会掉」看对**，
 * 以及那条跨进程的「按图清空」到底有没有落地：
 *
 * 一、**地面（`world_drops` 投影）**：筛选（地图 / 物品 id 模糊 / 归属者模糊，`%` 转义）、
 *    排序白名单、`size` 上限、缺区头一律 400；DTO 里的 `remainMs` / `protecting` 是服务端算的
 * 二、**概况**：四个数字从同一次分组查询求和而来（保护中 / 即将过期都不会超过总数）、
 *    `capPerMap` 来自运行时参数、`serverNow` 是本进程的时钟
 * 三、**清空**：三道确认（`confirm` 必须 true、`mapId` 非空）、同一张图未完成的请求**就地合并**、
 *    真正执行的是实时进程（这里验「请求完成 + 地上真的空了 + 每件都写了 overflow/manual_clear 流水」）
 * 四、**流水**：`result` 非法值 400、`monsterKey` 模糊（key 与快照名都命中）、`pickedName` 模糊、
 *    时间窗反向为空；概况**不吃** `result`（四个终态恒出现）
 * 五、**反查（`monster-index`）**：`goodId` 精确命中且行内 `goodId` 全等、`bound` 与两个来源开关自洽、
 *    `source` 只有 entries / table 两种
 * 六、**两个权限点**：观察员（viewer）能读三组接口，**不能**清空（`drop:clear` 只给管理员）
 *
 * ## 为什么单独一套
 *
 * 这套要同时「打一只怪产出真掉落」+「扮演两种管理员角色」，塞进 `e2e-drop`（世界语义）
 * 或 `e2e-drop-records`（两段进程验保留闸）都会把那边变成什么都测一点的套装。
 * 与其他 e2e 一样：用临时文件库。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-drop-admin-805";
const PLAYER = "dda_alice";

//#region 断言小工具（与 e2e-drop 同款口径）

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

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(150);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 起一台服务（文件库；嵌入的实时进程跟着一起起，清空请求才有执行者） */
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
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1500",
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

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  try {
    return await response.json();
  } catch {
    // 非 JSON 响应（空体 / 网关页）会让调用方拿到 null —— 把状态码说出来，否则只会看到
    // 「Cannot read properties of null」这种毫无信息量的崩法
    console.log(`  [--] ${method} /${route} 返回非 JSON（HTTP ${response.status}）`);
    return null;
  }
}

/** 一条会话化的连接（world / settle / picked 都收） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    settles: [],
    pickeds: [],
    async joinWorld(mapId, timeoutMs = 10_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    async waitSettle(castId, timeoutMs = 5_000) {
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.filter((frame) => frame.castId === castId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    async waitPicked(dropId, timeoutMs = 8_000) {
      return waitFor(
        `dropId=${dropId} 的 picked`,
        async () => {
          const hits = session.pickeds.filter((frame) => frame.dropId === dropId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "picked") session.pickeds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 地面投影的当前行数（直接读库；投影是 100ms 一拍刷的，所以断言都配 waitFor） */
function groundRows(dbPath, mapId = "0") {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT drop_id, good_id FROM world_drops WHERE map_id = ?").all(mapId);
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-drop-admin-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：超级管理员 / 观察员 / 一名玩家 / 一件真掉落");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "dropadm_root", password: "Drop#12345", registerCode: ADMIN_CODE },
    });
    const rootLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "dropadm_root", password: "Drop#12345" },
    });
    const adminToken = rootLogin.data && rootLogin.data.token;
    check(!!adminToken, "准备：超级管理员已登录", rootLogin.message);

    // #1084 重排后整套搬去图 0（唯一有怪的图），而图 0 出厂 allow_drop = 0 且怪带主动攻击 ——
    // 先整份提交打开掉落、临时关掉全图主动攻击（AI 缓存 1 秒 TTL）；库是一次性的，不还原
    const rulesZero = (await api(baseUrl, "GET", "admin/maps/0/rules", { token: adminToken, zoneId: ADMIN_ZONE })).data || null;
    if (rulesZero && rulesZero.allowDrop === false) {
      await api(baseUrl, "PATCH", "admin/maps/0/rules", {
        token: adminToken, zoneId: ADMIN_ZONE,
        body: { ...rulesZero, allowDrop: true, mapId: undefined, inherited: undefined, updatedBy: undefined, updatedAt: undefined },
      });
    }
    const calmMonsters = await api(baseUrl, "GET", "admin/monsters?page=1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    for (const row of (calmMonsters.data && calmMonsters.data.list) || []) {
      if (!row.presentation) continue;
      await api(baseUrl, "PATCH", `admin/monsters/${row.id}`, {
        token: adminToken, zoneId: ADMIN_ZONE, body: { presentation: { aggressive: false } },
      });
    }
    // 随机绑定概率压 0：反查段的「bound 与两个来源开关自洽」不认 bindChance 这第三个来源
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { bindChance: 0 } } });
    await sleep(1500);

    // 观察员：注册后再由超管降级（注册接口没有角色入参，这是唯一的一条路）
    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "dropadm_viewer", password: "View#12345", registerCode: ADMIN_CODE },
    });
    const admins = await api(baseUrl, "GET", "admin/admins", { token: adminToken, zoneId: ADMIN_ZONE });
    const viewerRow = (admins.data && (admins.data.list || admins.data.items || [])) instanceof Array
      ? (admins.data.list || admins.data.items || []).find((item) => item.username === "dropadm_viewer")
      : null;
    const demoted = viewerRow
      ? await api(baseUrl, "PATCH", `admin/admins/${viewerRow.id}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { role: "viewer" } })
      : null;
    const viewerLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "dropadm_viewer", password: "View#12345" },
    });
    const viewerToken = viewerLogin.data && viewerLogin.data.token;
    check(
      !!(demoted && demoted.code === 0 && viewerToken),
      "准备：观察员账号已建好（角色 viewer，拥有 drop:read 但不拥有 drop:clear）",
      demoted && demoted.message,
    );

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: PLAYER, password: "pass1234" } });
    const playerToken = registered && registered.data && registered.data.token;
    check(!!playerToken, "准备：玩家账号已注册", JSON.stringify(registered && { code: registered.code, message: registered.message }));
    const created = await api(baseUrl, "POST", "roles", { token: playerToken, body: { name: PLAYER, occupation: "1", sex: "1" } });
    placeRolesAt(dbPath, "0", [PLAYER]);
    const player = { token: playerToken, roleId: created && created.data && created.data.id, name: PLAYER };
    check(!!player.roleId, "准备：角色已创建", JSON.stringify(created && { code: created.code, message: created.message }));

    // 背包要有格子，否则拾取一律 bag_full（「拾取者」那一段要靠它）
    const initial = await api(baseUrl, "GET", `roles/${player.roleId}`, { token: player.token });
    check(!!(initial && initial.data), "准备：能读回刚建的角色", JSON.stringify(initial && { code: initial.code, message: initial.message }));
    const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
    await api(baseUrl, "PUT", `roles/${player.roleId}`, {
      token: player.token,
      body: { revision: initial.data && initial.data.revision, data: { ...(initial.data.data || {}), bag: emptyGrid } },
    });

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: player.token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("玩家握手成功", async () => (session.opened ? session : null));
    const world = await session.joinWorld("0");
    check(!!(world && world.mapId === "0"), "准备：玩家已进图 0");

    /** 把某只怪的掉落改成「必掉 1 件 drug_hp_1」（结果确定，才好断言地面与流水） */
    const patchDropOf = (monsterKey) =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { tableId: null, picks: 1, entries: [{ goodId: "drug_hp_1", weight: 100, chance: 1, count: [1, 1] }], bindDrops: false },
      });

    let castSeq = 0;
    let lastKillError = "";

    const aliveMobOf = async (mapId) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await session.joinWorld(mapId);
        // 靶子挑「编号最小的活怪」：图 0 重铺刷怪区后第一个实例是 10 级 boss，
        // 它的掉落表可能是空的（打死了也不掉东西），低编号怪才有掉落可断言
        const mob = snapshot && Array.isArray(snapshot.monsters)
          ? [...snapshot.monsters]
              .filter((monster) => monster.alive)
              .sort((a, b) => Number(a.monsterKey) - Number(b.monsterKey))[0] || null
          : null;
        if (mob) return mob;
        await sleep(1_500);
      }
      return null;
    };

    /** 打一只活着的怪，返回这次击杀的结算（打不成返回 null，原因留在 `lastKillError`） */
    const killOne = async (mapId = "0") => {
      const deadline = Date.now() + 40_000;
      for (let target = 0; target < 3 && Date.now() < deadline; target += 1) {
        const mob = await aliveMobOf(mapId);
        if (!mob) {
          lastKillError = `等了 12 秒没等到活怪（mapId=${mapId}）`;
          return null;
        }
        await patchDropOf(mob.monsterKey);
        const stand = JSON.stringify({ type: "pos", data: { mapId, x: mob.x, y: mob.y, hp: 100 } });
        session.socket.send(stand);
        session.socket.send(stand);
        for (let i = 0; i < 80 && Date.now() < deadline; i += 1) {
          await paceCast();
          const castId = ++castSeq;
          session.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }));
          const settle = await session.waitSettle(castId);
          if (!settle) {
            lastKillError = `castId=${castId} 没收到结算帧`;
            break;
          }
          if (!settle.ok) {
            lastKillError = `cast 被拒：${settle.code || ""} ${settle.message || ""}`.trim();
            if (settle.code === "dead") await api(baseUrl, "POST", `roles/${player.roleId}/revive`, { token: player.token });
            break;
          }
          if (settle.killed) {
            lastKillError = "";
            return settle;
          }
        }
        await sleep(500);
      }
      return null;
    };

    const dropIdOf = (settle) => {
      const drops = settle && settle.reward && settle.reward.drops;
      return Array.isArray(drops) && drops[0] && typeof drops[0].dropId === "string" ? drops[0].dropId : "";
    };

    const killed = await killOne();
    const dropId = dropIdOf(killed);
    check(!!dropId, "准备：打出一件地面掉落（后面所有断言都以它为靶子）", dropId || lastKillError);

    /** 等投影表里出现这件（100ms 一拍，落库有延迟） */
    const projected = await waitFor("地面投影里出现这件掉落", async () => {
      const rows = groundRows(dbPath, "0");
      return rows.some((row) => row.drop_id === dropId) ? rows.length : null;
    });
    check(!!projected, "准备：投影表已写入（管理端读的就是它）", String(projected));

    //#endregion

    //#region 一、地面读接口

    group("一、地面：筛选 / 排序白名单 / 分页上限 / 区头必填");

    const groundAll = await api(baseUrl, "GET", "admin/drops/ground", { token: adminToken, zoneId: ADMIN_ZONE });
    const groundRowsList = (groundAll.data && groundAll.data.list) || [];
    const target = groundRowsList.find((row) => row.dropId === dropId);
    check(!!target, "地面列表里能找到刚掉的那件", JSON.stringify({ dropId, total: groundAll.data && groundAll.data.total }));
    check(
      !!(target && target.goodId === "drug_hp_1" && target.count >= 1 && target.ownerName === PLAYER),
      "DTO 把物品 / 件数 / 归属者都拼对了（归属者 = 击杀者角色名）",
      JSON.stringify(target && { goodId: target.goodId, count: target.count, ownerName: target.ownerName }),
    );
    check(
      !!(target && typeof target.remainMs === "number" && typeof target.totalMs === "number" && target.remainMs <= target.totalMs),
      "剩余时间是服务端算的，且不会超过总时长",
      JSON.stringify(target && { remainMs: target.remainMs, totalMs: target.totalMs }),
    );
    check(
      !!(target && typeof target.protecting === "boolean"),
      "protecting 是布尔（页面不自己比时钟，服务端判）",
      String(target && target.protecting),
    );

    const groundByMap = await api(baseUrl, "GET", `admin/drops/ground?mapId=0`, { token: adminToken, zoneId: ADMIN_ZONE });
    const groundOtherMap = await api(baseUrl, "GET", `admin/drops/ground?mapId=__nope__`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundByMap.data && groundByMap.data.list.some((row) => row.dropId === dropId)) &&
        !!(groundOtherMap.data && groundOtherMap.data.total === 0),
      "mapId 精确过滤：命中本图 / 不存在的图 0 条",
      JSON.stringify({ hit: groundByMap.data && groundByMap.data.total, miss: groundOtherMap.data && groundOtherMap.data.total }),
    );

    const groundByKeyword = await api(baseUrl, "GET", "admin/drops/ground?keyword=drug_hp", { token: adminToken, zoneId: ADMIN_ZONE });
    const groundByOddKeyword = await api(baseUrl, "GET", "admin/drops/ground?keyword=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundByKeyword.data && groundByKeyword.data.list.some((row) => row.dropId === dropId)) &&
        !!(groundByOddKeyword.data && groundByOddKeyword.data.total === 0),
      "keyword 模糊匹配物品 id（`world_drops` 只存 id，名字是接口按当前配置拼的）",
      JSON.stringify({ hit: groundByKeyword.data && groundByKeyword.data.total, miss: groundByOddKeyword.data && groundByOddKeyword.data.total }),
    );

    const groundByOwner = await api(baseUrl, "GET", `admin/drops/ground?ownerName=${encodeURIComponent(PLAYER.slice(0, 5))}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    const groundByWildcard = await api(baseUrl, "GET", "admin/drops/ground?ownerName=%25", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundByOwner.data && groundByOwner.data.list.some((row) => row.dropId === dropId)) &&
        !!(groundByWildcard.data && groundByWildcard.data.total === 0),
      "ownerName 模糊命中；`%` 被转义（当成普通字符，不是「匹配所有人」）",
      JSON.stringify({ hit: groundByOwner.data && groundByOwner.data.total, wildcard: groundByWildcard.data && groundByWildcard.data.total }),
    );

    const groundSorted = await api(baseUrl, "GET", "admin/drops/ground?sort=expireAt&order=asc", { token: adminToken, zoneId: ADMIN_ZONE });
    const groundBogusSort = await api(baseUrl, "GET", "admin/drops/ground?sort=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundSorted.data && groundSorted.data.list.length > 0) && !!(groundBogusSort.data && groundBogusSort.data.list.length > 0),
      "排序字段走白名单：合法值生效，非法值退回默认（不 500、不空列表）",
      JSON.stringify({ sorted: groundSorted.data && groundSorted.data.list.length, bogus: groundBogusSort.data && groundBogusSort.data.list.length }),
    );

    const groundOverSize = await api(baseUrl, "GET", "admin/drops/ground?size=101", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundOverSize && groundOverSize.code === 40000),
      "size 超上限被拒（40000 参数校验）",
      JSON.stringify(groundOverSize && { code: groundOverSize.code, message: groundOverSize.message }),
    );

    const groundNoZone = await api(baseUrl, "GET", "admin/drops/ground", { token: adminToken });
    check(
      !!(groundNoZone && groundNoZone.code === 50029 && !groundNoZone.data),
      "缺 `X-Zone-Id` → 50029 ZONE_REQUIRED（区是上下文，不是可省略的查询参数）",
      JSON.stringify(groundNoZone && { code: groundNoZone.code, message: groundNoZone.message }),
    );

    //#endregion

    //#region 二、概况

    group("二、概况：四个数字同源，且都不超过总数");

    const summary = await api(baseUrl, "GET", "admin/drops/ground/summary", { token: adminToken, zoneId: ADMIN_ZONE });
    const sum = summary.data;
    check(
      !!(sum && typeof sum.total === "number" && sum.total >= 1),
      "概况的总件数与地面列表对得上（都 ≥ 1）",
      JSON.stringify(sum && { total: sum.total, list: groundAll.data && groundAll.data.total }),
    );
    check(
      !!(sum && sum.protectedTotal <= sum.total && sum.expiringTotal <= sum.total),
      "保护中 / 即将过期都不会超过总件数（同一次分组查询求和，不是三个时间点）",
      JSON.stringify(sum && { total: sum.total, protectedTotal: sum.protectedTotal, expiringTotal: sum.expiringTotal }),
    );
    const thisMap = sum && (sum.byMap || []).find((item) => item.mapId === "0");
    check(
      !!(thisMap && thisMap.cap > 0 && thisMap.total >= 1),
      "按图明细里有这张图，且单图上限来自运行时参数（> 0）",
      JSON.stringify(thisMap),
    );
    check(
      !!(sum && Math.abs(Date.now() - sum.serverNow) < 60_000),
      "serverNow 是本进程的时钟（页面算剩余秒数用它，不读本机时钟）",
      String(sum && sum.serverNow),
    );

    //#endregion

    //#region 三、清空（跨进程指令）

    group("三、清空：三道确认 / 就地合并 / 真的清空且照写流水");

    const noConfirm = await api(baseUrl, "POST", "admin/drops/clear", { token: adminToken, zoneId: ADMIN_ZONE, body: { mapId: "0" } });
    const falseConfirm = await api(baseUrl, "POST", "admin/drops/clear", { token: adminToken, zoneId: ADMIN_ZONE, body: { mapId: "0", confirm: false } });
    const noMap = await api(baseUrl, "POST", "admin/drops/clear", { token: adminToken, zoneId: ADMIN_ZONE, body: { mapId: "   ", confirm: true } });
    check(
      !!(noConfirm && noConfirm.code === 40000) && !!(falseConfirm && falseConfirm.code === 40000) && !!(noMap && noMap.code === 40000),
      "缺 confirm / confirm=false / mapId 空 → 全部 40000（服务端自己也不信前端）",
      JSON.stringify({ noConfirm: noConfirm && noConfirm.code, falseConfirm: falseConfirm && falseConfirm.code, noMap: noMap && noMap.code }),
    );

    const accepted = await api(baseUrl, "POST", "admin/drops/clear", { token: adminToken, zoneId: ADMIN_ZONE, body: { mapId: "0", confirm: true } });
    const request = accepted && accepted.data;
    check(
      !!(request && typeof request.requestId === "number" && request.requestId > 0 && request.mapId === "0"),
      "提交成功：返回 requestId + mapId（真正执行的是实时进程，这里只是受理）",
      JSON.stringify(request && { requestId: request.requestId, merged: request.merged, groundTotal: request.groundTotal }),
    );
    check(
      !!(request && request.groundTotal >= 1),
      "受理时的地面件数 ≥ 1（页面用它显示「提交时地上约 N 件」）",
      String(request && request.groundTotal),
    );

    /**
     * 立刻再发一次：同一张图**未完成**的请求要就地合并
     *
     * 不断言「一定是合并」—— 实时进程可能在这两次调用之间就把它做完了。这里断的是
     * **自洽**：返同一个 requestId 就必须 `merged=true`，返新 id 就必须 `merged=false`。
     */
    const again = await api(baseUrl, "POST", "admin/drops/clear", { token: adminToken, zoneId: ADMIN_ZONE, body: { mapId: "0", confirm: true } });
    const againData = again && again.data;
    check(
      !!(againData && (againData.requestId === request.requestId ? againData.merged === true : againData.merged === false)),
      "同一张图连点两下：合并语义自洽（同 id ⇒ merged=true；新 id ⇒ merged=false）",
      JSON.stringify(againData && { requestId: againData.requestId, first: request.requestId, merged: againData.merged }),
    );

    /** 等实时进程回写（`clears` 里那条的 doneAt 出现） */
    const done = await waitFor("清空请求被执行（doneAt 出现）", async () => {
      const snapshot = await api(baseUrl, "GET", "admin/drops/ground/summary", { token: adminToken, zoneId: ADMIN_ZONE });
      const items = (snapshot.data && snapshot.data.clears) || [];
      return items.find((item) => item.id === request.requestId && item.doneAt !== null) || null;
    });
    check(
      !!(done && typeof done.cleared === "number" && done.cleared >= 1 && done.cleared <= request.groundTotal),
      "执行结果回写到概况：清掉的件数在 1 与「受理时的地面件数」之间",
      JSON.stringify(done && { cleared: done.cleared, groundTotal: request.groundTotal }),
    );

    const emptied = await waitFor("投影表里这张图被清空", async () => (groundRows(dbPath, "0").length === 0 ? true : null));
    check(!!emptied, "地面投影真的空了（不是只改了个标记）", String(projected));

    const groundAfterClear = await api(baseUrl, "GET", "admin/drops/ground?mapId=1", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(groundAfterClear.data && groundAfterClear.data.total === 0),
      "清空后地面列表 0 条（页面看到的是同一个投影）",
      String(groundAfterClear.data && groundAfterClear.data.total),
    );

    const clearedRecord = await waitFor("流水里出现这件掉落的 overflow 行", async () => {
      const rows = await api(baseUrl, "GET", `admin/drops/records?goodId=drug_hp_1&result=overflow`, { token: adminToken, zoneId: ADMIN_ZONE });
      const hit = ((rows.data && rows.data.list) || []).find((row) => row.dropId === dropId);
      return hit || null;
    });
    check(
      !!(clearedRecord && clearedRecord.reason === "manual_clear" && clearedRecord.resultLabel),
      "清空照写流水：overflow + reason=manual_clear（东西不会还回去，但账上要有）",
      JSON.stringify(clearedRecord && { dropId: clearedRecord.dropId, result: clearedRecord.result, reason: clearedRecord.reason }),
    );

    //#endregion

    //#region 四、流水

    group("四、流水：新筛选（怪物 / 拾取者）/ 非法值 / 概况不吃 result");

    const badResult = await api(baseUrl, "GET", "admin/drops/records?result=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(badResult && badResult.code === 40000), "result 非法值 → 40000（枚举是白名单，不是自由文本）", JSON.stringify(badResult && { code: badResult.code, message: badResult.message }));

    const byMonsterKey = await api(baseUrl, "GET", `admin/drops/records?monsterKey=${encodeURIComponent((clearedRecord && clearedRecord.monsterKey) || "")}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!(byMonsterKey.data && byMonsterKey.data.list.some((row) => row.dropId === dropId)),
      "monsterKey 精确值能筛到这件（反查页点过来的那种用法）",
      JSON.stringify({ total: byMonsterKey.data && byMonsterKey.data.total }),
    );

    const monsterPrefix = ((clearedRecord && clearedRecord.monsterKey) || "").slice(0, 3);
    const byMonsterPrefix = await api(baseUrl, "GET", `admin/drops/records?monsterKey=${encodeURIComponent(monsterPrefix)}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!(monsterPrefix && byMonsterPrefix.data && byMonsterPrefix.data.list.some((row) => row.dropId === dropId)),
      "monsterKey 是模糊匹配（记不全 key 时输前缀也能查）",
      JSON.stringify({ prefix: monsterPrefix, total: byMonsterPrefix.data && byMonsterPrefix.data.total }),
    );

    const byMonsterLabel = await api(baseUrl, "GET", `admin/drops/records?monsterKey=${encodeURIComponent((clearedRecord && clearedRecord.monsterLabel) || "")}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(
      !!(clearedRecord && clearedRecord.monsterLabel && byMonsterLabel.data && byMonsterLabel.data.list.some((row) => row.dropId === dropId)),
      "monsterKey 也匹配快照里的中文名（运营手里通常只有名字）",
      JSON.stringify({ label: clearedRecord && clearedRecord.monsterLabel, total: byMonsterLabel.data && byMonsterLabel.data.total }),
    );

    const noMonster = await api(baseUrl, "GET", "admin/drops/records?monsterKey=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(noMonster.data && noMonster.data.total === 0), "查不存在的怪物 → 0 条（不是全量放行）", String(noMonster.data && noMonster.data.total));

    // 拾取：再打一只，把东西捡起来 —— 「拾取者」筛选要有真数据
    const killed2 = await killOne();
    const pickDropId = dropIdOf(killed2);
    check(!!pickDropId && pickDropId !== dropId, "打出第二件掉落（拾取者那一段的靶子）", pickDropId || lastKillError);
    if (pickDropId) {
      await waitFor("第二件已落库", async () => (groundRows(dbPath, "0").some((row) => row.drop_id === pickDropId) ? true : null));
      session.socket.send(JSON.stringify({ type: "pick", data: { dropId: pickDropId } }));
      const picked = await session.waitPicked(pickDropId);
      check(!!(picked && picked.ok === true), "这件被捡起来了（流水才会写 picked + picked_name）", JSON.stringify(picked && { ok: picked.ok, code: picked.code }));

      const pickedRecord = await waitFor("流水里出现 picked 行", async () => {
        const rows = await api(baseUrl, "GET", "admin/drops/records?result=picked", { token: adminToken, zoneId: ADMIN_ZONE });
        return ((rows.data && rows.data.list) || []).find((row) => row.dropId === pickDropId) || null;
      });
      check(
        !!(pickedRecord && pickedRecord.pickedName === PLAYER),
        "picked 行带上了拾取者名字（不是只有 id）",
        JSON.stringify(pickedRecord && { pickedName: pickedRecord.pickedName, pickedRoleId: pickedRecord.pickedRoleId }),
      );

      const byPicked = await api(baseUrl, "GET", `admin/drops/records?pickedName=${encodeURIComponent(PLAYER.slice(0, 5))}`, { token: adminToken, zoneId: ADMIN_ZONE });
      check(
        !!(byPicked.data && byPicked.data.list.some((row) => row.dropId === pickDropId)),
        "pickedName 模糊匹配能筛到这件",
        JSON.stringify({ total: byPicked.data && byPicked.data.total }),
      );

      const byPickedMiss = await api(baseUrl, "GET", "admin/drops/records?pickedName=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
      check(!!(byPickedMiss.data && byPickedMiss.data.total === 0), "pickedName 查不到就是 0 条（不是退回全量）", String(byPickedMiss.data && byPickedMiss.data.total));
    }

    const reverseWindow = await api(baseUrl, "GET", `admin/drops/records?from=${Date.now()}&to=${Date.now() - 3_600_000}`, {
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    check(!!(reverseWindow.data && reverseWindow.data.total === 0), "时间窗反向（from > to）→ 0 条，不是全量", String(reverseWindow.data && reverseWindow.data.total));

    const recordsSorted = await api(baseUrl, "GET", "admin/drops/records?sort=livedMs&order=desc", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(recordsSorted.data && recordsSorted.data.list.length > 0), "sort=livedMs 在白名单里（按「在地上待了多久」排）", String(recordsSorted.data && recordsSorted.data.list.length));

    const recordsOverSize = await api(baseUrl, "GET", "admin/drops/records?size=101", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(recordsOverSize && recordsOverSize.code === 40000), "流水 size 超上限被拒（40000）", JSON.stringify(recordsOverSize && { code: recordsOverSize.code }));

    const sumFiltered = await api(baseUrl, "GET", "admin/drops/records/summary?result=overflow", { token: adminToken, zoneId: ADMIN_ZONE });
    const results = ((sumFiltered.data && sumFiltered.data.items) || []).map((item) => item.result).sort();
    check(
      JSON.stringify(results) === JSON.stringify(["expired", "overflow", "picked", "restart_lost"]),
      "概况**不吃** result 筛选：四个终态恒出现（传了 overflow 也只多不少）",
      JSON.stringify(results),
    );
    const sumTotal = sumFiltered.data && sumFiltered.data.total;
    const sumParts = ((sumFiltered.data && sumFiltered.data.items) || []).reduce((acc, item) => acc + item.total, 0);
    check(sumTotal === sumParts, "概况的合计 = 四格之和（同一套条件，不是四个时间点）", `${sumTotal} vs ${sumParts}`);

    //#endregion

    //#region 五、反查

    group("五、反查：摊平后的行自洽，且能按物品正查");

    const index = await api(baseUrl, "GET", "admin/drops/monster-index?goodId=drug_hp_1", { token: adminToken, zoneId: ADMIN_ZONE });
    const indexRows = (index.data && index.data.list) || [];
    check(
      indexRows.length > 0 && indexRows.every((row) => row.goodId === "drug_hp_1"),
      "goodId 精确过滤：命中的行物品全都等于它",
      JSON.stringify({ total: index.data && index.data.total }),
    );
    check(
      indexRows.every((row) => row.bound === (row.bindDrops || row.bindOnDrop)),
      "bound 与两个来源开关自洽（怪物强制绑定 或 物品掉出即绑定）",
      JSON.stringify(indexRows.slice(0, 2).map((row) => ({ bound: row.bound, bindDrops: row.bindDrops, bindOnDrop: row.bindOnDrop }))),
    );
    check(
      indexRows.every((row) => row.source === "entries" || row.source === "table"),
      "source 只有 entries / table 两种（走兜底的怪不产生行）",
      JSON.stringify([...new Set(indexRows.map((row) => row.source))]),
    );
    check(
      indexRows.every((row) => row.minCount <= row.maxCount && row.weight > 0 && row.chance > 0),
      "权重 / 概率 / 件数区间在合法范围（no-crash 且形状对）",
      JSON.stringify(indexRows.slice(0, 2).map((row) => ({ weight: row.weight, chance: row.chance, min: row.minCount, max: row.maxCount }))),
    );

    const indexNoKey = await api(baseUrl, "GET", "admin/drops/monster-index?monsterKey=__nope__", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(indexNoKey.data && indexNoKey.data.total === 0), "monsterKey 查不到 → 0 行", String(indexNoKey.data && indexNoKey.data.total));

    const indexKeyword = await api(baseUrl, "GET", "admin/drops/monster-index?keyword=drug_hp", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(indexKeyword.data && indexKeyword.data.total >= indexRows.length),
      "keyword 模糊匹配物品 id（记不全时用），命中数不会少于精确查",
      JSON.stringify({ keyword: indexKeyword.data && indexKeyword.data.total, exact: index.data && index.data.total }),
    );

    //#endregion

    //#region 六、两个权限点

    group("六、权限两点：观察员能读、不能清空");

    const viewerGround = await api(baseUrl, "GET", "admin/drops/ground", { token: viewerToken, zoneId: ADMIN_ZONE });
    const viewerRecords = await api(baseUrl, "GET", "admin/drops/records", { token: viewerToken, zoneId: ADMIN_ZONE });
    const viewerIndex = await api(baseUrl, "GET", "admin/drops/monster-index", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(
      !!(viewerGround.data && viewerRecords.data && viewerIndex.data),
      "观察员能读三组接口（`drop:read` 给了 viewer：主角是物品，与 role:read 同量级）",
      JSON.stringify({ ground: viewerGround.code, records: viewerRecords.code, index: viewerIndex.code }),
    );

    const viewerClear = await api(baseUrl, "POST", "admin/drops/clear", { token: viewerToken, zoneId: ADMIN_ZONE, body: { mapId: "0", confirm: true } });
    check(
      !!(viewerClear && viewerClear.code === 30006),
      "观察员不能清空（`drop:clear` 不可逆，只给管理员 → 30006 权限不足）",
      JSON.stringify(viewerClear && { code: viewerClear.code, message: viewerClear.message }),
    );

    //#endregion
  } finally {
    // 有失败项时把服务端日志尾巴打出来：跨进程链路的失败（清空没被执行）原因都在那边，
    // 只报「等待超时」等于让人重新猜一遍
    if (failed > 0) console.log(`\n--- 服务端日志（末 40 行）---\n${server.logs().split("\n").slice(-40).join("\n")}`);
    await stopServer(server);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* 临时库删不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "全部通过" : "有失败项"}：通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
