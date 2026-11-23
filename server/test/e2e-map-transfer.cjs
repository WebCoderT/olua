#!/usr/bin/env node
/**
 * e2e：传送代价与空房 tick（#1001 第一刀，docs/20 §2.6 + §2.2 传送三项）
 *
 * ===========================================================================
 * 这一套验什么
 * ===========================================================================
 * `map_rules` 里那四列（`transfer_cost_money` / `transfer_cooldown_ms` /
 * `deny_transfer_in_combat` / `simulate_when_empty`）从「建齐了但没人读」变成行为：
 *
 * - **花费**：余额不够 → `mapEnterResult{ field:"money", need:差额 }`；够了 → 落地时扣，
 *   并且**只有真的换图才扣**（同图重连不该收钱）；
 * - **冷却**：按角色记，未到 → `field:"cooldown"` + 剩余毫秒；到点放行；
 * - **战斗中禁传送**：最近 10 秒出过手 → `field:"in_combat"`；**换线不受影响**；
 * - **空房 tick**：`simulate_when_empty=true` 的图，没人看时也每 5 秒推进一次重生
 *   （落库可见）；默认（false）冻结，等人回来一次性补算。
 *
 * ===========================================================================
 * 断言取向：与配置比，不抄数字
 * ===========================================================================
 * 票价 / 冷却 / 开关都由本套通过管理端写进 `map_rules`（准备段造出来的状态不是被测逻辑），
 * 断言一律拿**读回来的现值**当尺子：`need === rules.transferCostMoney - balance`、
 * `need <= rules.transferCooldownMs`。策划调了出厂值也不会假红。
 *
 * 空房 tick 那组**不数怪**、也不断言「几秒内一定刷出来」：只断言「库里那只怪从死变活」——
 * 这是「世界真的在走」唯一不会与其他周期抢相位的证据。反向（`simulate_when_empty=false`）
 * 一起断：只断正向的话，「谁都在跑」也能过。
 *
 * ===========================================================================
 * 两个容易踩的准备动作
 * ===========================================================================
 * 1. **摆位到起点图，不要摆到目标图**：代价判据是「`mapAt` != 目标图」。把人摆到目标图
 *    等于让他「本来就在那儿」，换算图就成了重连 —— 一次钱都不会扣，整组断言都会绿。
 * 2. 票据一次性（#770）：断线重连必须重新取票，见 `freshTicket()`。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { paceCast, sleep } = require("./lib/cast-pace.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-map-transfer-admin";

/** 空房 tick 的间隔（与 `WorldService` 的 `EMPTY_ROOM_TICK_MS` 同值；这边只用于「等多久」） */
const EMPTY_TICK_WAIT_MS = 7_000;

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

/**
 * 给起点图铺一块怪物 1 的区（#1177 全清后出厂快照不再带环带；配合准备段把起点图改成野外）。
 * **必须在服务端就绪之后调用**（空库首启会用 config-sync.sql 整份替换配置表）。
 */
function seedBattlefield(dbPath, mapId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(mapId, "传送战场", "1", 2, 3, 1000, -800, 500, 500, Date.now());
  db.close();
}

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-map-transfer-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "300",
      // 房间**不回收**：空房 tick 那组全靠「房间还在内存里、但没人看」，一回收就测不到
      WORLD_MAP_IDLE_MS: "0",
      // 重生压到 3 秒：怪死后到空房 tick 检查之间必须「本来该活了」，否则看不出推进。
      // 也不能压太小 —— 小于断开连接的耗时就会在有人看的时候就自己活了
      WORLD_RESPAWN_MS: "3000",
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

