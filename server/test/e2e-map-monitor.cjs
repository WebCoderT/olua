#!/usr/bin/env node
/**
 * 服务端 e2e：实时地图监控（#665）
 *
 * ## 这一套在测什么
 *
 * 「管理端能看到这张图现在什么样、刚才发生了什么」这件事，靠的是一条**跨进程的投影链**：
 *
 * ```
 * 世界内存（实时进程） → MapMonitorService 每秒采样 → map_monitor_state / map_monitor_events
 *                                                        ↓（共享 SQLite，唯一的一条路）
 *                                        存档进程 GET /admin/maps/:id/monitor → 管理端弹窗
 * ```
 *
 * 链上任一环断了，页面上都表现为「一片安静」—— 没有怪、没有玩家、没有事件，看起来跟
 * 「这张图本来就没人」完全一样。所以这一套**不用假数据打桩**：真起服务、真连 WS、真打死怪，
 * 只有这样才能证明「那几行字确实是世界进程看见的东西」。
 *
 * ## 八条主线
 *
 * 1. **没人看的图没有快照**：`sampledAt = null`、三个数组空 —— 而不是报错或编一帧空世界出来。
 *    页面据此显示「还没有世界快照」，这跟「图里没怪」是两句不同的话；
 * 2. **有人看就每秒采一帧**：怪物点位 / 血量 / 存活、玩家在哪、`updatedAt` 会走；
 * 2.5 **精细日志（#745）**：每次结算一行 `damage`（谁用什么打了多少、怪还剩多少）、
 *     怪物开始 / 结束追击各一行 `chase`（带目标、成因、那一刻的距离）、怪物普攻命中一行 `hit`；
 * 3. **击杀入流**：打死怪之后文字流里出现 `kill`，带击杀者、死亡点、掉落（含落点）、下次刷新时刻；
 * 4. **死怪留在倒下处**：快照里那只怪 `alive=false` 并且**位置不再跳动**（不是回出生点）；
 * 5. **重生入流**：`respawn` 事件与击杀同一个实例，且快照回满血、`respawnInMs` 回到 null；
 * 6. **游标**：`since` 增量、空页原样回传、按 id 升序（页面靠它不重画整页事件）；
 * 7. **裁剪**：事件不会无限长（保留条数来自环境变量，本套调到 3 以便快速看见）；
 * 8. **采集会停**：最后一个观看者离开后不再采样，`staleMs` 持续增长 —— 这就是页面上
 *    「采集已停 / 最后采样 N 秒前」的来源。**陈旧必须可观测**，否则停更会被读成「图里什么都没有」。
 * 8.5 **时间闸（#887）**：往一张「再没人进的图」里塞 8 天前的行，时间闸自己把它的删掉；
 *    3 天前的行一动不动。这一条与「有没有人在写」无关，是条数闸（只在写入时跑）管不到的那半。
 *
 * 另外钉住权限（无令牌 401、观察员可读）与文档契约（operationId / 权限点 / DTO 字段）。
 *
 * ## 与其他 e2e 的关键差别
 *
 * - 用**临时文件库**（不是 `:memory:`）：采集器与读接口在两个进程里，裁剪那条还要直接
 *   数一下库里的行，内存库看不到；
 * - `MAP_MONITOR_MS` 调到 150ms、`WORLD_RESPAWN_MS` 调到 1.2s：不然一整套要跑几分钟。
 *
 * 用法：npm run test:e2e:map-monitor（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "monitor-code";
const KEEP = 3;
/**
 * 时间闸（#887）的保留期与扫描间隔
 *
 * 保留期用**默认的 7 天**（不为了测试改口径），靠「把行的时间戳造到 8 天前」来触发；
 * 扫描间隔调到 200ms，一条断言不用等 6 小时。
 */
const RETENTION_DAYS = 7;
const PRUNE_MS = 200;

//#region 断言小工具（与 e2e-world 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function group(label) {
  console.log(`\n▶ ${label}`);
}

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
  return ok;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
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
    await sleep(100);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 把地图 1 的刷怪区换成「一只怪」的一套
 *
 * **必须在服务端就绪之后调用**：空库首启会用 `config-sync.sql` 整表灌一遍配置，
 * 启动前写进来的行会被整表替换掉（#655 的代价，`e2e-world` 踩过同一个坑）。
 * 只留一只怪，才能让「这一只死了 / 这一只刷了」是可数的。
 */
function seedSpawnAreas(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("DELETE FROM map_spawn_areas WHERE map_id = '1'");
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("1", "监控区", "1", 0, 1, 1000, -2000, 400, 400, Date.now());
  db.close();
}

/** 直接数库里的事件行数（裁剪那条要用；采集器只写不读，所以这里必须绕过接口去看库） */
function countEvents(dbPath, mapId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT COUNT(1) AS total FROM map_monitor_events WHERE map_id = ?").get(mapId);
  db.close();
  return Number(row?.total ?? 0);
}

