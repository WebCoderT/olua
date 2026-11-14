#!/usr/bin/env node
/**
 * AOI 视野裁剪专项 e2e（server/test/e2e-aoi.cjs，issue #810）
 *
 * ## 这一套在测什么
 *
 * 广播从「整张图的实体发给所有人」改成「按 512px 格子裁剪 3×3 邻域」。断言全部落在
 * **客户端视角收到的东西**上（不读服务端内部），因为这一刀唯一的对外承诺就是它。
 *
 * 五段：
 * 1. **进图全量 + 随后清场**：进图时 world 帧照旧给全量（服务端此刻还不知道你在哪，
 *    裁不了），首个 pos 到达后的下一拍把 3×3 格外的实体 `entityLeave` 掉 ——
 *    结算后场上只剩落在视野内的实体；
 * 2. **换边**：走到图的另一头 → 旧实体 `entityLeave`、新实体 `entityEnter`，两个集合
 *    不重叠（相距 3 格以上）；
 * 3. **玩家互见同样裁剪**：远处的玩家从「进图快照里有」变成「被 leave 掉」，走近了再
 *    `entityEnter`（队友也不豁免 —— 2026-11-14 拍板）；
 * 4. **序列化次数**：3 个玩家分布在 2 个格子里 → 每轮 stringify ≈ 2 次，而收件是 3 人次
 *    （#767 的统计行里读；「一格一次」正是这一刀收益的主体）；
 * 5. **边界抖动**：站在格子边界来回 20 次（总时长 < 离开延迟 1s）→ 同一只怪不出现
 *    「先 leave 后 enter」的交替（没有「闪一下」）。
 *
 * ## 断言的边界（2026-11-14 用户拍板）
 * - **代码口径才进断言**：帧的形状 / 两端的字段名 / 进出的方向 / 纯函数几何（格子键、
 *   格心、3×3 邻域）/ 客户端状态机的转换；
 * - **数据不进断言**：怪有多少只、掉多少血、位移多少像素、事件发生几次 —— 这些随怪表与
 *   配置变化，写死就会变成「改表就红」的假失败（本套曾写 `< 50 只`、`leave ≤ 2 次`，已删）；
 * - 「全部落在 9 格内」按 **5×5 容差**判：离开延迟 1 秒里刚出视野的怪还会留在客户端场上，
 *   e2e 抓拍的瞬间它可能已经飘出 1 格 —— 这不是 bug，是延迟合并的定义。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 被测地图：与其余地图类套件一致（1 图，10 级） */
const MAP_ID = "1";
/** 格子边长（与 aoi-math.ts 的 AOI_CELL 同源；只用来算期望值，不锁服务端数值） */
const AOI_CELL = 512;
/** 双方都站在「开阔地」时上报的血量：够高，怪物打不死（死了会触发复活重定位分支，干扰断言） */
const HP = 5000;

//#region 断言小工具（与 e2e-world 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

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
    await sleep(25);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 坐标落在哪一格（与 aoi-math.ts 同口径；只算期望值） */
const cellOf = (x, y) => `${Math.floor(x / AOI_CELL)}:${Math.floor(-y / AOI_CELL)}`;

/** 两个格子之间的切比雪夫距离（3×3 邻域 = 1） */
function cellDistance(left, right) {
  const [leftCol, leftRow] = left.split(":").map(Number);
  const [rightCol, rightRow] = right.split(":").map(Number);
  return Math.max(Math.abs(leftCol - rightCol), Math.abs(leftRow - rightRow));
}

/** 读地图像素尺寸（摆刷怪区与选点位都按它算；读不到按 8192 兜底） */
function mapPixelOf(dbPath, mapId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT pixel_width, pixel_height FROM maps WHERE id = ?").get(mapId);
    if (row && Number(row.pixel_width) > 0) return { width: Number(row.pixel_width), height: Number(row.pixel_height) };
    return { width: 8192, height: 8192 };
  } catch {
    return { width: 8192, height: 8192 };
  } finally {
    db.close();
  }
}

/**
 * 把地图 1 的刷怪区换成两块（远隔两端），合计 145 只。
 *
 * 为什么是两块而不是一块铺满全图：一块 4096² 的区域里 145 只均匀分布，3×3 视野里只有
 * 二十来只 —— 断言「< 50」太容易过了。两块各 60 / 85 只、彼此相隔半张图，才能同时满足
 * 「近处看得见一批」「换边之后是另一批」。
 *
 * **必须在服务端就绪之后调用**：空库首启会用 `config-sync.sql` 把配置表整表灌一遍，
 * 启动前写进来的行会被整表替换掉（与 e2e-world 的 seedSpawnAreas 同一条坑）。
 */
