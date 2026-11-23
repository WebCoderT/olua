#!/usr/bin/env node
/**
 * 掉落终态流水的**读接口与保留闸**专项 e2e（server/test/e2e-drop-records.cjs，#803）
 *
 * ## 这一套盯什么
 *
 * 写侧的证据在 `e2e-drop`（picked / expired / overflow / restart_lost 四种终态各写一行）。
 * 这一套盯另一半 —— **管理端怎么把那张表读出来**，以及「这张表不许无限长」：
 *
 * 一、**筛选**：`result` / `ownerName`（模糊，`%` `_` 会被转义）/ `goodId`（精确）/ `from` 各自生效
 * 二、**分页与排序**：`size` 上限 100（超了 400）；`sort` 只认白名单（传别的值退回默认，不 500）
 * 三、**区是上下文，不是参数**：缺 `X-Zone-Id` → 400；`?zoneId=` 传了也不生效
 *    （管理端一次只在一个区里干活，见 docs/39 §2.4）
 * 四、**概况卡**：四个终态恒出现；同一条件下的 picked 计数与列表的 total 是同一个数
 * 五、**两道保留闸**：条数（每图 + 攒批裁剪）与天数（按 `created_at` 扫全表）——
 *    条数闸只在写入时触发，管不住「这张图从此没人打」，所以天数闸必须独立生效
 *
 * ## 为什么单独一套
 *
 * 保留闸要**换 env 重启进程**（`DROP_RECORD_*` 是部署级配置，不是运营参数），而生产取值
 * （2000 条 / 7 天）在 e2e 的时长里根本触发不到。这一套用同一个小库跑两段进程：第一段验
 * 读接口，第二段把保留参数压小，验两道闸真的会删。
 *
 * 与其他 e2e 一样：**用临时文件库**（两段进程要读写同一份数据）。
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
const ADMIN_CODE = "olua-e2e-drop-rec-admin";
const PLAYER = "drop_rec_al";

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
    await sleep(120);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 起一台服务（文件库）
 *
 * `DROP_RECORD_*` 走 `extraEnv`：保留闸是**部署级配置**（进程启动时读），
 * 第二段进程把它压小才验得到「真的会删」。
 */
async function startServer(dbPath, port, extraEnv = {}) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-drop-records-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1500",
      WORLD_MAP_IDLE_MS: "0",
      ...extraEnv,
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

/** 调接口，连 HTTP 状态一起返回（「缺区头 400」「size 超上限 400」要看状态码，不能只看 body） */
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

/** 只关心 body 的调用（成功路径） */
async function api(baseUrl, method, route, options = {}) {
  const { body } = await apiRaw(baseUrl, method, route, options);
  return body;
}

/** 一条会话化的连接（world / picked / settle 都收） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    pickeds: [],
    settles: [],
    async joinWorld(mapId, timeoutMs = 10_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    async waitSettle(castId, timeoutMs = 5_000) {
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    async waitPicked(dropId, timeoutMs = 5_000) {
      return waitFor(`dropId=${dropId} 的 picked`, async () => {
        const hits = session.pickeds.filter((frame) => frame.dropId === dropId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "picked") session.pickeds.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 读流水行（只读连接；服务端在写 WAL，读侧不受影响） */
function readRecords(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT * FROM drop_records ORDER BY id ASC").all();
  } finally {
    db.close();
  }
}

/**
 * 清掉某张图的历史流水
 *
 * 这一段要验的是「条数闸留下最新的」，库里若还躺着前面几段写下的行，dropId 的序号
 * （`d_<区>_<图>_<序号>`，按房间代际重排）就会与新一轮撞车，断言退化成「比 id」。
 */
function clearRecordsForMap(dbPath, zoneId, mapId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("DELETE FROM drop_records WHERE zone_id = ? AND map_id = ?").run(zoneId, mapId);
  } finally {
    db.close();
  }
}

/**
 * 直接插一条「历史流水」，返回**这次插进去的行数**
 *
 * 天数闸要验的是「`created_at` 早于保留期的行会被删」，而 e2e 里等不了 7 天 ——
 * 造一条 10 天前的行是唯一能验到那道闸的办法。插完立刻在**同一个连接**里回读条数，
 * 调用方据此确认「它真的在库里」：少了这一步，「查不到」既可能是被闸删了、也可能是压根没插进去。
 *
 * 写侧与服务器共用同一个库，WAL 下一次一个写者，`busy_timeout` 兜住偶发的争抢。
 */