/** 直读库（准备与观察用；`alive` 那组只能从库里看，帧里看不出来「空房期间是否推进过」） */
function readRows(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 一条会话化的连接：攒这一套要看的五类帧 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    players: [],
    mapEnterResults: [],
    changeChannelResults: [],
    settles: [],
    errors: [],
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
    /** 发一次 worldJoin，等「world 帧**或** mapEnterResult」先到哪一个（被拒时没有 world 帧） */
    async joinWorldExpectResult(mapId, timeoutMs = 8_000) {
      const worldsBefore = session.worlds.length;
      const rejectsBefore = session.mapEnterResults.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 worldJoin 结果`,
        async () => {
          const worlds = session.worlds.slice(worldsBefore).filter((frame) => frame.mapId === mapId);
          if (worlds.length > 0) return { ok: true, world: worlds[worlds.length - 1] };
          const rejects = session.mapEnterResults.slice(rejectsBefore).filter((frame) => frame.mapId === mapId);
          if (rejects.length > 0) return { ok: false, reject: rejects[rejects.length - 1] };
          return null;
        },
        timeoutMs,
      );
    },
    reportPos(mapId, x, y) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp: 100, moving: false } }));
    },
    async mapEnter(mapId, timeoutMs = 8_000) {
      const before = session.mapEnterResults.length;
      socket.send(JSON.stringify({ type: "mapEnter", data: { mapId } }));
      return waitFor(
        `mapEnter(${mapId}) 的结果`,
        async () => (session.mapEnterResults.length > before ? session.mapEnterResults[session.mapEnterResults.length - 1] : null),
        timeoutMs,
      );
    },
    async changeChannel(channel, timeoutMs = 8_000) {
      const before = session.changeChannelResults.length;
      socket.send(JSON.stringify({ type: "changeChannel", data: { channel } }));
      return waitFor(
        `changeChannel(${channel}) 的结果`,
        async () =>
          session.changeChannelResults.length > before ? session.changeChannelResults[session.changeChannelResults.length - 1] : null,
        timeoutMs,
      );
    },
    /**
     * 打一发（按真实攻速出手；服务端的冷却闸按客户端同一口径判，连发会被拒）
     *
     * 被拒的出手**不更新**「最近一次被接受的出手」—— 那正是 `in_combat` 判据的来源，
     * 所以这一套必须打得出去，不能靠连发绕。
     */
    async castOnce(mob) {
      await paceCast();
      const castId = (session.nextCastId = (session.nextCastId || 1) + 1);
      const before = session.settles.length;
      socket.send(
        JSON.stringify({
          type: "cast",
          data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey },
        }),
      );
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.slice(before);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        5_000,
      );
    },
    /** 打一只怪直到它倒下（组四用；组三只需要「出过手」） */
    async killMonster(mob, maxCasts = 160) {
      for (let index = 0; index < maxCasts; index += 1) {
        const settle = await session.castOnce(mob);
        if (!settle || settle.ok !== true) continue;
        if (settle.killed === true || settle.hp <= 0) return settle;
      }
      return null;
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "players") session.players.push(frame.data);
      if (frame.type === "mapEnterResult") session.mapEnterResults.push(frame.data);
      if (frame.type === "changeChannelResult") session.changeChannelResults.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-transfer-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  // 起点图 = START_MAP_ID（权威常量在 try 里才拿到）；先用字面量占位是错的 —— 改成在拿到 home 后再播种不行（房间可能已建），
  // 所以这里读 dist 常量提前拿到同一个值
  const { START_MAP_ID: homeIdEarly } = require(path.join(SERVER_DIR, "dist", "modules", "map", "map.service.js"));
  seedBattlefield(dbPath, homeIdEarly);
  try {
    const { baseUrl } = server;
    // 权威常量直接读 dist（不手抄一份进测试）：新手村 id 改了这边跟着变
    const { START_MAP_ID } = require(path.join(SERVER_DIR, "dist", "modules", "map", "map.service.js"));

    //#region 准备

    group("准备：管理员 / 两张图 / 三个号");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "transfer_admin", password: "Transfer#12345", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "transfer_admin", password: "Transfer#12345" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    const mapList = await api(baseUrl, "GET", "admin/maps", { token: adminToken, zoneId: ADMIN_ZONE });
    const mapIds = ((mapList && mapList.data && mapList.data.list) || []).map((item) => String(item.id));
    // `home` 必须是新手村：新号没有位置记录时只准进它（#859）。起点图 = 摆位目标 = home
    const home = mapIds.includes(START_MAP_ID) ? START_MAP_ID : mapIds[0];
    const away = mapIds.find((id) => id !== home);
    check(!!home && !!away, "准备：拿到两张图（起点 / 目的地）", `${home} / ${away}`);
    if (!home || !away) throw new Error("地图列表不足两张，本套前置不成立");

    // 目的地必须**1 级就能进**：门槛排在代价之前（`enterRejectOf` 先判），
    // 一张 10 级图会让「余额不够」变成「等级不够」，整组断言测的东西就换了。
    // 关门槛是准备动作（不是被测逻辑），顺带证明门槛与代价是两条独立判据。
    const awayConfig = (await api(baseUrl, "GET", `admin/maps/${away}`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    if (Number(awayConfig.level) > 0) {
      await api(baseUrl, "PATCH", `admin/maps/${away}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: {
          label: awayConfig.label,
          type: awayConfig.type,
          level: 0,
        },
      });
    }
    const awayAfter = (await api(baseUrl, "GET", `admin/maps/${away}`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    check(
      Number(awayAfter.level) === 0,
      "准备：目的地三项门槛已清零（1 级号能进）",
      `${awayAfter.level}`,
    );

    // #1177 全清后出厂快照不带怪，而新手村（home）是安全地图——安全地图不播种、长不出怪。
    // 本套的打手段与空房 tick 都要 home 上有怪：把 home 类型改成野外（库是一次性的），
    // 刷怪区由 seedBattlefield 直插库行（见 startServer 之后的调用）
    const homeConfig = (await api(baseUrl, "GET", `admin/maps/${home}`, { token: adminToken, zoneId: ADMIN_ZONE })).data;
    if (homeConfig.type !== "1") {
      const homeWild = await api(baseUrl, "PATCH", `admin/maps/${home}`, {
        token: adminToken, zoneId: ADMIN_ZONE,
        body: { label: homeConfig.label, type: "1", level: homeConfig.level },
      });
      check(homeWild.code === 0, "准备：起点图已改成野外地图（本套要在它上面刷怪）", homeWild.message);
    }

    const rulesOf = async (mapId) => {
      const response = await api(baseUrl, "GET", `admin/maps/${mapId}/rules`, { token: adminToken, zoneId: ADMIN_ZONE });
      return response && response.data;
    };
    /** 读全量再整份提交（与页面同一个口径，15 个字段不许漏） */
    const saveRules = async (mapId, patch) => {
      const current = await rulesOf(mapId);
      const body = {
        expRate: current.expRate,
        dropRate: current.dropRate,
        moneyRate: current.moneyRate,
        allowPk: current.allowPk,
        allowAutoBattle: current.allowAutoBattle,
        allowRecall: current.allowRecall,
        allowDrop: current.allowDrop,
        maxPlayersPerRoom: current.maxPlayersPerRoom,
        maxChannels: current.maxChannels,
        transferCostMoney: current.transferCostMoney,
        transferCooldownMs: current.transferCooldownMs,
        denyTransferInCombat: current.denyTransferInCombat,
        respawnMsOverride: current.respawnMsOverride,
        simulateWhenEmpty: current.simulateWhenEmpty,
        ...patch,
      };
      const response = await api(baseUrl, "PATCH", `admin/maps/${mapId}/rules`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body,
      });
      return response && response.data;
    };

    const bindGoldOf = (roleId) => {
      const rows = readRows(dbPath, "SELECT data FROM roles WHERE id = ?", roleId);
      if (rows.length === 0) return null;
      try {
        return Math.max(0, Math.floor(Number(JSON.parse(rows[0].data).bindGold) || 0));
      } catch {
        return null;
      }
    };
    const grantBindGold = async (roleId, amount) => {
      const response = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { bindGold: amount },
      });
      return response;
    };

    /**
     * 建号 + 取票 + 连线
     *
     * `place` 是**起点图**（不是目标图）：代价判据比较的是「服务端记下的位置」与目标，
     * 摆到目标图就等于「本来就在那儿」，换图会走重连那条分支、一分钱不扣。
     */
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
        // 票据一次性（#770：用过的 nonce 本进程记 30 秒），重连必须重新取一张
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

    const alice = await newPlayer("tr_alice", home);
    const bob = await newPlayer("tr_bob", away);
    for (const player of [alice, bob]) {
      await waitFor(`${player.name} 握手成功`, async () => (player.session.opened ? player.session : null));
    }

    //#endregion

    //#region 一、传送花费

    group("一、传送花费：余额不够给差额，够了落地才扣，同图重连不扣");

    // 票价写在**目的地**：`transfer_*` 三列描述的是「进这张图要付什么」
    const FARE = 120;
    await saveRules(away, { transferCostMoney: FARE, transferCooldownMs: 0, denyTransferInCombat: false });
    const awayCost = await rulesOf(away);
    check(awayCost.transferCostMoney === FARE, "准备：目的地图票价已写入", String(awayCost.transferCostMoney));

    const worldHome = await alice.session.joinWorld(home);
    check(!!worldHome, "A 进了起点图（还没有位置记录 → 只准进新手村，本来就不收费）");
    const goldBefore = bindGoldOf(alice.roleId);
    check(goldBefore === 0, "A 的出厂余额是 0（本套不假设别的值）", String(goldBefore));

    const poorIntent = await alice.session.mapEnter(away);
    check(
      !!poorIntent && poorIntent.ok === false && poorIntent.field === "money",
      "余额不够 → mapEnter 回 field=money",
      JSON.stringify(poorIntent),
    );
    check(
      !!poorIntent && poorIntent.need === awayCost.transferCostMoney - goldBefore,
      "need = 票价 − 余额（客户端显示「还差多少」，不是票价）",
      `${poorIntent && poorIntent.need} vs ${awayCost.transferCostMoney - goldBefore}`,
    );

    // 绕过 mapEnter 直发 worldJoin 也一样拦（权威在落地那一刻）
    const poorJoin = await alice.session.joinWorldExpectResult(away);
    check(
      !!poorJoin && poorJoin.ok === false && poorJoin.reject.field === "money",
      "改包绕过 mapEnter 直发 worldJoin 同样被拦（field=money）",
      JSON.stringify(poorJoin && (poorJoin.reject || poorJoin.world)),
    );

    const fund = goldBefore + awayCost.transferCostMoney + 30;
    await grantBindGold(alice.roleId, fund);
    const goldRich = bindGoldOf(alice.roleId);
    check(goldRich === fund, "准备：给 A 充值到票价之上", `${goldRich} / 票价 ${awayCost.transferCostMoney}`);

    const richIntent = await alice.session.mapEnter(away);
    check(!!richIntent && richIntent.ok === true, "余额够了 → mapEnter 放行", JSON.stringify(richIntent));

    const worldAway = await alice.session.joinWorld(away);
    check(!!worldAway && worldAway.mapId === away, "A 真的进了目的地");
    const goldAfter = bindGoldOf(alice.roleId);
    check(
      goldAfter === goldRich - awayCost.transferCostMoney,
      "落地后按票价扣款（扣的是绑定元宝，走商城同一个扣款口径）",
      `${goldRich} → ${goldAfter}，票价 ${awayCost.transferCostMoney}`,
    );

    // 反向：同图再来一次 = 断线重连 / 登录，不该再收一次钱
    const rejoin = await alice.session.joinWorld(away);
    check(!!rejoin, "同图再 worldJoin 一次（重连路径）");
    await sleep(300);
    check(
      bindGoldOf(alice.roleId) === goldAfter,
      "同图重连不扣钱（代价只对「去别的地方」收）",
      `${goldAfter} → ${bindGoldOf(alice.roleId)}`,
    );

    //#endregion

    //#region 二、传送冷却

    group("二、传送冷却：按角色记，未到给剩余毫秒，到点放行");

    const COOLDOWN = 1_500;
    // 冷却读**目标图**的配置：两个方向都要配，否则「回去」那一程永远不冷却
    await saveRules(away, { transferCostMoney: 0, transferCooldownMs: COOLDOWN, denyTransferInCombat: false });
    await saveRules(home, { transferCostMoney: 0, transferCooldownMs: COOLDOWN, denyTransferInCombat: false });
    const awayCooldown = (await rulesOf(away)).transferCooldownMs;
    check(awayCooldown === COOLDOWN, "准备：两边的冷却已写入", String(awayCooldown));

    const backHome = await alice.session.joinWorld(home);
    check(!!backHome && backHome.mapId === home, "A 换回起点图（真换图 → 记冷却）");

    const cooling = await alice.session.mapEnter(away);
    check(
      !!cooling && cooling.ok === false && cooling.field === "cooldown",
      "刚传送完再走 → field=cooldown",
      JSON.stringify(cooling),
    );
    check(
      !!cooling && cooling.need > 0 && cooling.need <= awayCooldown,
      "need 是**剩余毫秒**（0 < need ≤ 目标图的冷却）",
      `${cooling && cooling.need} vs ${awayCooldown}`,
    );

    await sleep(COOLDOWN + 400);
    const cooled = await alice.session.mapEnter(away);
    check(!!cooled && cooled.ok === true, "冷却过去 → 放行", JSON.stringify(cooled));

    //#endregion

    //#region 三、战斗中禁传送

    group("三、战斗中禁传送：拦住换图，不影响换线");

    await saveRules(away, {
      transferCostMoney: 0,
      transferCooldownMs: 0,
      denyTransferInCombat: true,
      maxChannels: 2,
      maxPlayersPerRoom: 5,
    });
    // #1084 后只有图 0 有怪：打手段改在 home 出手（in_combat 记的是「最近出过手」，跨图生效），
    // 换线用例也跟着搬到 home —— 所以 home 同样开多线
    await saveRules(home, {
      transferCostMoney: 0,
      transferCooldownMs: 0,
      denyTransferInCombat: true,
      maxChannels: 2,
    });
    const combatRules = await rulesOf(away);

    // B 摆位在 away，但打手在 home（唯一有怪的图）：进 home 不收费也不冷却（两条规则都清了 0）
    const worldBob = await bob.session.joinWorld(home);
    check(!!worldBob, "B 进了 home（打手段的舞台，#1084 后唯一有怪的图）");
    bob.session.reportPos(home, 1000, 800);
    await sleep(150);

    // 先确认「没打过手的时候不拦」——否则下面那条 in_combat 分不清是拦对了还是永远拦
    const calmIntent = await bob.session.mapEnter(away);
    check(
      !!calmIntent && calmIntent.ok === true,
      "没出过手 → 战斗中禁传送不生效（判据不是「这张图一开始就拦」）",
      JSON.stringify(calmIntent),
    );

    const mob = worldBob && worldBob.monsters.find((entry) => entry.alive !== false);
    check(!!mob, "B 手边有活着的怪可打", mob && mob.instanceId);
    const shot = mob ? await bob.session.castOnce(mob) : null;
    check(!!shot && shot.ok === true, "B 打出去过一发（被判据接受）", JSON.stringify(shot));

    const combatIntent = await bob.session.mapEnter(away);
    check(
      !!combatIntent && combatIntent.ok === false && combatIntent.field === "in_combat",
      "打过手 → 换图被拒（field=in_combat，与战力门槛的 combat 区分开）",
      JSON.stringify(combatIntent),
    );

    // 换线不受影响：同一张图（home，已开多线）的另一条线，不叫「传送」
    const currentChannel = worldBob && worldBob.channel;
    const swapped = await bob.session.changeChannel(currentChannel === 0 ? 1 : 0);
    check(
      !!swapped && swapped.ok === true,
      "战斗中换线照样成功（`changeChannel` 不走传送代价）",
      JSON.stringify(swapped),
    );
    check(
      combatRules.maxChannels > 1,
      "准备：目的地图是多线图（否则上面那条换线无从谈起）",
      String(combatRules.maxChannels),
    );

    //#endregion

    //#region 四、空房低频 tick

    group("四、空房 tick：simulate_when_empty=true 的空图仍推进重生，false 冻结");

    // 组三把 home 设成了「战斗中禁传送」，而 B 刚打完手（10 秒窗口）—— 不清掉的话
    // 这一组连图都进不去，测的就变成上一组的残留状态了
    await saveRules(home, { transferCostMoney: 0, transferCooldownMs: 0, denyTransferInCombat: false });
    // **所有人都得离开 home**：留在图里的人会让房间永远「有人看」，于是重生由常规 tick
    // 推进 —— 那与空房 tick 是两回事，正向断言会变成假绿、反向断言永远红
    bob.session.socket.close();
    alice.session.socket.close();
    await sleep(800);

    const monsterRowOf = (slot, instanceId) =>
      readRows(
        dbPath,
        "SELECT instance_id, alive, respawn_at FROM world_monsters WHERE zone_id = ? AND map_id = ? AND slot = ? AND instance_id = ?",
        ADMIN_ZONE,
        home,
        slot,
        instanceId,
      )[0] ?? null;

    /** 打死一只怪 → 断开连接（房间变空）→ 返回那只怪的 id 与所在线 */
    async function killThenLeave() {
      const session = await bob.reconnect();
      const world = await session.joinWorld(home);
      if (!world) return null;
      session.reportPos(home, 900, 800);
      await sleep(150);
      const alive = world.monsters.filter((entry) => entry.alive !== false);
      // 挑血量最少的：打死的发数最少，整套跑得快
      const target = [...alive].sort((left, right) => left.maxHp - right.maxHp)[0];
      if (!target) return null;
      const killed = await session.killMonster(target);
      check(!!killed, "把一只怪打到倒下", JSON.stringify(killed && { hp: killed.hp, killed: killed.killed }));
      // 内存里立刻是死的，但库要等 `WORLD_PERSIST_MS` 的节流落盘 —— 轮询等它落下去，
      // 不写死一个 sleep（那是在赌调度）
      const rowAfterKill = await waitFor(
        "库里那一行落成 alive=0",
        async () => {
          const row = monsterRowOf(world.slot, target.instanceId);
          return row && row.alive === 0 ? row : null;
        },
        3_000,
      );
      check(!!rowAfterKill, "库里那一行已经是「死」（alive=0）", JSON.stringify(rowAfterKill));
      session.socket.close();
      // 断开 → 服务端把观看者移走 → 房间空。空房 tick 的第一拍要等这个状态落定
      await sleep(800);
      return { instanceId: target.instanceId, slot: world.slot };
    }

    // —— 正向 ——
    await saveRules(home, { simulateWhenEmpty: true });
    check((await rulesOf(home)).simulateWhenEmpty === true, "准备：起点图已开「无人时继续跑世界」");
    const onTarget = await killThenLeave();
    check(!!onTarget, "正向：打死一只并离开，房间已空");
    await sleep(EMPTY_TICK_WAIT_MS);
    const observedOn = onTarget ? monsterRowOf(onTarget.slot, onTarget.instanceId) : null;
    check(
      !!observedOn && observedOn.alive === 1,
      "空房期间仍推进：库里那只怪已复活（simulate_when_empty=true）",
      JSON.stringify(observedOn),
    );

    // —— 反向 ——
    await saveRules(home, { simulateWhenEmpty: false });
    check((await rulesOf(home)).simulateWhenEmpty === false, "准备：起点图已关「无人时继续跑世界」");
    const offTarget = await killThenLeave();
    check(!!offTarget, "反向：打死一只并离开，房间已空");
    await sleep(EMPTY_TICK_WAIT_MS);
    const observedOff = offTarget ? monsterRowOf(offTarget.slot, offTarget.instanceId) : null;
    check(
      !!observedOff && observedOff.alive === 0,
      "空房冻结：库里那只怪仍是死的（回来时才补算）",
      JSON.stringify(observedOff),
    );

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 传送代价与空房 tick：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-40).join("\n"));
      if (process.env.E2E_DEBUG_LOGS === "1") console.log(server.logs());
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