function seedSpawnAreas(dbPath, pixel) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(`CREATE TABLE IF NOT EXISTS map_spawn_areas (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id      TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        monster_key TEXT    NOT NULL,
        min         INTEGER NOT NULL DEFAULT 0,
        max         INTEGER NOT NULL DEFAULT 0,
        cx          REAL    NOT NULL,
        cy          REAL    NOT NULL,
        w           REAL    NOT NULL,
        h           REAL    NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );`);
    db.exec(`DELETE FROM map_spawn_areas WHERE map_id = '${MAP_ID}'`);
    const insert = db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const size = Math.round(pixel.width * 0.3);
    insert.run(MAP_ID, "近端区", "1", 60, 60, Math.round(pixel.width * 0.28), -Math.round(pixel.height * 0.28), size, size, now);
    insert.run(MAP_ID, "远端区", "1", 85, 85, Math.round(pixel.width * 0.72), -Math.round(pixel.height * 0.72), size, size, now);
    db.exec("DELETE FROM world_monsters WHERE map_id = '1'");
  } finally {
    db.close();
  }
}

/** 起一台服务：统计窗口压到 3 秒（第 4 段要读 stringify 计数），重生拉长（别让 world 广播插进来） */
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
      JWT_SECRET: "e2e-aoi-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "1000",
      // 测试里不打死怪，重生窗口只要「大到不打扰」：默认 30s 会在这套跑完前触发 world 广播，
      // 那会把客户端的怪物集合重置一次，与 AOI 的 leave/enter 混在一起
      WORLD_RESPAWN_MS: "600000",
      WORLD_MAP_IDLE_MS: "0",
      // 统计窗口：第 4 段要读 `广播统计[players]` 的 stringify / 收件
      REALTIME_STATS_INTERVAL_MS: "3000",
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
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
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
  return body;
}

const STATS_PREFIX = "广播统计[";

/** 统计行解析（与 e2e-realtime-stats 同一口径；格式见 realtime.service.flushStats） */
function parseStatsLines(logs, kind) {
  return logs
    .split("\n")
    .filter((line) => line.includes(`${STATS_PREFIX}${kind}]`))
    .map((line) => {
      const match = /(\d+) 轮 \/ 帧 (\d+) \/ 收件 (\d+) 人次 \/ stringify (\d+) 次 ([\d.]+)ms \/ ([\d.]+)KB \/ 平均轮间隔 (\d+)ms/.exec(line);
      return match
        ? { rounds: Number(match[1]), frames: Number(match[2]), recipients: Number(match[3]), stringifies: Number(match[4]) }
        : null;
    })
    .filter(Boolean);
}

/**
 * 一条「像客户端那样维护场上状态」的连接
 *
 * 这里刻意**照客户端的口径**应用帧：world 帧重置怪物集合、entityEnter 加、entityLeave 删、
 * monster-ai 只更新已知怪物的坐标与血量。后续 PR（客户端改造）要写的是同一段逻辑 ——
 * 这份状态机就是那一侧行为的可执行规格。
 */
