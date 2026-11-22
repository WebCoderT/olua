#!/usr/bin/env node
/**
 * e2e：副本（#1001 第二刀，docs/20 §2.8）
 *
 * ===========================================================================
 * 这一套验什么
 * ===========================================================================
 * 副本 = 一个独立的世界（自己的怪、自己的人）+ 一份登记（谁开的、几时收场）。这里验四件事：
 *
 * 1. **开场与隔离**：管理端开一场 → 客户端 `instanceEnter` 进去 → 拿到的 `world` 帧
 *    `slot = i<n>` / `channel = -1` / `roomId = instanceId`，且**怪物集合与公共线不相交**
 *    （副本真的有自己的一份世界，不是借公共线的那份）；
 * 2. **闸门**：名单外 → `forbidden`、人满 → `full`（`need` = 人数上限）、
 *    **已经在里面的人重进放行**（重连不被自己那场的容量锁在门外）；
 * 3. **收场**：管理端 `cleared` → 人被送回**他自己进副本前那张图**、这场的世界与库行一起消失、
 *    再用同一个 id 进 → `closed`；
 * 4. **时限与空房**：限时前广播一次 `instanceClosing`（`inMs` 在 (0, ttl] 内）、到点收场（`expired`）；
 *    人走光后宽限内回来还能进同一场，宽限过完收场（`emptied`）。
 *
 * ===========================================================================
 * 断言取向
 * ===========================================================================
 * - **不数怪、不断言数值**：「副本里有世界」= `monsters.length > 0`；「两边隔离」= 两个
 *   `instanceId` 集合**交集为空**（而不是「各有 12 只」）。
 * - **拿配置/回执当尺子**：`need === 回执里的 maxPlayers`、`inMs <= 请求的 ttl`。
 * - **公共线容量不被副本占用**：副本里有人时，公共线的 `world.capacity` 仍等于
 *   `map_rules.maxPlayersPerRoom`（副本不进容量统计）。
 *
 * ===========================================================================
 * 两个容易踩的准备动作
 * ===========================================================================
 * 1. **宽限期要压到几秒**（`WORLD_INSTANCE_EMPTY_GRACE_MS`）：出厂 30 秒，等不起；
 *    压到 3 秒后「宽限内回来」与「宽限过完收场」才都验得到。
 * 2. 票据一次性（#770）：断开重连必须重新取票，见 `reconnect()`。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { sleep } = require("./lib/cast-pace.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-map-instance-admin";

/** 空房宽限（与 env 同值；这边只用于「等多久」） */
const EMPTY_GRACE_MS = 3_000;
/** 组四的副本时限（够短才验得到超时；提醒窗口 = min(30s, ttl/2) = 3s） */
const SHORT_TTL_MS = 6_000;

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

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-map-instance-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "300",
      // 房间不回收：副本房由副本生命周期销毁，回收那条路会与本套的「世界丢失」判据抢相位
      WORLD_MAP_IDLE_MS: "0",
      // 空房宽限压到 3 秒：出厂 30 秒等不起（见文件头）
      WORLD_INSTANCE_EMPTY_GRACE_MS: String(EMPTY_GRACE_MS),
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
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 直读库（准备与观察用）：副本的收场原因、残留行只能从库里看 */
function readRows(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 一条会话化的连接：攒这一套要看的四类帧 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    instanceResults: [],
    closings: [],
    errors: [],
    /** 最近一帧 world（换图判断用它） */
    lastWorld() {
      return session.worlds.length > 0 ? session.worlds[session.worlds.length - 1] : null;
    },
    /**
     * 进一场副本，等「world 帧（成功）或 instanceEnterResult（被拒）」先到哪一个
     *
     * 与 `worldJoin` 一样：成功不回结果帧，直接给 world（客户端拿它建场景）。
     */
    async enterInstance(instanceId, timeoutMs = 10_000) {
      const worldsBefore = session.worlds.length;
      const resultsBefore = session.instanceResults.length;
      socket.send(JSON.stringify({ type: "instanceEnter", data: { instanceId } }));
      return waitFor(
        `instanceEnter(${instanceId}) 的结果`,
        async () => {
          const reject = session.instanceResults.slice(resultsBefore);
          const worlds = session.worlds.slice(worldsBefore).filter((frame) => frame.roomId === instanceId);
          if (reject.length > 0) return { reject: reject[reject.length - 1] };
          if (worlds.length > 0) return { world: worlds[worlds.length - 1] };
          return null;
        },
        timeoutMs,
      );
    },
    /** 普通进图（公共线用；只等 world 帧） */
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
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "instanceEnterResult") session.instanceResults.push(frame.data);
      if (frame.type === "instanceClosing") session.closings.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-instance-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  try {
    const { baseUrl } = server;
    // 权威常量直接读 dist（不手抄一份进测试）：新手村 id 改了这边跟着变
    const { START_MAP_ID } = require(path.join(SERVER_DIR, "dist", "modules", "map", "map.service.js"));

    //#region 准备

    group("准备：管理员 / 一张有刷怪区的图 / 两个号");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "instance_admin", password: "Instance#12345", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "instance_admin", password: "Instance#12345" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    const mapList = await api(baseUrl, "GET", "admin/maps", { token: adminToken, zoneId: ADMIN_ZONE });
    const maps = (mapList && mapList.data && mapList.data.list) || [];
    const mapIds = maps.map((item) => String(item.id));
    // `home` 必须是新手村：新号没有位置记录时只准进它（#859）——本套的「散场回哪」拿它当坐标
    const home = mapIds.includes(START_MAP_ID) ? START_MAP_ID : mapIds[0];
    // 副本要有世界：挑刷怪区最多的那张图（没刷怪区的图进场只有空世界，隔离断言就失去意义）
    const dungeonMap = [...maps].sort((a, b) => Number(b.spawnAreaCount) - Number(a.spawnAreaCount))[0];
    const dungeon = dungeonMap ? String(dungeonMap.id) : null;
    check(
      !!home && !!dungeon && Number(dungeonMap.spawnAreaCount) > 0,
      "准备：拿到新手村与一张有刷怪区的图",
      `${home} / ${dungeon}（刷怪区 ${dungeonMap && dungeonMap.spawnAreaCount}）`,
    );
    if (!home || !dungeon || Number(dungeonMap.spawnAreaCount) === 0) throw new Error("本套前置不成立（没有带刷怪区的地图）");

    // 进副本要过「进图门槛」（与 worldJoin 同一条判据在 entryOfRoom 之外）——本套不测门槛，
    // 所以把这张图的三项清零（准备动作，不是被测逻辑）
    const dungeonConfig = (await api(baseUrl, "GET", `admin/maps/${dungeon}`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    if (Number(dungeonConfig.level) > 0) {
      await api(baseUrl, "PATCH", `admin/maps/${dungeon}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { label: dungeonConfig.label, type: dungeonConfig.type, level: 0 },
      });
    }
    const rules = (await api(baseUrl, "GET", `admin/maps/${dungeon}/rules`, { token: adminToken, zoneId: ADMIN_ZONE })).data;

    /** 建号 + 取票 + 连线（摆位到起点图 = 他「进副本前」那张图） */
    async function newPlayer(name, originMapId) {
      await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const login = await api(baseUrl, "POST", "auth/login", { body: { username: name, password: "pass1234" } });
      const token = (login.data && login.data.token) || null;
      const created = await api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
      placeRolesAt(dbPath, originMapId, [name]);
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      return {
        token,
        roleId: created.data && created.data.id,
        name,
        originMapId,
        /** 票据一次性（#770）：断开重连必须重新取一张 */
        async freshTicket() {
          const again = await api(baseUrl, "POST", "realtime/ticket", { token });
          return again.data.ticket;
        },
        async reconnect() {
          const fresh = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(await this.freshTicket())}`);
          await waitFor(`${name} 重连握手成功`, async () => (fresh.opened ? fresh : null));
          return fresh;
        },
        session: connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`),
      };
    }

    const alice = await newPlayer("inst_alice", home);
    const bob = await newPlayer("inst_bob", home);
    for (const player of [alice, bob]) {
      await waitFor(`${player.name} 握手成功`, async () => (player.session.opened ? player.session : null));
    }

    /** 开场（管理端）；返回回执 */
    const openInstance = async (body = {}) =>
      (await api(baseUrl, "POST", `admin/maps/${dungeon}/instances`, { token: adminToken, zoneId: ADMIN_ZONE, body })).data;
    /** 这一场还剩多少行怪（收场之后必须是 0） */
    const monsterRowsOf = (slot) =>
      readRows(dbPath, "SELECT COUNT(1) AS total FROM world_monsters WHERE zone_id = ? AND map_id = ? AND slot = ?", ADMIN_ZONE, dungeon, slot)[0].total;
    /** 行状态（收场原因 / 收场时刻只能从库里看） */
    const instanceRowOf = (slot) =>
      readRows(dbPath, "SELECT closed_at, close_reason, started_at FROM map_instances WHERE zone_id = ? AND map_id = ? AND slot = ?", ADMIN_ZONE, dungeon, slot)[0] ?? null;

    //#endregion

    //#region 一、开场与隔离

    group("一、开场 → 进副本：拿到自己那份世界，与公共线不相交");

    const first = await openInstance({ ttlMs: 60_000, maxPlayers: 3 });
    check(!!first, "开场回执拿到了");
    check(typeof first.instanceId === "string" && first.instanceId === `${ADMIN_ZONE}:${dungeon}:${first.slot}`, "instanceId = 房间键（区:图:slot）", first.instanceId);
    check(typeof first.slot === "string" && first.slot.startsWith("i"), "slot 是副本那一档（i<序号>）", first.slot);
    check(first.startedAt === null, "刚开出来的场还没人进过（startedAt 为空）");
    check(first.players === 0, "刚开出来的场在场 0 人", String(first.players));
    check(first.remainMs > 0 && first.remainMs <= 60_000, "剩余时间在 (0, ttl] 内", String(first.remainMs));
    check(Number(first.maxPlayers) === 3, "人数上限按传入值回读", String(first.maxPlayers));

    const entered = await alice.session.enterInstance(first.instanceId);
    check(!!entered && !!entered.world, "A 进副本成功（直接回 world 帧）", JSON.stringify(entered && entered.reject));
    const inside = entered && entered.world;
    check(!!inside && inside.slot === first.slot, "world 帧的 slot 就是这一场", inside && inside.slot);
    check(!!inside && inside.channel === -1, "副本的 channel 是 -1（不混进分线号）", String(inside && inside.channel));
    check(!!inside && inside.mapId === dungeon, "world 帧的 mapId 是底图", inside && inside.mapId);
    check(!!inside && inside.roomId === first.instanceId, "roomId = instanceId（客户端据此认这份快照）", inside && inside.roomId);
    check(!!inside && Array.isArray(inside.monsters) && inside.monsters.length > 0, "副本里有自己的怪（按刷怪区现播种）", String(inside && inside.monsters.length));

    // 公共线对照：B 进同一张图的公共线（副本不该把公共线的人 / 怪卷进来）
    const publicWorld = await bob.session.joinWorld(dungeon);
    check(!!publicWorld && publicWorld.slot === "0", "B 进的是公共线（slot = 0）", publicWorld && publicWorld.slot);
    const insideIds = new Set((inside ? inside.monsters : []).map((monster) => monster.instanceId));
    const publicIds = new Set((publicWorld ? publicWorld.monsters : []).map((monster) => monster.instanceId));
    const overlap = [...insideIds].filter((id) => publicIds.has(id));
    check(publicIds.size > 0, "公共线也有世界（否则「不相交」是空集对空集的假绿）", String(publicIds.size));
    check(overlap.length === 0, "两边的怪物实例集合不相交（副本是独立的一份世界）", overlap.slice(0, 3).join(","));
    check(
      !!publicWorld && Number(publicWorld.capacity) === Number(rules.maxPlayersPerRoom),
      "副本不占公共线容量（capacity 仍等于 map_rules 的单房上限）",
      `${publicWorld && publicWorld.capacity} vs ${rules.maxPlayersPerRoom}`,
    );

    const listed = (await api(baseUrl, "GET", `admin/maps/${dungeon}/instances`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    check(!!listed && listed.open.length === 1, "管理端列表里只有这一场开着", String(listed && listed.open.length));
    const listedRow = listed && listed.open[0];
    check(!!listedRow && listedRow.startedAt !== null, "开场之后 startedAt 已记下（有人真的进过）", String(listedRow && listedRow.startedAt));

    //#endregion

    //#region 二、闸门：名单 / 人数上限 / 重复进

    group("二、闸门：名单外 forbidden、人满 full、已在里面的人重进放行");

    const named = await openInstance({ ttlMs: 60_000, maxPlayers: 2, ownerRoleIds: [alice.roleId] });
    const deniedByOwner = await bob.session.enterInstance(named.instanceId);
    check(
      !!deniedByOwner && !!deniedByOwner.reject && deniedByOwner.reject.field === "forbidden",
      "名单外的人被拒（field=forbidden）",
      JSON.stringify(deniedByOwner && deniedByOwner.reject),
    );
    const namedIn = await alice.session.enterInstance(named.instanceId);
    check(!!namedIn && !!namedIn.world, "名单内的人能进（A 已在第一场，换到这一场）", JSON.stringify(namedIn && namedIn.reject));

    // 回城（A 现在是「从另一场副本跳到这一场」，`mapAt` 停在副本底图上）。
    // 这一步是准备动作：本套要验「散场送回**进副本前那张图**」，所以进本前他得真在城里
    const backHome = await alice.session.joinWorld(home);
    check(!!backHome && backHome.slot === "0", "A 回城（进副本前的图 = 新手村公共线）", backHome && backHome.slot);

    const solo = await openInstance({ ttlMs: 60_000, maxPlayers: 1 });
    const soloIn = await alice.session.enterInstance(solo.instanceId);
    check(!!soloIn && !!soloIn.world, "单人本 A 先进去了", JSON.stringify(soloIn && soloIn.reject));
    const soloFull = await bob.session.enterInstance(solo.instanceId);
    check(
      !!soloFull && !!soloFull.reject && soloFull.reject.field === "full",
      "第二个人被拒（field=full）",
      JSON.stringify(soloFull && soloFull.reject),
    );
    check(
      !!soloFull && soloFull.reject.need === Number(solo.maxPlayers),
      "need = 人数上限（客户端显示「已满 N 人」）",
      `${soloFull && soloFull.reject.need} vs ${solo.maxPlayers}`,
    );
    // 已经在里面的人重进：不该被自己那一场的容量锁在门外（断线重连走的就是这条）
    const again = await alice.session.enterInstance(solo.instanceId);
    check(!!again && !!again.world, "已经在里面的人重进放行（容量不挡自己）", JSON.stringify(again && again.reject));

    //#endregion

    //#region 三、通关收场：送回原图 + 世界一起消失

    group("三、通关收场：人被送回进副本前那张图，残留行清干净");

    const closed = (
      await api(baseUrl, "POST", `admin/maps/${dungeon}/instances/${solo.slot}/close`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { reason: "cleared" },
      })
    ).data;
    check(!!closed && closed.closeReason === "cleared", "收场回执标成 cleared", closed && closed.closeReason);

    // A 应该被送回**他自己**进副本前那张图（home），而不是主城 / 副本底图
    const back = await waitFor(
      "A 被送回原图",
      async () => {
        const frame = alice.session.lastWorld();
        return frame && frame.mapId === home && frame.slot === "0" ? frame : null;
      },
      10_000,
    );
    check(!!back, "A 收到原图的 world 帧（散场完成）", back && `${back.mapId}/${back.slot}`);
    check(!!back && back.roomId === `${ADMIN_ZONE}:${home}:0`, "回的是原图的公共线房间", back && back.roomId);

    const gone = await alice.session.enterInstance(solo.instanceId);
    check(!!gone && !!gone.reject && gone.reject.field === "closed", "收场之后再进 → field=closed", JSON.stringify(gone && gone.reject));
    check(monsterRowsOf(solo.slot) === 0, "这一场的怪物行已从库里删干净（副本不留在库里）", String(monsterRowsOf(solo.slot)));
    check(instanceRowOf(solo.slot).close_reason === "cleared", "库里记着收场原因", instanceRowOf(solo.slot).close_reason);
    const listAfterClose = (await api(baseUrl, "GET", `admin/maps/${dungeon}/instances`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    check(
      !listAfterClose.open.some((item) => item.slot === solo.slot) && listAfterClose.recent.some((item) => item.slot === solo.slot),
      "收场的场从「还开着」挪到「最近收场」",
      `${listAfterClose.open.length} / ${listAfterClose.recent.length}`,
    );

    //#endregion

    //#region 四、时限：先提醒再收场

    group("四、时限：收场前广播一次 instanceClosing，到点按 expired 收场");

    const timed = await openInstance({ ttlMs: SHORT_TTL_MS, maxPlayers: 2 });
    const timedIn = await alice.session.enterInstance(timed.instanceId);
    check(!!timedIn && !!timedIn.world, "A 进了限时场", JSON.stringify(timedIn && timedIn.reject));

    const closing = await waitFor(
      "instanceClosing 帧",
      async () => alice.session.closings.find((frame) => frame.instanceId === timed.instanceId) ?? null,
      SHORT_TTL_MS + 4_000,
    );
    check(!!closing, "收到了收场提醒", closing && `${closing.inMs}ms`);
    check(!!closing && closing.inMs > 0 && closing.inMs <= SHORT_TTL_MS, "inMs 在 (0, ttl] 内", String(closing && closing.inMs));
    check(!!closing && closing.originMapId === home, "提醒里带的是他自己进场前那张图", closing && closing.originMapId);

    const timedBack = await waitFor(
      "限时场到点后 A 回到原图",
      async () => {
        const frame = alice.session.lastWorld();
        return frame && frame.mapId === home && frame.slot === "0" ? frame : null;
      },
      SHORT_TTL_MS + 6_000,
    );
    check(!!timedBack, "到点之后 A 被送回原图", timedBack && `${timedBack.mapId}/${timedBack.slot}`);
    await waitFor("库里记成 expired", async () => (instanceRowOf(timed.slot).close_reason === "expired" ? true : null), 5_000);
    check(instanceRowOf(timed.slot).close_reason === "expired", "收场原因 = expired", instanceRowOf(timed.slot).close_reason);
    check(monsterRowsOf(timed.slot) === 0, "限时场的怪物行也清干净了", String(monsterRowsOf(timed.slot)));

    //#endregion

    //#region 五、空房宽限：走光不立刻销毁，宽限过完才收

    group("五、空房宽限：宽限内回来还是同一场，宽限过完按 emptied 收场");

    const empty = await openInstance({ ttlMs: 120_000, maxPlayers: 2 });
    const emptyIn = await alice.session.enterInstance(empty.instanceId);
    check(!!emptyIn && !!emptyIn.world, "A 进了长时场", JSON.stringify(emptyIn && emptyIn.reject));
    const monstersBefore = (emptyIn.world.monsters || []).length;

    // 走光（断线）——宽限 3 秒，立刻重连回来
    alice.session.socket.close();
    const reconnected = await alice.reconnect();
    alice.session = reconnected;
    const backIn = await alice.session.enterInstance(empty.instanceId);
    check(!!backIn && !!backIn.world, "宽限内回来还能进同一场（不是被关了再开一场）", JSON.stringify(backIn && backIn.reject));
    check(
      !!backIn && (backIn.world.monsters || []).length === monstersBefore,
      "还是同一份世界（怪物数没重播种）",
      `${backIn && (backIn.world.monsters || []).length} vs ${monstersBefore}`,
    );

    // 再走光，这次不回来：等宽限过完
    alice.session.socket.close();
    const emptied = await waitFor(
      "宽限过完收场",
      async () => (instanceRowOf(empty.slot).close_reason === "emptied" ? true : null),
      EMPTY_GRACE_MS + 8_000,
    );
    check(!!emptied, "宽限过完按 emptied 收场", instanceRowOf(empty.slot).close_reason);
    check(monsterRowsOf(empty.slot) === 0, "收场之后这场的怪也清干净了", String(monsterRowsOf(empty.slot)));

    //#endregion

    // ---------------------------------------------------------------------
    console.log(failures.length > 0 ? `\n✗ 副本 e2e 有 ${failed} 条失败：\n  - ${failures.join("\n  - ")}\n` : `\n✅ 副本 e2e 全绿（${passed} 条断言）\n`);
    if (failures.length > 0) {
      console.log("服务端日志尾部：\n" + server.logs().split("\n").slice(-40).join("\n"));
    }
    await stopServer(server);
    process.exit(failures.length > 0 ? 1 : 0);
  } catch (error) {
    console.error("\n✗ 副本 e2e 异常：", error);
    console.log("服务端日志尾部：\n" + server.logs().split("\n").slice(-40).join("\n"));
    await stopServer(server);
    process.exit(1);
  }
})();