function insertHistoricalRecord(dbPath, { dropId, createdAt }) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const result = db.prepare(
      `INSERT INTO drop_records (
         drop_id, zone_id, map_id, good_id, good_type, good_label, count, bound,
         monster_key, monster_label, monster_instance_id,
         owner_account_id, owner_role_id, owner_name,
         result, reason, picked_account_id, picked_role_id, picked_name,
         created_at, resolved_at, lived_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dropId, ADMIN_ZONE, "1", "drug_hp_1", "drug", "金创药（小）", 1, 0,
      "hist_monster", "历史怪", "m_hist_1",
      "acc_hist", "role_hist", "hist_owner",
      "expired", null, null, null, null,
      createdAt, createdAt + 1_000, 1_000,
    );
    const seen = db.prepare("SELECT COUNT(1) AS total FROM drop_records WHERE drop_id = ?").get(dropId);
    return result.changes > 0 && Number(seen && seen.total) === 1 ? 1 : 0;
  } finally {
    db.close();
  }
}


/**
 * 战场刷怪（#1177 全清后出厂快照不再带环带）：图 3（野外、0 级门槛）铺被动怪区。
 * **必须在服务端就绪之后调用** —— 空库首启的自举会整份替换配置表，启动前写会被抹掉。
 */
function seedBattlefield(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("DELETE FROM map_spawn_areas WHERE map_id = '3'");
  db.prepare(
    "INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("3", "掉落战场", "1", 2, 3, 1000, -600, 600, 600, Date.now());
  db.close();
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-drop-records-${Date.now()}.db`);
  const port = await freePort();
  let server = await startServer(dbPath, port);
  seedBattlefield(dbPath);
  try {
    let baseUrl = server.baseUrl;

    //#region 准备：管理员 / 一名玩家 / 一条真实流水

    group("准备：管理员 / 一名玩家 / 打一只怪捡一件（造出一条真实流水）");

    // 第一个注册的管理员自动是超级管理员（含本页复用的 event:read）
    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "drop_rec_admin", password: "Drop#12345", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "drop_rec_admin", password: "Drop#12345" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    // #1084 重排后整套搬去图 3（唯一有怪的图），而图 3 出厂 allow_drop = 0 且怪带主动攻击 ——
    // 先整份提交打开掉落、临时关掉全图主动攻击（AI 缓存 1 秒 TTL）；库是一次性的，不还原
    const rulesZero = (await api(baseUrl, "GET", "admin/maps/3/rules", { token: adminToken, zoneId: ADMIN_ZONE })).data || null;
    if (rulesZero && rulesZero.allowDrop === false) {
      await api(baseUrl, "PATCH", "admin/maps/3/rules", {
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
    await sleep(1500);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: PLAYER, password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: PLAYER, occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    // #859：没有位置记录的角色只准进新手村，按运营摆位放到图 3（#1084 重排后唯一有怪的图）
    placeRolesAt(dbPath, "3", [PLAYER]);
    // 新号的 `data.bag` 是空数组（= 没有网格），那种存档里任何拾取都会被判 bag_full
    const initial = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
    await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: initial.data && initial.data.revision, data: { ...(initial.data.data || {}), bag: emptyGrid } },
    });

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const alice = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("玩家握手成功", async () => (alice.opened ? alice : null));
    const world = await alice.joinWorld("3");
    check(!!world && world.mapId === "3", "准备：玩家已进图 3");

    /** 把某只怪的掉落改成「必掉 1 件 drug_hp_1」（picks 1 × chance 1 → 结果确定） */
    const patchDropOf = (monsterKey, goodId = "drug_hp_1") =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { tableId: null, picks: 1, entries: [{ goodId, weight: 100, chance: 1, count: [1, 1] }], bindDrops: false },
      });

    let castSeq = 0;
    /** 打一只活着的怪（等活怪 + 站在旁边上报位置），返回击杀那次的结算 */
    const killOne = async (mapId = "3") => {
      let snapshot = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        snapshot = await alice.joinWorld(mapId);
        if (snapshot && Array.isArray(snapshot.monsters) && snapshot.monsters.some((monster) => monster.alive)) break;
        await sleep(1_500);
      }
      // 靶子挑「编号最小的活怪」：图 3 重铺刷怪区后第一个实例是 10 级 boss，
      // 它的掉落表可能是空的（打死了也不掉东西），低编号怪才有掉落可断言
      const mob = snapshot && Array.isArray(snapshot.monsters)
        ? [...snapshot.monsters]
            .filter((monster) => monster.alive)
            .sort((a, b) => Number(a.monsterKey) - Number(b.monsterKey))[0] || null
        : null;
      if (!mob) return null;
      await patchDropOf(mob.monsterKey);
      const stand = JSON.stringify({ type: "pos", data: { mapId, x: mob.x, y: mob.y, hp: 100 } });
      alice.socket.send(stand);
      alice.socket.send(stand);
      for (let i = 0; i < 80; i += 1) {
        await paceCast();
        const castId = ++castSeq;
        alice.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }));
        const settle = await alice.waitSettle(castId);
        if (!settle || !settle.ok) return null;
        if (settle.killed) return settle;
      }
      return null;
    };
    /** 结算里第一件掉落的 dropId */
    const dropIdOf = (settle) => {
      const drops = settle && settle.reward && settle.reward.drops;
      return Array.isArray(drops) && drops[0] && typeof drops[0].dropId === "string" ? drops[0].dropId : "";
    };
    /** 打一只 + 捡起来，返回 { dropId, picked } */
    const killAndPick = async () => {
      const killed = await killOne();
      const dropId = dropIdOf(killed);
      if (!dropId) return { dropId: "", picked: null };
      alice.socket.send(JSON.stringify({ type: "pick", data: { dropId } }));
      const picked = await alice.waitPicked(dropId);
      return { dropId, picked };
    };

    const first = await killAndPick();
    check(!!first.dropId && !!(first.picked && first.picked.ok), "准备：击杀 → 掉落 → 捡起（造出一条 picked 流水）", JSON.stringify(first.picked));
    const firstRecord = await waitFor("picked 流水落库", async () => {
      const hit = readRecords(dbPath).find((row) => row.drop_id === first.dropId && row.result === "picked");
      return hit || null;
    }, 5_000);
    check(!!firstRecord, "准备：drop_records 里出现这条 picked 流水（100ms 攒批写）", JSON.stringify(firstRecord));

    //#endregion

    //#region 一、筛选

    group("一、筛选：result / ownerName（模糊 + 转义）/ goodId（精确）/ from 各自生效");

    const all = await api(baseUrl, "GET", "admin/drops/records", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(all && all.data && Array.isArray(all.data.list)) && all.data.list.some((row) => row.dropId === first.dropId),
      "A：不传条件就能查到这条（默认按终态时刻倒序）",
      JSON.stringify(all && all.data && all.data.list && all.data.list.slice(0, 1)),
    );
    check(
      !!(all && all.data && all.data.list) && all.data.list.every((row) => row.zoneId === ADMIN_ZONE),
      "A：只返回当前区的流水（区来自 X-Zone-Id，不是查询参数）",
      JSON.stringify(all && all.data && all.data.list && [...new Set(all.data.list.map((row) => row.zoneId))]),
    );

    const onlyPicked = await api(baseUrl, "GET", "admin/drops/records?result=picked&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    const onlyExpired = await api(baseUrl, "GET", "admin/drops/records?result=expired&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(onlyPicked && onlyPicked.data) && onlyPicked.data.list.every((row) => row.result === "picked") && onlyPicked.data.list.some((row) => row.dropId === first.dropId),
      "A：result=picked 只给 picked（刚捡的那条在里面）",
      JSON.stringify(onlyPicked && onlyPicked.data && onlyPicked.data.list.length),
    );
    check(
      !!(onlyExpired && onlyExpired.data) && onlyExpired.data.list.every((row) => row.result === "expired"),
      "A：result=expired 换一个终态也照样筛（不是「筛了个寂寞」）",
      JSON.stringify(onlyExpired && onlyExpired.data && onlyExpired.data.list.length),
    );
    const badResult = await apiRaw(baseUrl, "GET", "admin/drops/records?result=nope", { token: adminToken, zoneId: ADMIN_ZONE });
    check(badResult.status === 400, "A：没登记的 result 取值 → 400（白名单，不是静默返回空）", JSON.stringify(badResult.body));

    const byOwner = await api(baseUrl, "GET", `admin/drops/records?ownerName=${encodeURIComponent("drop_rec")}`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byOwner && byOwner.data) && byOwner.data.list.length > 0 && byOwner.data.list.every((row) => row.ownerName.includes("drop_rec")),
      "A：ownerName 是模糊匹配（查「某个人掉过什么」不用打全名）",
      JSON.stringify(byOwner && byOwner.data && byOwner.data.list.length),
    );
    // LIKE 的通配符必须转义：`%` 不转义会匹配到所有行（这条断言就是那次转义的见证）
    const byWildcard = await api(baseUrl, "GET", "admin/drops/records?ownerName=%25", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byWildcard && byWildcard.data) && byWildcard.data.list.length === 0 && byWildcard.data.total === 0,
      "A：名字里的 % 按字面量处理（不转义的话 `%` 会把所有行都捞出来）",
      JSON.stringify(byWildcard && byWildcard.data && byWildcard.data.total),
    );

    const byGood = await api(baseUrl, "GET", "admin/drops/records?goodId=drug_hp_1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byGood && byGood.data) && byGood.data.list.length > 0 && byGood.data.list.every((row) => row.goodId === "drug_hp_1"),
      "A：goodId 精确匹配（查「这件东西都掉过谁手里」）",
      JSON.stringify(byGood && byGood.data && byGood.data.list.length),
    );
    const byMissingGood = await api(baseUrl, "GET", "admin/drops/records?goodId=no_such_item", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byMissingGood && byMissingGood.data) && byMissingGood.data.total === 0 && byMissingGood.data.list.length === 0,
      "A：查不存在的物品给空列表（不是错误）",
      JSON.stringify(byMissingGood && byMissingGood.data && byMissingGood.data.total),
    );

    const future = Date.now() + 3_600_000;
    const byFuture = await api(baseUrl, "GET", `admin/drops/records?from=${future}`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byFuture && byFuture.data) && byFuture.data.total === 0,
      "A：from 之后没有流水就给空（时间筛按掉落落地时刻）",
      JSON.stringify(byFuture && byFuture.data && byFuture.data.total),
    );

    //#endregion

    //#region 二、分页与排序

    group("二、分页与排序：size 上限 100 / 排序白名单（传别的值退回默认，不 500）");

    const bigSize = await apiRaw(baseUrl, "GET", "admin/drops/records?size=101", { token: adminToken, zoneId: ADMIN_ZONE });
    check(bigSize.status === 400, "A：size=101 → 400（上限 100，防止一次把几万行塞进响应体）", JSON.stringify(bigSize.body));

    const byLived = await api(baseUrl, "GET", "admin/drops/records?sort=livedMs&order=asc&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(byLived && byLived.data) && Array.isArray(byLived.data.list) && byLived.data.list.every((row) => typeof row.livedMs === "number"),
      "A：按存活时长排序可用（sort=livedMs&order=asc）",
      JSON.stringify(byLived && byLived.data && byLived.data.list.length),
    );
    const sortedAsc = !!(byLived && byLived.data) && byLived.data.list.every((row, index, list) => index === 0 || list[index - 1].livedMs <= row.livedMs);
    check(sortedAsc, "A：升序确实是升序（服务端按白名单拼 SQL，不信任客户端字段名）", JSON.stringify((byLived.data && byLived.data.list || []).map((row) => row.livedMs)));

    const badSort = await apiRaw(baseUrl, "GET", `admin/drops/records?sort=${encodeURIComponent(";DROP TABLE drop_records--")}`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      badSort.status === 200 && !!(badSort.body && badSort.body.data),
      "A：没登记的 sort 退回默认排序（既不是 500，也不是把字段名拼进 SQL）",
      JSON.stringify(badSort.body && badSort.body.data && badSort.body.data.list.length),
    );
    const stillThere = await api(baseUrl, "GET", "admin/drops/records?size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(!!(stillThere && stillThere.data) && stillThere.data.total > 0, "A：那条可疑的 sort 之后表还在（排序字段只认白名单）");

    const badOrder = await apiRaw(baseUrl, "GET", "admin/drops/records?order=sideways", { token: adminToken, zoneId: ADMIN_ZONE });
    check(badOrder.status === 400, "A：order 只认 asc / desc（传别的 400）", JSON.stringify(badOrder.body));

    //#endregion

    //#region 三、区是上下文（缺区头 400 / ?zoneId= 不生效）

    group("三、区：缺 X-Zone-Id → 400；?zoneId= 传了也不生效");

    const noZone = await apiRaw(baseUrl, "GET", "admin/drops/records", { token: adminToken });
    check(noZone.status === 400, "A：不带 X-Zone-Id → 400（管理端一次只在一个区里干活）", JSON.stringify(noZone.body));

    const otherZone = await api(baseUrl, "GET", "admin/drops/records?zoneId=99&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(otherZone && otherZone.data) && otherZone.data.list.length > 0 && otherZone.data.list.every((row) => row.zoneId === ADMIN_ZONE),
      "A：?zoneId=99 被忽略（区是上下文，不是单次查询参数 —— 否则等于允许跨区翻别人的掉落）",
      JSON.stringify(otherZone && otherZone.data && otherZone.data.list.length),
    );

    const summaryNoZone = await apiRaw(baseUrl, "GET", "admin/drops/records/summary", { token: adminToken });
    check(summaryNoZone.status === 400, "A：概况接口同样要求 X-Zone-Id", JSON.stringify(summaryNoZone.body));

    //#endregion

    //#region 四、概况卡

    group("四、概况：四个终态恒出现，picked 的计数与列表的 total 是同一个数");

    const summary = await api(baseUrl, "GET", "admin/drops/records/summary", { token: adminToken, zoneId: ADMIN_ZONE });
    const items = (summary && summary.data && summary.data.items) || [];
    check(items.length >= 4, "A：四个终态恒出现（没有数据的给 0，而不是从界面上消失）", JSON.stringify(items));
    check(
      ["picked", "expired", "overflow", "restart_lost"].every((result) => items.some((item) => item.result === result)),
      "A：picked / expired / overflow / restart_lost 都在",
      JSON.stringify(items.map((item) => item.result)),
    );
    const pickedItem = items.find((item) => item.result === "picked");
    const pickedTotal = onlyPicked && onlyPicked.data && onlyPicked.data.total;
    check(
      pickedItem && pickedItem.total === pickedTotal,
      "A：概况里的 picked 计数 = 列表 result=picked 的 total（两个接口对同一份数据给同一个数）",
      JSON.stringify({ summary: pickedItem && pickedItem.total, list: pickedTotal }),
    );
    check(
      summary && summary.data && summary.data.total === items.reduce((sum, item) => sum + item.total, 0),
      "A：合计 = 各项之和（页面顶部那张卡不自己另算一遍）",
      JSON.stringify(summary && summary.data && summary.data.total),
    );
    const summaryWithResult = await api(baseUrl, "GET", "admin/drops/records/summary?result=picked", { token: adminToken, zoneId: ADMIN_ZONE });
    const itemsWithResult = (summaryWithResult && summaryWithResult.data && summaryWithResult.data.items) || [];
    check(
      itemsWithResult.length === items.length && itemsWithResult.some((item) => item.result === "expired"),
      "A：概况不吃 result 筛选（传了 picked 也只是「限定范围」，不会只剩一行）",
      JSON.stringify(itemsWithResult.map((item) => item.result)),
    );

    //#endregion

    //#region 五、两道保留闸（换 env 重启进程）

    group("五、保留闸：天数闸删陈旧流水，条数闸把该图收敛到保留条数");

    await stopServer(server);
    // 生产取值（2000 条 / 7 天）在 e2e 里触发不到，压小：每图 2 条、攒 1 条就裁、时间闸 1.5 秒扫一次。
    // 时间闸刻意不压到 300ms：先留出一段「确定不会扫」的窗口，才能证明那条历史流水真的插进去了
    // （否则「它不在库里」和「它被删了」分不开，这条断言会假绿）
    server = await startServer(dbPath, port, {
      DROP_RECORD_KEEP_PER_MAP: "2",
      DROP_RECORD_TRIM_EVERY: "1",
      DROP_RECORD_RETENTION_DAYS: "7",
      DROP_RECORD_PRUNE_MS: "1500",
    });
    baseUrl = server.baseUrl;
    check(!!server.baseUrl, "A：进程已带保留参数重启（同一份库）");

    // 启动时补跑一次（lastPruneAt = 0）→ 等它过去，再从下一个 tick 之前插入
    await sleep(600);

    // 天数闸：造一条 10 天前的行，等它被删（条数闸管不到它 —— 它已经不写了）
    const inserted = insertHistoricalRecord(dbPath, { dropId: "d_history_1", createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000 });
    check(inserted === 1, "A：历史流水已就位（10 天前的一条 expired；插完立刻回读确认，否则「删掉了」这条会假绿）");
    const pruned = await waitFor("天数闸删掉超期流水", async () => {
      const rows = readRecords(dbPath);
      return rows.some((row) => row.drop_id === "d_history_1") ? null : rows;
    }, 10_000);
    check(!!pruned, "B：超过保留期（7 天）的流水被天数闸删掉（死图的旧流水不会永远躺着）");
    check(
      readRecords(dbPath).every((row) => Date.now() - row.created_at < 7 * 24 * 60 * 60 * 1000),
      "B：留下的一条都是保留期内的（时间闸只按 created_at 删，不误伤新数据）",
      JSON.stringify(readRecords(dbPath).map((row) => row.drop_id)),
    );

    // 条数闸：重启后重新连上，再打几只各捡一件 —— 每写一批裁一次，收敛到 keep=2
    const relogin = await api(baseUrl, "POST", "auth/login", { body: { username: PLAYER, password: "pass1234" } });
    const reToken = relogin.data && relogin.data.token;
    const reTicket = await api(baseUrl, "POST", "realtime/ticket", { token: reToken });
    const again = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(reTicket.data.ticket)}`);
    await waitFor("重启后重新握手成功", async () => (again.opened ? again : null));
    const againWorld = await again.joinWorld("3");
    check(!!againWorld && againWorld.mapId === "3", "B：重启后能重新进图（保留闸不影响正常游戏）");

    // 同一段「打一只捡一件」的逻辑，只是换了新的连接
    const killAndPickAgain = async () => {
      let snapshot = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        snapshot = await again.joinWorld("3");
        if (snapshot && Array.isArray(snapshot.monsters) && snapshot.monsters.some((monster) => monster.alive)) break;
        await sleep(1_500);
      }
      // 靶子挑「编号最小的活怪」：图 3 重铺刷怪区后第一个实例是 10 级 boss，
      // 它的掉落表可能是空的（打死了也不掉东西），低编号怪才有掉落可断言
      const mob = snapshot && Array.isArray(snapshot.monsters)
        ? [...snapshot.monsters]
            .filter((monster) => monster.alive)
            .sort((a, b) => Number(a.monsterKey) - Number(b.monsterKey))[0] || null
        : null;
      if (!mob) return { dropId: "", picked: null };
      await patchDropOf(mob.monsterKey);
      const stand = JSON.stringify({ type: "pos", data: { mapId: "3", x: mob.x, y: mob.y, hp: 100 } });
      again.socket.send(stand);
      again.socket.send(stand);
      for (let i = 0; i < 80; i += 1) {
        await paceCast();
        const castId = ++castSeq;
        again.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }));
        const settle = await again.waitSettle(castId);
        if (!settle || !settle.ok) return { dropId: "", picked: null };
        if (!settle.killed) continue;
        const drops = (settle.reward && settle.reward.drops) || [];
        const dropId = drops[0] && typeof drops[0].dropId === "string" ? drops[0].dropId : "";
        if (!dropId) return { dropId: "", picked: null };
        again.socket.send(JSON.stringify({ type: "pick", data: { dropId } }));
        return { dropId, picked: await again.waitPicked(dropId) };
      }
      return { dropId: "", picked: null };
    };

    // 先把这张图的历史流水清空：这一段只验「条数闸留最新」，不该跟前面几段写的行抢序号
    clearRecordsForMap(dbPath, ADMIN_ZONE, "3");
    const written = [];
    for (let round = 0; round < 3; round += 1) {
      const result = await killAndPickAgain();
      if (result.picked && result.picked.ok) written.push(result.dropId);
    }
    check(written.length >= 3, "A：又写了 3 条 picked 流水（够触发条数闸）", JSON.stringify(written));

    // 保留条数是本用例自己设的 env（2 条），不是运营数据 —— 断的是「攒够一批会裁」这个机制
    const converged = await waitFor("条数闸把该图流水收敛到保留条数以内", async () => {
      const rows = readRecords(dbPath).filter((row) => row.zone_id === ADMIN_ZONE && row.map_id === "3");
      return rows.length > 0 && rows.length <= 2 ? rows : null;
    }, 15_000);
    check(!!converged, "B：写够一批之后按每图保留条数收敛（不是每写一条就 DELETE，也不是无限增长）", `共 ${converged && converged.length} 条`);
    check(
      !!(converged && written.length) && converged.some((row) => row.drop_id === written[written.length - 1]),
      "B：收敛时留下的是**最新**的那几条（裁掉的是最旧的）",
      JSON.stringify(converged && converged.map((row) => row.drop_id)),
    );

    const afterPrune = await api(baseUrl, "GET", "admin/drops/records?size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      !!(afterPrune && afterPrune.data) && afterPrune.data.list.length > 0,
      "B：裁剪之后读接口照常可用（两段进程用的是同一份表）",
      JSON.stringify(afterPrune && afterPrune.data && afterPrune.data.total),
    );

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 掉落流水（读接口与保留闸）：${passed} 条通过 / ${failed} 条失败`);
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
    await stopServer(server);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
