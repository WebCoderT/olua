#!/usr/bin/env node
/**
 * e2e：分线 / 容量闸门 / 换线（#1000，docs/20 §2.5 + §2.6 + §四）
 *
 * ===========================================================================
 * 这一套验什么
 * ===========================================================================
 * 「分线」是同一张图里第 N 份世界（`slot = "0" | "1" | "2" …`）。这一刀只做**服务端**：
 *
 * - `maxChannels = 1`（出厂）：满员就拒，行为与改造前一致；
 * - `maxChannels > 1`：公共线满了**自动开下一条**，而不是把人挡在门外；
 * - `changeChannel`：换线不换图（保留坐标、不动场景），满了 / 线号不存在分别给 `full` / `unknown`；
 * - `worldJoin.preferChannel`：只是偏好，占不到就退而求其次。
 *
 * ===========================================================================
 * 断言取向：与配置比，不抄数字
 * ===========================================================================
 * 容量 / 线数由本套自己通过管理端写进 `map_rules`（准备段造出来的状态不是被测逻辑），
 * 所以断言一律拿**配置现值**当尺子（`world.capacity === rules.maxPlayersPerRoom`），
 * 不写「容量是 2」。策划调了出厂值、或本套换了准备数据，都不会假红。
 *
 * 跨线不可见是**正反两条**一起断的：同线的人必须出现在全量里（正向，证明在场表真的
 * 记得住人），另一条线的人必须不出现（反向）。只断反向的话，「谁都没进在场表」也能过。
 *
 * 「没发生」类断言（幂等换线不重建、保留坐标不挨 posCorrect）只能靠**安静窗口**：
 * 这几条都会留下窗口内的可观测痕迹，而窗口只用来否定，不参与任何数值判断。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { sleep } = require("./lib/cast-pace.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-map-channel-admin";

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
      JWT_SECRET: "e2e-map-channel-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      // 图卸载（房间回收）会把容量缓存一起丢掉 —— 本套全程 1 分钟内跑完，
      // 把空闲回收关掉，免得房间在「换线 → 再进人」之间被回收，容量又按新配置重算
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

/** 一条会话化的连接：把这一套要看的五类帧都攒起来 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    players: [],
    mapEnterResults: [],
    changeChannelResults: [],
    posCorrects: [],
    errors: [],
    async joinWorld(mapId, preferChannel) {
      const before = session.worlds.length;
      socket.send(
        JSON.stringify({
          type: "worldJoin",
          data: preferChannel === undefined ? { mapId } : { mapId, preferChannel },
        }),
      );
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        10_000,
      );
    },
    /**
     * 发一次 `worldJoin`，等「world 帧**或** mapEnterResult」先到哪一个
     *
     * 被容量拒的时候服务端回的是 `mapEnterResult`（与门槛拒绝同一条路），不会有 world 帧 ——
     * 直接等 world 帧会以超时收场，那条路就成了「等不到就判失败」，说不清是被拒还是没响应。
     */
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
    /** 发一帧位置上报（进在场表；互见 / 容量 / 位移校验都以它为前提） */
    reportPos(mapId, x, y) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp: 100, moving: false } }));
    },
    async changeChannel(channel, timeoutMs = 8_000) {
      const before = session.changeChannelResults.length;
      socket.send(JSON.stringify({ type: "changeChannel", data: { channel } }));
      return waitFor(
        `changeChannel(${channel}) 的结果`,
        async () => (session.changeChannelResults.length > before ? session.changeChannelResults[session.changeChannelResults.length - 1] : null),
        timeoutMs,
      );
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
    /** 最近一份「同房玩家全量」（presence 在进图 / 换线时发的那一帧） */
    lastPlayersFull() {
      const hits = session.players.filter((frame) => frame.full === true);
      return hits.length > 0 ? hits[hits.length - 1] : null;
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
      if (frame.type === "posCorrect") session.posCorrects.push(frame.data);
      if (frame.type === "error") session.errors.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-channel-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  try {
    const { baseUrl } = server;
    // 权威常量直接读 dist（不手抄一份进测试）：新手村 id 改了这边跟着变
    const { START_MAP_ID } = require(path.join(SERVER_DIR, "dist", "modules", "map", "map.service.js"));

    //#region 准备

    group("准备：管理员 / 两张图（单线图 + 三线图）/ 五个号");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "channel_admin", password: "Channel#12345", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "channel_admin", password: "Channel#12345" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    const mapList = await api(baseUrl, "GET", "admin/maps", { token: adminToken, zoneId: ADMIN_ZONE });
    const mapIds = (((mapList && mapList.data && mapList.data.list) || [])).map((item) => String(item.id));
    // 单线图必须是**新手村**：容量闸门只挡「要进这张图的人」，而新号还没有位置记录时
    // 只准进新手村（#859）—— 也只有在这种号身上，`returning` 才是 false（见下面的分组说明）
    const singleMap = mapIds.includes(START_MAP_ID) ? START_MAP_ID : mapIds[0];
    const multiMap = mapIds.find((id) => id !== singleMap);
    check(!!singleMap && !!multiMap, "准备：拿到两张图（单线 / 多线）", `${singleMap} / ${multiMap}`);
    if (!singleMap || !multiMap) throw new Error("地图列表不足两张，本套前置不成立");

    /** 读规则（GET 拿全量再整份提交 —— 与页面同一个口径，15 个字段不许漏） */
    const rulesOf = async (mapId) => {
      const response = await api(baseUrl, "GET", `admin/maps/${mapId}/rules`, { token: adminToken, zoneId: ADMIN_ZONE });
      return response && response.data;
    };
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

    // 容量在**房间第一次加载时**读进 `Room`，所以两套规则都要在任何人进图之前写好
    await saveRules(singleMap, { maxPlayersPerRoom: 1, maxChannels: 1 });
    await saveRules(multiMap, { maxPlayersPerRoom: 2, maxChannels: 3 });
    const singleRules = await rulesOf(singleMap);
    const multiRules = await rulesOf(multiMap);
    check(
      singleRules.maxChannels === 1 && multiRules.maxChannels > 1,
      "准备：单线图 maxChannels=1、多线图 maxChannels>1",
      `${singleRules.maxChannels} / ${multiRules.maxChannels}`,
    );

    /**
     * 建号 + 取票 + 连线
     *
     * `place` = 是否把角色摆到目标图（#859 之后，没有位置记录的号只准进新手村）。
     * 容量拒绝那一组**故意不摆**：闸门只挡「要进这张图的人」，而 `mapAt` 已经等于目标图的
     * 人会走「回来的人放行」那条分支（`returning`）—— 摆位就等于把被测判据绕过去了。
     */
    async function newPlayer(name, mapId, place = true) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const token = registered.data && registered.data.token;
      const created = await api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
      if (place) placeRolesAt(dbPath, mapId, [name]);
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      return {
        token,
        roleId: created.data && created.data.id,
        name,
        mapId,
        ticket: ticket.data.ticket,
        // 票据一次性（#770：用过的 nonce 本进程记 30 秒），重连必须重新取一张
        async freshTicket() {
          const again = await api(baseUrl, "POST", "realtime/ticket", { token });
          return again.data.ticket;
        },
        session: connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`),
      };
    }

    const alpha = await newPlayer("ch_alpha", multiMap);
    const beta = await newPlayer("ch_beta", multiMap);
    const gamma = await newPlayer("ch_gamma", multiMap);
    for (const player of [alpha, beta, gamma]) {
      await waitFor(`${player.name} 握手成功`, async () => (player.session.opened ? player.session : null));
    }

    //#endregion

    //#region 一、容量闸门与自动开线

    group("一、容量闸门：公共线满了自动开下一条，而不是拒之门外");

    const worldA = await alpha.session.joinWorld(multiMap);
    check(!!worldA, "A 进了图");
    check(worldA.channel === 0, "A 落在公共线（channel = 0）", String(worldA.channel));
    check(
      worldA.capacity === multiRules.maxPlayersPerRoom,
      "world 帧的 capacity 与 map_rules 一致（不抄数字）",
      `${worldA.capacity} vs ${multiRules.maxPlayersPerRoom}`,
    );
    check(
      typeof worldA.roomId === "string" && worldA.roomId.split(":").length === 3,
      "world 帧的 roomId 是三段键（区:图:线）",
      worldA.roomId,
    );
    // 进在场表：互见与容量都以「在看的人」为准，光 join 不报位置的人是隐形的
    alpha.session.reportPos(multiMap, 1200, 900);
    await sleep(120);

    const worldB = await beta.session.joinWorld(multiMap);
    check(worldB && worldB.channel === worldA.channel, "B 与 A 同线（公共线还没满）", String(worldB && worldB.channel));
    beta.session.reportPos(multiMap, 1240, 900);
    await sleep(120);

    // 正向：同线的人必须出现在全量里 —— 否则下面的「反向」断言谁都能过
    const betaFull = beta.session.lastPlayersFull();
    check(
      !!(betaFull && betaFull.players.some((player) => player.n === alpha.name)),
      "正向：B 的同房全量里有 A（同线可见）",
      JSON.stringify(betaFull && betaFull.players.map((player) => player.n)),
    );

    const worldC = await gamma.session.joinWorld(multiMap);
    check(!!worldC, "C 也进了图（公共线已满 2/2）");
    check(
      worldC.channel !== worldA.channel && worldC.channel > 0,
      "C 被自动放进新开的线（不进公共线、也没被拒）",
      `C=${worldC.channel} / A=${worldA.channel}`,
    );
    check(worldC.roomId !== worldA.roomId, "C 的房号与 A 不同（分线 = 不同的房间）", `${worldC.roomId} vs ${worldA.roomId}`);
    gamma.session.reportPos(multiMap, 1260, 940);
    await sleep(120);

    const gammaFull = gamma.session.lastPlayersFull();
    check(
      !!gammaFull && !gammaFull.players.some((player) => player.n === alpha.name || player.n === beta.name),
      "反向：C 的同房全量里没有 A / B（跨线不可见）",
      JSON.stringify(gammaFull && gammaFull.players.map((player) => player.n)),
    );

    //#endregion

    //#region 二、换线

    group("二、changeChannel：不换图、保留坐标、满线与越界各给各的错误");

    // 幂等：换到「就是我现在这条线」= 空操作，但必须有回帧（客户端靠它停「切换中」）
    const worldsBefore = alpha.session.worlds.length;
    const sameChannel = await alpha.session.changeChannel(worldA.channel);
    check(!!sameChannel && sameChannel.ok === true, "换到当前所在线 → ok（幂等）", JSON.stringify(sameChannel));
    await sleep(400);
    check(
      alpha.session.worlds.length === worldsBefore,
      "幂等换线不重建世界（安静窗口内没有新的 world 帧）",
      `worlds ${worldsBefore} → ${alpha.session.worlds.length}`,
    );

    const outOfRange = await alpha.session.changeChannel(multiRules.maxChannels + 5);
    check(
      !!outOfRange && outOfRange.ok === false && outOfRange.field === "unknown",
      "线号超出 maxChannels → field=unknown（这张图没有这条线）",
      JSON.stringify(outOfRange),
    );
    check(
      !!outOfRange && outOfRange.channel === worldA.channel,
      "失败时回的是**原来那条线**（客户端据此改回选中态）",
      JSON.stringify(outOfRange && outOfRange.channel),
    );

    // 成功换线到 C 所在的那条（1/2，还没满）
    const moved = await alpha.session.changeChannel(worldC.channel);
    check(!!moved && moved.ok === true && moved.channel === worldC.channel, "换到 C 所在线成功", JSON.stringify(moved));
    const worldMoved = await waitFor(
      "换线后的 world 帧",
      async () => {
        const hits = alpha.session.worlds.filter((frame) => frame.channel === worldC.channel);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      },
      8_000,
    );
    check(!!worldMoved, "换线后服务端回了 world 帧（客户端就地重建，不重进场景）");
    check(
      !!worldMoved && worldMoved.roomId !== worldA.roomId && worldMoved.mapId === multiMap,
      "换线换了房间、没换图（mapId 不变）",
      `${worldMoved && worldMoved.roomId} / ${worldMoved && worldMoved.mapId}`,
    );

    // 坐标保留：换线后立刻用**换线前那套坐标**上报，服务端应当照单接受（基线没被重置回出生点）
    const posCorrectsBefore = alpha.session.posCorrects.length;
    alpha.session.reportPos(multiMap, 1200, 900);
    await sleep(500);
    check(
      alpha.session.posCorrects.length === posCorrectsBefore,
      "换线保留原坐标（没有因为换线挨 posCorrect）",
      `${alpha.session.posCorrects.length - posCorrectsBefore} 帧`,
    );

    // 满线：B 想换到 A/C 那条（2/2），应当被拒并给一条建议线
    const fullResult = await beta.session.changeChannel(worldC.channel);
    check(
      !!fullResult && fullResult.ok === false && fullResult.field === "full",
      "换到满线 → field=full",
      JSON.stringify(fullResult),
    );
    check(
      !!fullResult && fullResult.channel === worldB.channel,
      "被拒后仍在原来那条线",
      JSON.stringify(fullResult && fullResult.channel),
    );
    check(
      !!fullResult && fullResult.suggestChannel !== undefined && fullResult.suggestChannel !== worldC.channel,
      "满线时给了一条**别的**线作为建议",
      JSON.stringify(fullResult && fullResult.suggestChannel),
    );

    //#endregion

    //#region 三、单线图：满了就拒（出厂行为不变）

    group("三、单线图（maxChannels = 1）：满了就拒，回来的人照样放行");

    const romeo = await newPlayer("ch_romeo", singleMap, false);
    const sierra = await newPlayer("ch_sierra", singleMap, false);
    for (const player of [romeo, sierra]) {
      await waitFor(`${player.name} 握手成功`, async () => (player.session.opened ? player.session : null));
    }

    const worldR = await romeo.session.joinWorld(singleMap);
    check(!!worldR && worldR.channel === 0, "R 进了单线图的公共线", JSON.stringify(worldR && worldR.channel));
    romeo.session.reportPos(singleMap, 800, 700);
    await sleep(120);

    const worldS = await sierra.session.joinWorldExpectResult(singleMap);
    check(
      !!worldS && worldS.ok === false && worldS.reject.field === "full",
      "单线图满员 → worldJoin 被拒（field=full），不会自动开线",
      JSON.stringify(worldS && (worldS.reject || worldS.world)),
    );
    check(
      !!worldS && worldS.ok === false && worldS.reject.need === singleRules.maxPlayersPerRoom,
      "拒绝帧里的 need = 单线容量（与 map_rules 一致）",
      `${worldS && worldS.reject && worldS.reject.need} vs ${singleRules.maxPlayersPerRoom}`,
    );

    const intent = await sierra.session.mapEnter(singleMap);
    check(
      !!intent && intent.ok === false && intent.field === "full",
      "mapEnter 提前问一遍也是 full（客户端不用先切场景再被拒）",
      JSON.stringify(intent),
    );

    // 回到自己那张图（登录 / 断线重连）不该被容量锁在门外
    const ticketBack = await romeo.freshTicket();
    const reconnect = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticketBack)}`);
    await waitFor("重连握手成功", async () => (reconnect.opened ? reconnect : null));
    const worldBack = await reconnect.joinWorld(singleMap);
    check(
      !!worldBack && worldBack.channel === 0,
      "本来就在这张图的人重连照样放行（容量不锁自己人）",
      JSON.stringify(worldBack && worldBack.channel),
    );
    reconnect.socket.close();

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 分线（容量 / 自动开线 / changeChannel）：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-40).join("\n"));
      // 排查用：`E2E_DEBUG_LOGS=1` 打全量服务端日志（默认只留 40 行，免得刷屏）
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