function connect(url, accountId) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    accountId,
    opened: false,
    closed: false,
    /** 客户端场上的怪：instanceId → 最近已知的条目（含实时坐标） */
    monsters: new Map(),
    /** 客户端场上的玩家：accountId → 最新条目 */
    players: new Map(),
    /** 收到的全部进出事件（按到达顺序；第 5 段要数次数） */
    events: [],
    /** 进图快照（players 帧 full = true 的那份，第 1 段断言「先全量、后清场」用） */
    fullSnapshots: [],
    aiFrames: 0,
    sendPos(x, y) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId: MAP_ID, x, y, hp: HP } }));
    },
    /** 进图：发 worldJoin 并等应答（应答与广播同形） */
    async join(mapId = MAP_ID, timeoutMs = 10_000) {
      const worlds = [];
      const onWorld = (raw) => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "world" && frame.data.mapId === mapId) worlds.push(frame.data);
        } catch {
          /* ignore */
        }
      };
      socket.on("message", onWorld);
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      const world = await waitFor(`账号 ${accountId} 的 world 帧`, async () => worlds[0] ?? null, timeoutMs);
      socket.off("message", onWorld);
      return world;
    },
    /**
     * 把位置报过去并等它在服务端的在场表里生效
     *
     * 自己的条目会随 players 帧回来（互见帧里包含自己），所以「生效」是可观测的。
     * #811 的位移闸在 `log` 档照接受（出厂档），这里的大跳是合法的 —— 但闸门读的是
     * 「上一帧被接受的坐标」，重发几次比赌一次更稳（CI 上事件循环慢的时候尤其如此）。
     *
     * 轮询是**静默**的：失败不打印断言，最终由调用方的断言决定成败。
     */
    async moveTo(x, y, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        session.sendPos(x, y);
        const until = Date.now() + 600;
        while (Date.now() < until) {
          const self = session.players.get(accountId);
          if (self && Math.abs(self.x - x) <= 1 && Math.abs(self.y - y) <= 1) return true;
          await sleep(25);
        }
      }
      return false;
    },
  };

  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const data = frame.data;
    if (!data) return;
    if (frame.type === "world") {
      // 客户端口径：world 帧是「这一间房现在有哪些怪」的权威集合
      session.monsters.clear();
      for (const monster of data.monsters) session.monsters.set(monster.instanceId, monster);
      return;
    }
    if (frame.type === "entityEnter") {
      for (const monster of data.monsters) session.monsters.set(monster.instanceId, monster);
      for (const player of data.players) session.players.set(player.a, player);
      session.events.push({ kind: "enter", monsters: data.monsters.map((m) => m.instanceId), players: data.players.map((p) => p.a), at: Date.now() });
      return;
    }
    if (frame.type === "entityLeave") {
      for (const instanceId of data.monsters) session.monsters.delete(instanceId);
      for (const otherId of data.players) session.players.delete(otherId);
      session.events.push({ kind: "leave", monsters: data.monsters, players: data.players, at: Date.now() });
      return;
    }
    if (frame.type === "players") {
      if (data.full) session.fullSnapshots.push(data);
      for (const player of data.players) session.players.set(player.a, player);
      for (const left of data.left) session.players.delete(left);
      return;
    }
    if (frame.type === "monster-ai") {
      session.aiFrames += 1;
      for (const entry of data.monsters) {
        const known = session.monsters.get(entry.i);
        if (!known) continue;
        known.x = entry.x;
        known.y = entry.y;
        known.hp = entry.hp;
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    session.closed = true;
  });
  return session;
}