/**
 * 直接往库里塞几行「某张死图的历史事件」（#887 的时间闸要用）
 *
 * 为什么绕过服务写：时间闸要验的是「**没有人再往这张图写东西时**，旧行也会到点消失」——
 * 走接口造数据就等于证明不了这一条。`at` 由调用方给，好造出「8 天前」。
 */
function insertEventsAt(dbPath, zoneId, mapId, count, at) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare("INSERT INTO map_monitor_events (zone_id, map_id, at, kind, payload) VALUES (?, ?, ?, ?, ?)");
  let inserted = 0;
  for (let index = 0; index < count; index += 1) {
    const result = insert.run(zoneId, mapId, at + index, "kill", JSON.stringify({ kind: "kill", at: at + index, label: "历史的" }));
    inserted += Number(result.changes ?? 0);
  }
  db.close();
  // 返回**实际写入行数**而不是事后 COUNT：8 天前那批正好是时间闸的猎物，
  // 扫描间隔 200ms，事后数会和扫描器抢（CI 上偶发读到 0，本地几乎不出现）
  return inserted;
}

/** 某张表上有没有这条索引（时间闸靠它不全表扫，属于「建了没有」的事实检查） */
function hasIndex(dbPath, name) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
  db.close();
  return Boolean(row);
}

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
      JWT_SECRET: "e2e-map-monitor-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      // 采集 / 世界 / 重生三档节拍都调小：一整套要在半分钟内跑完
      MAP_MONITOR_MS: "150",
      MAP_MONITOR_EVENT_KEEP: String(KEEP),
      MAP_MONITOR_TRIM_EVERY: "1",
      MAP_MONITOR_RETENTION_DAYS: String(RETENTION_DAYS),
      MAP_MONITOR_PRUNE_MS: String(PRUNE_MS),
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "1200",
      WORLD_MAP_IDLE_MS: "0",
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
      if (response.ok) return { baseUrl, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
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

/** 注册并登录一个管理员（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "/api/admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return retry.body?.data?.token;
}

/** 一条会话化的 WS 连接（只要 worldJoin / cast / pos 三样，够这套用） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    castSeq: 0,
    /** 发一次 cast 并等它的 settle 应答 */
    async cast(body, timeoutMs = 5_000) {
      // 出手前等一个间隔（#813 冷却闸：服务端按真客户端口径判 250ms/刀）
      await paceCast();
      session.castSeq += 1;
      const castId = session.castSeq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return waitFor(`castId=${castId} 的 settle`, async () => {
        const hits = session.settles.filter((frame) => frame.castId === castId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 上报一次位置（在场表只由 pos 帧建立，不 join 也不会有「玩家在图上」） */
    reportPos(mapId, x, y, hp = 100) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp } }));
    },
    /** 只等 join 之后到达的 world 帧 */
    async joinWorld(mapId, timeoutMs = 8_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
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
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

//#region 主流程

async function main() {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-monitor-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const base = server.baseUrl;
    seedSpawnAreas(dbPath);

    const rootToken = await registerAdmin(base, "monitorroot", "MonRoot#1");
    check(Boolean(rootToken), "准备：超管注册并登录成功");

    //#region 一、没人看的图没有快照

    group("一、没人看过的图：没有快照，而不是「一帧空世界」");

    // 2 号图全程没人进去 —— 它必须是「从没被采样过」，而不是「采到了 0 只怪」
    const empty = await api(base, "GET", "/api/admin/maps/2/monitor", { token: rootToken });
    checkEqual(empty.status, 200, "没人看的图也能读监控（不 404、不 500）");
    checkEqual(empty.body?.data?.sampledAt, null, "sampledAt = null（页面据此说「还没有世界快照」）");
    checkEqual(empty.body?.data?.updatedAt, null, "updatedAt = null");
    checkEqual(empty.body?.data?.staleMs, null, "staleMs = null（不是 0：没有快照就谈不上新鲜度）");
    checkEqual((empty.body?.data?.monsters ?? []).length, 0, "monsters 是空数组");
    checkEqual((empty.body?.data?.players ?? []).length, 0, "players 是空数组");
    checkEqual((empty.body?.data?.events ?? []).length, 0, "events 是空数组");
    checkEqual(empty.body?.data?.cursor, 0, "cursor = 0（没有事件时也不会往前跳）");
    checkEqual(empty.body?.data?.mapId, "2", "回带 mapId（页面据此确认没串图）");
    checkEqual(empty.body?.data?.width, 8192, "尺寸照旧给（没有快照也能画空底图）");

    //#endregion

    //#region 二、有人看就采：怪物点位 / 玩家 / 时间戳

    group("二、有人看就采：怪物点位、玩家位置、时间戳都在走");

    const player = await api(base, "POST", "/api/auth/register", { body: { username: "monitor_player", password: "pass1234" } });
    const playerToken = player.body?.data?.token;
    check(Boolean(playerToken), "准备：玩家账号已注册");
    const role = await api(base, "POST", "/api/roles", {
      token: playerToken,
      body: { name: "看图的角色", occupation: "1", sex: "1" },
    });
    check(role.status === 200 || role.status === 201, "准备：游戏角色已创建", `status=${role.status}`);
    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");

    const ticket = await api(base, "POST", "/api/realtime/ticket", { token: playerToken });
    const session = connect(`${base.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body?.data?.ticket)}`);
    await waitFor("握手成功", async () => (session.opened ? session : null));

    const world = await session.joinWorld("1");
    checkEqual((world?.monsters ?? []).length, 1, "准备：地图 1 播种出 1 只怪（本套的刷怪区只有一行）");
    const target = world.monsters[0];
    session.reportPos("1", 1000, -2000);

    const live = await waitFor(
      "地图 1 出现第一帧快照",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
        return response.body?.data?.sampledAt ? response.body.data : null;
      },
      15_000,
    );
    check(Boolean(live), "有人进图后采集器开始写快照（不 join 就永远没有）");
    checkEqual(live?.zoneId, 1, "默认取最新写过快照的那个区（这里只有 1 区）");
    checkEqual((live?.zones ?? []).join(","), "1", "zones 列出这张图留过快照的区（页面据此显示切换下拉）");
    checkEqual(live?.monsters.length, 1, "快照里就是那 1 只怪（不多不少）");

    const monsterInSnap = live.monsters[0];
    checkEqual(monsterInSnap.instanceId, target.instanceId, "instanceId 与世界帧一致（同一只，不是另发一只）");
    checkEqual(monsterInSnap.monsterKey, "1", "monsterKey 原样带出");
    check(typeof monsterInSnap.label === "string" && monsterInSnap.label.length > 0, "带怪物名（页面上那颗点旁边写的就是它）", monsterInSnap.label);
    check(Number.isFinite(monsterInSnap.x) && Number.isFinite(monsterInSnap.y), "坐标是数字", `${monsterInSnap.x},${monsterInSnap.y}`);
    check(
      Math.abs(monsterInSnap.x - target.x) <= 400 && Math.abs(monsterInSnap.y - target.y) <= 400,
      "坐标在世界坐标系里（AI 巡逻半径内即可，不与出生点较劲）",
      `出生 (${Math.round(target.x)},${Math.round(target.y)}) 当前 (${Math.round(monsterInSnap.x)},${Math.round(monsterInSnap.y)})`,
    );
    checkEqual(monsterInSnap.alive, true, "活着的怪 alive=true");
    checkEqual(monsterInSnap.respawnInMs, null, "活着的怪没有重生倒计时（null，不是 0）");
    check(monsterInSnap.maxHp > 0 && monsterInSnap.hp > 0 && monsterInSnap.hp <= monsterInSnap.maxHp, "血量与上限都是正数且 hp ≤ maxHp", `${monsterInSnap.hp}/${monsterInSnap.maxHp}`);

    const playerInSnap = await waitFor(
      "场上玩家出现在快照里",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
        return (response.body?.data?.players ?? [])[0] ?? null;
      },
      10_000,
    );
    check(Boolean(playerInSnap), "场上玩家也在快照里（左边图上的方块就是它）");
    checkEqual(playerInSnap?.name, "看图的角色", "玩家名取角色名（不是登录账号名）");
    checkEqual(playerInSnap?.x, 1000, "玩家 x = 刚上报的 pos 帧");
    checkEqual(playerInSnap?.y, -2000, "玩家 y = 刚上报的 pos 帧（世界坐标，y 轴向上）");
    check(Number.isFinite(playerInSnap?.maxHp) && playerInSnap.maxHp > 0, "玩家血量上限也带上（画血量条要分母）");

    const staleAtLive = live.staleMs;
    check(typeof staleAtLive === "number" && staleAtLive < 5000, "刚采过的一帧 staleMs 很小（页面显示「实时」）", `staleMs=${staleAtLive}`);

    // 隔几拍再读：快照必须是**在走**的，不是一次性写的
    await sleep(600);
    const later = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
    const laterData = later.body?.data ?? {};
    check((laterData.updatedAt ?? 0) > (live.updatedAt ?? 0), "连着读两次 updatedAt 在前进（采集在跑，不是一次性的）", `${live.updatedAt} → ${laterData.updatedAt}`);

    //#endregion

    //#region 二·五、精细日志：开始追击 / 普攻命中 / 一次伤害的明细（#745）

    group("二·五、精细日志：怪物开始追击谁、打了谁多少、被打掉多少血");

    // 站到怪身上（它是 passive：aggressive=0，只有挨打才会记恨并开始追）
    const nearX = Math.round(target.x);
    const nearY = Math.round(target.y - 20);
    session.reportPos("1", nearX, nearY);
    // 真实客户端 4Hz 上报，这里 800ms 一次：位置超时是 3 秒，停报就会被判「目标离线」
    const keepPos = setInterval(() => session.reportPos("1", nearX, nearY), 800);

    const poke = await session.cast({ skillId: "1000", targetId: target.instanceId, monsterKey: "1" });
    check(poke?.ok === true, "准备：先打它一下（被动怪被打才记恨）", `damage=${poke?.damage}`);

    const damageRow = await waitFor(
      "文字流出现「这一次伤害」",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=3", { token: rootToken });
        return (response.body?.data?.events ?? []).find((event) => event.kind === "damage") ?? null;
      },
      8_000,
    );
    check(Boolean(damageRow), "每次结算都落一行 damage（不是靠快照差分猜出来的）");
    checkEqual(damageRow?.attacker, "看图的角色", "attacker = 出手者角色名");
    checkEqual(damageRow?.skillId, "1000", "带技能 id（普攻也是技能）");
    check(typeof damageRow?.skillLabel === "string" && damageRow.skillLabel.length > 0, "带技能名（页面显示「用 XX 打了多少」）", damageRow?.skillLabel);
    checkEqual(damageRow?.amount, poke?.damage, "amount = 这次结算的伤害（日志与 settle 帧同一个来源）");
    check(
      damageRow?.hpBefore - damageRow?.hpAfter === damageRow?.amount,
      "前血量 - 后血量 = 掉血量（三个数永远自洽）",
      `${damageRow?.hpBefore} → ${damageRow?.hpAfter}（-${damageRow?.amount}）`,
    );
    check(damageRow?.hpAfter >= 0 && damageRow?.maxHp > 0, "带剩余血量与上限（页面画百分比）", `${damageRow?.hpAfter}/${damageRow?.maxHp}`);
    checkEqual(damageRow?.killed, false, "这一下没打死 → killed=false");
    checkEqual(damageRow?.pushDistance, 0, "普攻不击退 → pushDistance=0");
    check(Number.isFinite(damageRow?.x) && Number.isFinite(damageRow?.y), "带这一下发生的位置（世界坐标）", `(${Math.round(damageRow?.x)},${Math.round(damageRow?.y)})`);

    const chaseStart = await waitFor(
      "文字流出现「开始追击」",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=3", { token: rootToken });
        return (response.body?.data?.events ?? []).find((event) => event.kind === "chase" && event.phase === "start") ?? null;
      },
      10_000,
    );
    check(Boolean(chaseStart), "怪物开始追击会入流（chase.start）");
    checkEqual(chaseStart?.target, "看图的角色", "带被追的角色名（页面写「开始追 X」）");
    checkEqual(chaseStart?.reason, "被打之后记恨", "带成因（被动怪：被打之后记恨；主动怪会是「进入检测范围」）");
    check(Number.isInteger(chaseStart?.distance) && chaseStart.distance >= 0, "带那一刻的距离（像素）", `${chaseStart?.distance}px`);
    checkEqual(chaseStart?.phase, "start", "phase=start");

    const hitRow = await waitFor(
      "文字流出现「怪物普攻命中」",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=3", { token: rootToken });
        return (response.body?.data?.events ?? []).find((event) => event.kind === "hit") ?? null;
      },
      25_000,
    );
    check(Boolean(hitRow), "怪物打到玩家会入流（hit）");
    checkEqual(hitRow?.target, "看图的角色", "带被打的角色名");
    check(hitRow?.amount > 0, "带这一下打掉多少血", `-${hitRow?.amount}`);
    check(
      hitRow?.hpBefore - hitRow?.hpAfter === hitRow?.amount && hitRow.hpAfter >= 0,
      "玩家血量前后自洽（页面显示「800 → 755」）",
      `${hitRow?.hpBefore} → ${hitRow?.hpAfter}`,
    );
    check(hitRow?.maxHp > 0, "带玩家血量上限（画百分比要分母）", String(hitRow?.maxHp));

    // 走开 + 停报（3 秒后服务端判「位置上报超时」→ 结束追击，这条必须有，否则日志里全是没头没尾的追击）
    clearInterval(keepPos);
    session.reportPos("1", 1000, -2000);
    const chaseEnd = await waitFor(
      "文字流出现「结束追击」",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=3", { token: rootToken });
        return (response.body?.data?.events ?? []).find((event) => event.kind === "chase" && event.phase === "end") ?? null;
      },
      15_000,
    );
    check(Boolean(chaseEnd), "结束追击会入流（chase.end）");
    checkEqual(chaseEnd?.phase, "end", "phase=end");
    check(typeof chaseEnd?.reason === "string" && chaseEnd.reason.length > 0, "带结束原因（页面直接显示这句话）", chaseEnd?.reason);
    check(Number.isInteger(chaseEnd?.distance) && chaseEnd.distance >= 0, "带结束那一刻的距离", `${chaseEnd?.distance}px`);

    //#endregion

    //#region 三、击杀入流

    group("三、击杀入流：一行字说清「谁打死了什么、掉了什么、几点刷」");

    let killed = false;
    let settle = null;
    for (let index = 0; index < 40; index += 1) {
      settle = await session.cast({ skillId: "1000", targetId: target.instanceId, monsterKey: "1" });
      if (!settle || !settle.ok) break;
      if (settle.killed) {
        killed = true;
        break;
      }
    }
    check(killed, "连打直到服务端判死（killed 恰好出现一次）", settle && `damage=${settle.damage}`);

    const killEvent = await waitFor(
      "文字流出现这次击杀",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
        const events = response.body?.data?.events ?? [];
        return events.find((event) => event.kind === "kill" && event.instanceId === target.instanceId) ?? null;
      },
      10_000,
    );
    check(Boolean(killEvent), "击杀事件落进文字流（管理端能看到「刚才谁打死了什么」）");
    checkEqual(killEvent?.kind, "kill", "kind = kill");
    checkEqual(killEvent?.monsterKey, "1", "带怪物 key");
    checkEqual(killEvent?.label, monsterInSnap.label, "怪名与快照里同一个来处");
    checkEqual(killEvent?.killer, "看图的角色", "击杀者取角色名（页面上「被 X 打死」的那个 X）");
    check(typeof killEvent?.at === "number" && killEvent.at > 0, "带事件时刻（页面显示几点几分）", String(killEvent?.at));
    check(Number.isFinite(killEvent?.x) && Number.isFinite(killEvent?.y), "带死亡点坐标（页面上「怪物位置」）", `(${Math.round(killEvent?.x)},${Math.round(killEvent?.y)})`);
    check(
      Math.abs(killEvent.x - 1000) <= 400 && Math.abs(killEvent.y - -2000) <= 400,
      "死亡点落在刷怪区附近（同一套世界坐标，不是客户端屏幕坐标）",
    );
    check(killEvent?.respawnAt > killEvent?.at, "带下次刷新时刻（页面显示「下次刷新 HH:MM:SS」）", `${killEvent?.respawnAt - killEvent?.at}ms 后`);
    check(Array.isArray(killEvent?.drops), "drops 是数组（没掉东西就是空数组，不是缺字段）", `共 ${killEvent?.drops?.length ?? 0} 条`);
    if ((killEvent?.drops ?? []).length > 0) {
      const drop = killEvent.drops[0];
      check(typeof drop.goodId === "string" && drop.goodId.length > 0, "掉落条目有物品 id", drop.goodId);
      check(typeof drop.label === "string", "掉落条目有物品名（取不到是空串，由页面回落 id）", drop.label);
      check(Number.isInteger(drop.count) && drop.count > 0, "掉落条目有数量", String(drop.count));
      checkEqual(drop.x, killEvent.x, "掉落落点 x = 击杀点（客户端以死亡坐标为中心铺开）");
      checkEqual(drop.y, killEvent.y, "掉落落点 y = 击杀点");
    }

    //#endregion

    //#region 四、死怪留在倒下处

    group("四、死怪留在倒下处：alive=false，位置不再跳动");

    const corpse = await waitFor(
      "快照里那只怪变成尸体",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
        const row = (response.body?.data?.monsters ?? []).find((item) => item.instanceId === target.instanceId);
        return row && row.alive === false ? row : null;
      },
      8_000,
    );
    check(Boolean(corpse), "快照里 alive=false（图上那颗空心虚线圆）");
    checkEqual(corpse?.hp, 0, "血量归零");
    check(typeof corpse?.respawnInMs === "number" && corpse.respawnInMs >= 0, "带重生倒计时（图上圆心里那个秒数）", `${corpse?.respawnInMs}ms`);
    check(typeof corpse?.respawnAt === "number" && corpse.respawnAt > 0, "带绝对重生时刻");
    check(
      Math.abs(corpse.x - 1000) <= 400 && Math.abs(corpse.y - -2000) <= 400,
      "尸体位置仍在刷怪区附近（不是被清成 0,0）",
      `(${Math.round(corpse?.x)},${Math.round(corpse?.y)})`,
    );

    await sleep(400);
    const stillCorpse = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
    const corpseAgain = (stillCorpse.body?.data?.monsters ?? []).find((item) => item.instanceId === target.instanceId);
    check(
      Boolean(corpseAgain) && corpseAgain.x === corpse.x && corpseAgain.y === corpse.y,
      "连着两帧死怪坐标一致 —— 死亡点被记住，不会退回出生点（AI 运行时已经销毁，坐标只在这里留着）",
      `(${Math.round(corpseAgain?.x)},${Math.round(corpseAgain?.y)}) → (${Math.round(corpse.x)},${Math.round(corpse.y)})`,
    );

    //#endregion

    //#region 五、重生入流

    group("五、重生入流：respawn 与击杀同一个实例，快照回满血");

    const respawnEvent = await waitFor(
      "文字流出现这次刷新",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
        const events = response.body?.data?.events ?? [];
        return events.find((event) => event.kind === "respawn" && event.instanceId === target.instanceId) ?? null;
      },
      20_000,
    );
    check(Boolean(respawnEvent), "重生事件落进文字流（「怪刷新了」不靠快照前后对比去猜）");
    checkEqual(respawnEvent?.kind, "respawn", "kind = respawn");
    checkEqual(respawnEvent?.killer, "", "刷新事件没有击杀者（空串，不是缺字段）");
    checkEqual((respawnEvent?.drops ?? ["x"]).length, 0, "刷新事件没有掉落");
    checkEqual(respawnEvent?.respawnAt, 0, "刷新事件的下次刷新时刻是 0（它刚刷过）");
    check(Number.isFinite(respawnEvent?.x) && Number.isFinite(respawnEvent?.y), "带刷新点坐标");

    const revived = await waitFor(
      "快照里的怪回到满血",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
        const row = (response.body?.data?.monsters ?? []).find((item) => item.instanceId === target.instanceId);
        return row && row.alive === true ? row : null;
      },
      8_000,
    );
    check(Boolean(revived), "快照里 alive 回到 true");
    checkEqual(revived?.hp, revived?.maxHp, "重生满血");
    checkEqual(revived?.respawnInMs, null, "倒计时清空（页面不再画秒数）");

    //#endregion

    //#region 六、游标

    group("六、游标：since 只拿新的，空页原样回传");

    const all = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
    const allEvents = all.body?.data?.events ?? [];
    check(allEvents.length >= 2, "since=0 拿到最近的事件（打开页面就能看到刚才发生了什么）", `${allEvents.length} 条`);
    check(
      allEvents.every((event, index) => index === 0 || event.id > allEvents[index - 1].id),
      "按 id 升序（文字流从上到下就是时间顺序）",
    );
    const lastId = allEvents.length > 0 ? allEvents[allEvents.length - 1].id : 0;
    checkEqual(all.body?.data?.cursor, lastId, "cursor = 本次最大事件 id（下一轮带上它）");

    const emptyPage = await api(base, "GET", `/api/admin/maps/1/monitor?since=${lastId}`, { token: rootToken });
    checkEqual((emptyPage.body?.data?.events ?? ["x"]).length, 0, "since=最新 id → 没有新事件");
    checkEqual(emptyPage.body?.data?.cursor, lastId, "空页的 cursor 原样回传 since（不往前跳，否则会漏事件）");
    check(emptyPage.body?.data?.sampledAt !== null, "空页仍然给完整快照（点位每秒都在变，跟事件无关）");

    const futurePage = await api(base, "GET", "/api/admin/maps/1/monitor?since=999999", { token: rootToken });
    checkEqual((futurePage.body?.data?.events ?? ["x"]).length, 0, "since 远大于现有 id → 空页（不报错）");
    checkEqual(futurePage.body?.data?.cursor, 999999, "游标原样回传");

    const onePage = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=1", { token: rootToken });
    checkEqual((onePage.body?.data?.events ?? []).length, 1, "limit=1 只取最新一条（页面按需分页）");
    checkEqual(onePage.body?.data?.events?.[0]?.id, lastId, "取的是**最新**那条，不是最早那条（打开页面先看最近的事）");

    //#endregion

    //#region 七、裁剪

    group("七、裁剪：事件不会无限长（保留条数来自环境变量）");

    // 再来一轮击杀 + 重生：事件总数会超过 KEEP，裁剪就该生效
    const target2 = (await session.joinWorld("1")).monsters.find((item) => item.instanceId === target.instanceId);
    check(Boolean(target2) && target2.alive === true, "准备：那只怪已经刷新，可以再打一轮");
    let killedAgain = false;
    for (let index = 0; index < 40; index += 1) {
      const shot = await session.cast({ skillId: "1000", targetId: target.instanceId, monsterKey: "1" });
      if (!shot || !shot.ok) break;
      if (shot.killed) {
        killedAgain = true;
        break;
      }
    }
    check(killedAgain, "第二轮击杀成功（制造第 3、4 条事件）");
    const secondKill = await waitFor(
      "第二轮击杀入流",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
        const events = response.body?.data?.events ?? [];
        // 判据是「比第一轮那次更新」，不是「同时存在两条 kill」：保留 3 条时第一轮早被裁掉了
        return events.some((event) => event.kind === "kill" && event.id > killEvent.id) ? events : null;
      },
      10_000,
    );
    check(Boolean(secondKill), "第二轮击杀出现在文字流里");
    const secondKillId = (secondKill ?? []).filter((event) => event.kind === "kill").reduce((max, event) => Math.max(max, event.id), 0);

    // 等第二轮的重生也入流：这时事件已经越过 KEEP=3 → 裁剪必然已经跑过。
    // 判据用「id 在这次击杀之后」而不是「数到两条 respawn」—— #745 起伤害 / 追击也占行，
    // 保留 3 条时第一条 respawn 早被裁掉了，数数量会永远等不到。
    await waitFor(
      "第二轮重生入流（触发裁剪）",
      async () => {
        const response = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
        const events = response.body?.data?.events ?? [];
        return events.some((event) => event.kind === "respawn" && event.id > secondKillId) ? events : null;
      },
      20_000,
    );
    check(countEvents(dbPath, "1") <= KEEP, `库里事件行数不超过 ${KEEP} 条（旧事件被裁掉，不会越攒越大）`, `实际 ${countEvents(dbPath, "1")} 条`);
    const afterTrim = await api(base, "GET", "/api/admin/maps/1/monitor?since=0&limit=60", { token: rootToken });
    const survivors = afterTrim.body?.data?.events ?? [];
    check(
      survivors.length > 0 && survivors.every((event) => event.id > killEvent.id),
      "被裁掉的是最旧的：第一轮的击杀已经查不到了，留下的都是新事件",
      survivors.map((event) => `${event.kind}#${event.id}`).join(" "),
    );

    //#endregion

    //#region 八、采集会停（陈旧可观测）

    group("八、最后一个观看者离开：采集停住，staleMs 一直涨");

    session.socket.close();
    await waitFor("连接已关闭", async () => (session.socket.readyState === 3 ? true : null), 5_000);
    await sleep(1_200);
    const firstIdle = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
    const firstStale = firstIdle.body?.data?.staleMs;
    await sleep(900);
    const secondIdle = await api(base, "GET", "/api/admin/maps/1/monitor", { token: rootToken });
    const secondStale = secondIdle.body?.data?.staleMs;
    check(typeof firstStale === "number" && firstStale > 500, "没人看图之后快照不再更新（staleMs 开始变大）", `staleMs=${firstStale}`);
    check(
      typeof secondStale === "number" && secondStale > firstStale,
      "过一会儿再读 staleMs 更大 —— 页面据「最后采样 N 秒前」把「采集已停」写在脸上",
      `${firstStale} → ${secondStale}`,
    );
    check(secondIdle.body?.data?.sampledAt === firstIdle.body?.data?.sampledAt, "停更期间快照内容不变（不是被清空）");
    check((secondIdle.body?.data?.monsters ?? []).length > 0, "停更也照原样给最后一帧的怪（页面画的是「最后看到的画面」）");

    //#endregion

    //#region 八·五、时间闸（#887）

    group("八·五、时间闸：死图的历史事件到点就走，不靠有人来往里写");

    check(hasIndex(dbPath, "idx_map_monitor_events_at"), "at 上有单列索引（时间闸不必全表扫）");

    const dayMs = 24 * 60 * 60 * 1000;
    // 99 号图 = 一张「从此没人进」的死图：8 天前攒下的 3 条，之后再没有任何人往里写 ——
    // 这正是条数闸管不住的场景（它只在写入时跑）
    const oldRows = insertEventsAt(dbPath, 1, "99", 3, Date.now() - (RETENTION_DAYS + 1) * dayMs);
    // 98 号图 = 还在保留期内（3 天前）的对照：时间闸不该碰它
    const keepRows = insertEventsAt(dbPath, 1, "98", 2, Date.now() - 3 * dayMs);
    check(oldRows === 3, "准备：死图上写入了 3 条 8 天前的记录", `实际写入 ${oldRows}`);
    check(keepRows === 2, "准备：对照图上写入了 2 条 3 天前的记录", `实际写入 ${keepRows}`);

    await waitFor("时间闸扫到并删掉过期行", async () => (countEvents(dbPath, "99") === 0 ? true : null), 5_000);
    check(
      countEvents(dbPath, "99") === 0,
      `超过 ${RETENTION_DAYS} 天的记录被删掉（这张图再没人进、再没人写也一样）`,
      `实际 ${countEvents(dbPath, "99")}`,
    );
    check(countEvents(dbPath, "98") === 2, "保留期内的记录一动不动", `实际 ${countEvents(dbPath, "98")}`);
    check(
      countEvents(dbPath, "1") > 0,
      "图 1 当前的事件还在 —— 时间闸按时间判，不按图判，不误伤新数据",
      `实际 ${countEvents(dbPath, "1")}`,
    );

    //#endregion

    //#region 九、参数校验与权限

    group("九、参数校验与权限：越界要拒，读要登录");

    const badZone = await api(base, "GET", "/api/admin/maps/1/monitor?zone=0", { token: rootToken });
    checkEqual(badZone.status, 400, "zone=0 → 400（区号从 1 起）");
    const badSince = await api(base, "GET", "/api/admin/maps/1/monitor?since=-1", { token: rootToken });
    checkEqual(badSince.status, 400, "since=-1 → 400（游标不能为负）");
    const badLimit = await api(base, "GET", "/api/admin/maps/1/monitor?limit=0", { token: rootToken });
    checkEqual(badLimit.status, 400, "limit=0 → 400");
    const bigLimit = await api(base, "GET", "/api/admin/maps/1/monitor?limit=201", { token: rootToken });
    checkEqual(bigLimit.status, 400, "limit=201 → 400（上限 200，再多该去查运维日志）");
    const badId = await api(base, "GET", "/api/admin/maps/99/monitor", { token: rootToken });
    checkEqual(badId.status, 404, "不存在的地图 → 404（与详情同一个业务码口径）");
    checkEqual(badId.body?.code, 50032, "用地图专属业务码 50032");

    const noToken = await api(base, "GET", "/api/admin/maps/1/monitor");
    checkEqual(noToken.status, 401, "没有令牌读不到监控（图里是谁、掉了什么，不给游客看）");

    const viewerToken = await registerAdmin(base, "monitorviewer", "MonRoot#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token: rootToken })).body?.data?.list?.find(
      (row) => row.username === "monitorviewer",
    )?.id;
    await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: rootToken, body: { role: "viewer" } });
    const viewerRead = await api(base, "GET", "/api/admin/maps/1/monitor", { token: viewerToken, zoneId: ADMIN_ZONE });
    checkEqual(viewerRead.status, 200, "只读观察员能看监控（gameConfig:read 就够 —— 三个角色都有这个点，所以这里没有 403 分支）");

    //#endregion

    //#region 十、文档契约

    group("十、文档契约：一个只读接口，响应形状写清楚");

    const doc = await (await fetch(`${base}/api-docs-json`)).json();
    const path0 = doc.paths?.["/api/admin/maps/{id}/monitor"];
    check(Boolean(path0?.get), "文档里有 GET /admin/maps/{id}/monitor");
    checkEqual(path0?.get?.operationId, "adminMap.monitor", "operationId = adminMap.monitor（生成物靠它取名）");
    checkEqual(path0?.get?.["x-olua-permissions"]?.join(","), "gameConfig:read", "权限点 = gameConfig:read（只读，没有写接口）");
    checkEqual(path0?.get?.["x-olua-audience"], "admin", "归管理端受众（客户端拿不到）");
    checkEqual(
      path0?.get?.["x-olua-data-schema"]?.$ref,
      "#/components/schemas/MapMonitorDto",
      "响应类型是 MapMonitorDto",
    );
    check(
      path0?.get && path0.post === undefined && path0.patch === undefined && path0.put === undefined,
      "只有 get：监控是「看」，没有写入口（它读的是投影表，不是配置）",
    );
    const queryNames = (path0?.get?.parameters ?? [])
      .filter((item) => item.in === "query")
      .map((item) => item.name)
      .sort()
      .join(",");
    checkEqual(
      queryNames,
      "limit,since,slot,zone",
      "四个查询参数都在文档里（zone / slot / since / limit；id 是路径段）—— slot 是 #809 加的分线维度",
    );

    const schemas = doc.components?.schemas ?? {};
    const monitorSchema = schemas.MapMonitorDto?.properties ?? {};
    check(
      ["mapId", "mapLabel", "width", "height", "zoneId", "zones", "slot", "slots", "sampledAt", "updatedAt", "staleMs", "monsters", "players", "events", "cursor"].every(
        (key) => Boolean(monitorSchema[key]),
      ),
      "MapMonitorDto 的 15 个字段齐全（页面按它画，缺一个就是 undefined）",
    );
    checkEqual(
      monitorSchema.monsters?.items?.$ref,
      "#/components/schemas/MapMonitorMonsterDto",
      "monsters 指向 MapMonitorMonsterDto",
    );
    checkEqual(
      monitorSchema.events?.items?.$ref,
      "#/components/schemas/MapMonitorEventDto",
      "events 指向 MapMonitorEventDto",
    );
    checkEqual(
      schemas.MapMonitorEventDto?.properties?.drops?.items?.$ref,
      "#/components/schemas/MapMonitorDropDto",
      "事件的 drops 指向 MapMonitorDropDto（落点坐标也在这个形状里）",
    );
    const eventFields = schemas.MapMonitorEventDto?.properties ?? {};
    check(
      ["attacker", "skillId", "skillLabel", "amount", "hpBefore", "hpAfter", "maxHp", "killed", "pushDistance", "target", "targetAccountId", "phase", "reason", "distance"].every(
        (key) => Boolean(eventFields[key]),
      ),
      "精细日志的 14 个字段都在文档里（伤害 / 追击 / 技能 / 命中四类事件共用同一个形状）",
    );
    check(
      (eventFields.kind?.description ?? "").includes("chase") && (eventFields.kind?.description ?? "").includes("damage"),
      "kind 的描述列出了全部六种事件（生成物里前端能直接看到）",
      eventFields.kind?.description,
    );

    //#endregion
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
}

//#endregion

main()
  .then(() => {
    if (failed) {
      console.log(`\n❌ 服务端 e2e（实时地图监控）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（实时地图监控）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