/** 场上怪物按「离自己几格」分组（客户端视角的视野检查） */
function outlineByCell(monsters, at) {
  const own = cellOf(at.x, at.y);
  let inside = 0;
  let near = 0;
  // 注意 monsters 是 Map：直接 for...of 拿到的是 [key, value]，必须走 values()
  for (const monster of monsters.values()) {
    const distance = cellDistance(own, cellOf(monster.x, monster.y));
    if (distance <= 1) inside += 1;
    if (distance <= 2) near += 1;
  }
  return { own, inside, near, total: monsters.size };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-aoi-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    const pixel = mapPixelOf(dbPath, MAP_ID);
    seedSpawnAreas(dbPath, pixel);
    const nearPoint = { x: Math.round(pixel.width * 0.28), y: -Math.round(pixel.height * 0.28) };
    const farPoint = { x: Math.round(pixel.width * 0.72), y: -Math.round(pixel.height * 0.72) };

    //#region 零、几何口径（纯函数，直接从构建产物读 —— 它是服务端与 e2e 共用的那一份）

    group("零、格子几何（纯函数口径）");
    const aoiMath = require("../dist/modules/realtime/aoi-math.js");
    check(aoiMath.AOI_CELL === 512, "格子边长是拍板的 512（常量，不进运行时参数）", String(aoiMath.AOI_CELL));
    check(aoiMath.cellKeyOf(0, 0) === "0:0", "原点落在 0:0", aoiMath.cellKeyOf(0, 0));
    check(aoiMath.cellKeyOf(511, -511) === "0:0", "格内右上角仍在 0:0（左闭右开）", aoiMath.cellKeyOf(511, -511));
    check(aoiMath.cellKeyOf(512, -512) === "1:1", "跨过半格即 1:1", aoiMath.cellKeyOf(512, -512));
    check(aoiMath.cellKeyOf(-1, 1) === "-1:-1", "y 轴向上：正 y 在图外，行号取 -y（负数格）", aoiMath.cellKeyOf(-1, 1));
    const neighbors = aoiMath.neighborCellKeys("0:0");
    check(neighbors.length === 9 && neighbors.includes("1:1") && neighbors.includes("-1:-1") && neighbors.includes("0:0"), "3×3 邻域是 9 格且含自身", neighbors.join(" "));
    const center = aoiMath.cellCenterOf("0:0");
    check(center.x === 256 && center.y === -256, "格心在格子的几何中心（上限裁剪按它排序）", `${center.x},${center.y}`);

    //#endregion

    //#region 准备：三个账号 / 角色 / 连接

    group("准备：三个账号与实时连接");
    const accounts = [];
    for (const name of ["aoi_player_a", "aoi_player_b", "aoi_player_c"]) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      accounts.push({ token: registered.data && registered.data.token, accountId: registered.data?.account?.id });
    }
    check(accounts.every((one) => one.token && one.accountId), "准备：三个玩家账号已注册（拿到账号 id）");
    for (const [index, one] of accounts.entries()) {
      await api(baseUrl, "POST", "roles", { token: one.token, body: { name: `视野${index + 1}`, occupation: "1", sex: "1" } });
    }
    // #859 起没有位置记录的角色只准进新手村：先把位置写进存档（等价管理端 PATCH onMap）
    placeRolesAt(dbPath, MAP_ID);

    const connectAs = async (one, label) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: one.token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`, one.accountId);
      await waitFor(`${label} 握手成功`, async () => (session.opened ? session : null));
      return session;
    };
    const sessionA = await connectAs(accounts[0], "A");
    const sessionB = await connectAs(accounts[1], "B");
    const sessionC = await connectAs(accounts[2], "C");
    check(sessionA.opened && sessionB.opened && sessionC.opened, "准备：三条实时连接已建立");

    //#endregion

    //#region 一、进图全量 + 随后清场

    group("一、进图给全量，随后把视野外的实体清掉");
    // C 先进图并站到远端：这样 A 进图时拿到的快照里**有** C（证明「先全量」是真的发生过的）
    await sessionC.join(MAP_ID);
    await sessionC.moveTo(farPoint.x, farPoint.y);

    const worldA = await sessionA.join(MAP_ID);
    const worldOutline = worldA ? outlineByCell(new Map(worldA.monsters.map((monster) => [monster.instanceId, monster])), nearPoint) : null;
    // 「全量」的判据是语义而不是只数：进图那一帧里必须存在落在 nearPoint 3×3 之外的怪。
    // 不比对具体条数 —— 只数属配置数据，怪表一改就会红（#810 之后统一口径：数据不进断言）
    check(!!worldOutline && worldOutline.near < worldOutline.total, "进图 world 帧里含视野外的怪（给的是全量，不是裁剪后的）", worldOutline ? `${worldOutline.near}/${worldOutline.total} 落在视野内` : "无 world 帧");
    check(!!worldA && sessionA.monsters.size === worldA.monsters.length, "客户端把 world 帧里的怪物节点全建出来了（节点数 = 帧条目数）", `节点 ${sessionA.monsters.size} / 帧 ${worldA ? worldA.monsters.length : 0}`);

    const fullA = sessionA.fullSnapshots[0];
    check(!!fullA && fullA.players.some((player) => player.a === sessionC.accountId), "进图互见快照里有远处玩家 C（全量，未裁）", fullA ? `${fullA.players.length} 人` : "无快照");

    await sessionB.join(MAP_ID);
    await sessionA.moveTo(nearPoint.x, nearPoint.y);
    await sessionB.moveTo(nearPoint.x, nearPoint.y);

    // 等第一拍 AOI 把域外实体清掉（离开延迟 1s + 两拍余量）
    await waitFor("A 的场上实体被裁到视野内", async () => sessionA.monsters.size < worldA.monsters.length, 5_000);
    await sleep(1_400);

    const outline = outlineByCell(sessionA.monsters, nearPoint);
    // 不锁「场上还剩几只」：只数属配置数据，怪表密度一改就会红。只锁几何 ——
    // 留下来的每一只都必须在视野内（5×5 容差包含离开延迟里刚走出去的那批）
    check(outline.total > 0 && outline.near === outline.total, "场上的怪全部落在视野内（留下的一只都不许在域外）", `视野内 ${outline.near}/${outline.total}`);
    const leftCount = sessionA.events.filter((event) => event.kind === "leave").reduce((sum, event) => sum + event.monsters.length, 0);
    check(leftCount > 0, "域外实体确实走了 entityLeave（不是从来没发过）", `leave ${leftCount} 只`);
    check(!sessionA.players.has(sessionC.accountId), "远处的玩家 C 也从 A 的场上被清掉了（玩家互见同样裁）");
    check(outline.total > 0, "视野内的怪确实还在（不是把所有实体都裁掉了）", `${outline.total} 只`);

    //#endregion

    //#region 二、换边：旧实体 leave、新实体 enter

    group("二、走到图的另一头：旧实体 leave、新实体 enter");
    const beforeTeleport = new Set(sessionA.monsters.keys());
    const eventsBefore = sessionA.events.length;
    await sessionA.moveTo(farPoint.x, farPoint.y);
    await waitFor("A 换边后收到新的 entityEnter", async () => sessionA.events.slice(eventsBefore).some((event) => event.kind === "enter"), 6_000);
    await sleep(1_400);

    const afterTeleport = new Set(sessionA.monsters.keys());
    const entered = new Set(
      sessionA.events
        .slice(eventsBefore)
        .filter((event) => event.kind === "enter")
        .flatMap((event) => event.monsters),
    );
    const leftIds = new Set(
      sessionA.events
        .slice(eventsBefore)
        .filter((event) => event.kind === "leave")
        .flatMap((event) => event.monsters),
    );
    check(leftIds.size > 0, "旧的一批走了 entityLeave", `leave ${leftIds.size} 只`);
    check(entered.size > 0, "新的一批走了 entityEnter", `enter ${entered.size} 只`);
    let overlap = 0;
    for (const instanceId of afterTeleport) if (beforeTeleport.has(instanceId)) overlap += 1;
    check(overlap === 0, "两批实体完全不重叠（相距 3 格以上，3×3 视野不可能同时覆盖）", `重叠 ${overlap} 只`);
    const farOutline = outlineByCell(sessionA.monsters, farPoint);
    check(farOutline.near === farOutline.total, "换边后场上的怪也都在视野内", `视野内 ${farOutline.near}/${farOutline.total}`);

    //#endregion

    //#region 三、玩家互见：走近 enter、走远 leave

    group("三、玩家互见同样按格裁剪（队友不豁免）");
    await sessionC.moveTo(farPoint.x + 400, farPoint.y);
    await waitFor("A 看到走近的 C（entityEnter）", async () => sessionA.players.has(sessionC.accountId), 6_000);
    check(sessionA.players.has(sessionC.accountId), "C 走进视野后 A 收到 entityEnter（带完整条目）");
    const entryC = sessionA.players.get(sessionC.accountId);
    check(!!entryC && typeof entryC.n === "string" && !!entryC.ap, "enter 里带的是完整条目（名字 / 外观都在，客户端可直接建人）", entryC && `n=${entryC.n}`);

    await sessionC.moveTo(farPoint.x + 2_000, farPoint.y - 2_000);
    const goneC = await waitFor("C 走出视野后 A 收到 entityLeave", async () => !sessionA.players.has(sessionC.accountId), 6_000);
    check(!!goneC && !sessionA.players.has(sessionC.accountId), "C 走远 1 秒后从 A 的场上被 leave 掉");

    //#endregion

    //#region 四、序列化次数：一格一次，而不是一人一次

    group("四、序列化次数 ≈ 受影响的格子数（不是收件人数）");
    // 布局：A、B 同格；C 在相邻的另一格 —— 3 个收件人 / 2 个格
    await sessionB.moveTo(farPoint.x, farPoint.y);
    await sessionC.moveTo(farPoint.x + AOI_CELL, farPoint.y);
    await sleep(600);

    const logsBefore = server.logs().length;
    // 三个人一起动 3 秒（每 100ms 一帧，覆盖多个统计窗口）
    for (let step = 0; step < 30; step += 1) {
      const wobble = step % 2 === 0 ? 20 : -20;
      sessionA.sendPos(farPoint.x + wobble, farPoint.y);
      sessionB.sendPos(farPoint.x + wobble, farPoint.y);
      sessionC.sendPos(farPoint.x + AOI_CELL + wobble, farPoint.y);
      await sleep(100);
    }
    // 等统计窗口把这几轮的累计打出来（窗口 3s）
    await sleep(3_500);

    const stats = parseStatsLines(server.logs().slice(logsBefore), "players");
    const total = stats.reduce(
      (acc, line) => ({ rounds: acc.rounds + line.rounds, recipients: acc.recipients + line.recipients, stringifies: acc.stringifies + line.stringifies }),
      { rounds: 0, recipients: 0, stringifies: 0 },
    );
    // 样本自检（不是业务数值断言）：窗口里得真有 players 轮，否则下面三条会在空数据上「假绿」
    check(total.rounds > 10, "统计窗口里有足够多的 players 轮（断言有样本）", `${total.rounds} 轮`);
    check(total.stringifies < total.recipients, "stringify 次数少于收件人次（同格共用一份序列化）", `stringify ${total.stringifies} 次 / 收件 ${total.recipients} 人次`);
    check(total.stringifies <= total.rounds * 2, "stringify 次数不超过「轮数 × 2 格」（一格一次）", `${total.stringifies} 次 / ${total.rounds} 轮`);
    check(total.stringifies >= total.rounds, "每轮至少序列化一次（该发的帧没被漏掉）", `${total.stringifies} 次 / ${total.rounds} 轮`);

    //#endregion

    //#region 五、边界抖动：离开延迟合并

    group("五、站在格子边界来回走：不出现 leave→enter 的闪烁");
    // 边界取 A 所在格的左边界；两侧各 5px，来回 20 次（40ms 一次）—— 总时长 800ms < 1s 离开延迟，
    // 所以「看不见了」的那一下不该真的变成 leave
    const boundary = Math.floor(farPoint.x / AOI_CELL) * AOI_CELL;
    await sessionA.moveTo(boundary + 5, farPoint.y);
    await sleep(1_200); // 让之前攒下的 leave 都发完，窗口里只剩这次抖动
    const jitterStart = sessionA.events.length;
    for (let step = 0; step < 20; step += 1) {
      sessionA.sendPos(step % 2 === 0 ? boundary - 5 : boundary + 5, farPoint.y);
      await sleep(40);
    }
    await sleep(400);
    const jitterEvents = sessionA.events.slice(jitterStart);
    const seenIds = new Set(jitterEvents.flatMap((event) => event.monsters));
    // 「不闪」的语义是**没有交替**：同一只怪在窗口里不该出现「先 leave 后 enter」——
    // 边界抖动被 1 秒离开延迟合并住了。不数 enter/leave 各几次：次数属事件数据，
    // 窗口长度或抖动节奏一改就要跟着调阈值（这轮就是这么踩红的）
    let flickers = 0;
    for (const instanceId of seenIds) {
      const kinds = jitterEvents.filter((event) => event.monsters.includes(instanceId)).map((event) => event.kind);
      for (let i = 1; i < kinds.length; i += 1) if (kinds[i - 1] === "leave" && kinds[i] === "enter") flickers += 1;
    }
    check(flickers === 0, "抖动期间没有怪出现「先 leave 后 enter」的闪烁（离开延迟把边界抖动合并住了）", `闪烁 ${flickers} 次`);
    const jitterOutline = outlineByCell(sessionA.monsters, { x: boundary, y: farPoint.y });
    // 抖动之后仍然只锁几何：留在场上的全部在视野内 ⇒ 没有退回「全图都发」。
    // 不写「少于 N 只」—— 那是数据阈值，怪表一改就得重调（本轮已按新口径删掉）
    check(jitterOutline.total > 0 && jitterOutline.near === jitterOutline.total, "抖动之后场上的怪仍然全部落在视野内（没退回全图）", `视野内 ${jitterOutline.near}/${jitterOutline.total}`);

    //#endregion

    check(sessionA.aiFrames > 0 && sessionB.aiFrames > 0, "怪物 AI 帧照常到达（裁剪没有把出口弄哑）", `A ${sessionA.aiFrames} 帧 / B ${sessionB.aiFrames} 帧`);

    for (const session of [sessionA, sessionB, sessionC]) session.socket.close();
  } finally {
    server.child.kill("SIGTERM");
    await sleep(300);
    try {
      server.child.kill("SIGKILL");
    } catch {
      /* 已经退了 */
    }
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 不存在 */
      }
    }
  }

  console.log(`\n合计：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败清单：");
    for (const label of failures) console.log(`  - ${label}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
