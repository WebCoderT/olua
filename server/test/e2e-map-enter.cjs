#!/usr/bin/env node

/**
 * 服务端 e2e：进图门槛（#606）
 *
 * 判定从客户端搬到服务端之后要守住的不变量：
 *
 * 一、**登录不算换图**：服务端还没有位置记录（刚建号 / 老档第一次上线）时放行，
 *     并把「他在这张图」记下来（`data.mapAt`）
 * 二、**改包直发 worldJoin 换高级图被拒**：1 级角色直发 map 2（要求 40 级）→ 回
 *     `mapEnterResult { ok: false, field: level, need: 40 }`，**没有 world 帧**，位置不变
 * 三、**换图意图（mapEnter）**：与 worldJoin 同一套判据，够条件的放行、不够的给结构化原因；
 *     它只回答「能不能去」，不动世界状态
 * 四、**运营调高门槛不锁人**：已经站在那张图里的人（位置与目标一致）永远放行 ——
 *     这是 #573 的教训，不能因为后台点了一次保存就把人关在门外
 * 五、**位置客户端改不了**：`PUT /roles/:id` 里塞 `mapAt` 会被回填丢弃，
 *     所以「先改位置再重连」这条绕过路走不通
 *
 * 走的是 `dist/`，前置是 `npm run build`。
 * 用法：npm run test:e2e:map-enter
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册邀请码（与 startServer 的 ADMIN_REGISTER_CODE 同值） */
const ADMIN_CODE = "e2e-map-enter-admin";

//#region 断言小工具（与其余 e2e 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
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
}

const checkEqual = (actual, expected, label) => check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

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

const waitFor = async (label, predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(20);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 起一台服务（用临时**文件**库：位置要落库，重启后还得在）
 *
 * `WORLD_MAP_IDLE_MS=0` 让图立刻可回收（本套不关心世界存活）；
 * 重生阈值调小只是为了让测试结束得快（本套不打怪）。
 */
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
      JWT_SECRET: "e2e-map-enter-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
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

/**
 * 一条会话化的 WS 连接
 *
 * 这里同时收两种帧：`world`（进图成功）与 `mapEnterResult`（换图判定，成功与拒绝同形）。
 * 断言「被拒后没有进图」靠的是**帧数不动**，所以两种帧都按到达顺序攒下来。
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    results: [],
    /** 互见帧（`players`，#861：在场表的外部投影 —— 这一段唯一的观察口） */
    players: [],
    /** 发一条 worldJoin（不等应答） */
    sendJoin(mapId) {
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
    },
    /** 发一条换图意图（不等应答） */
    sendMapEnter(mapId) {
      socket.send(JSON.stringify({ type: "mapEnter", data: { mapId } }));
    },
    /** 发一条位置上报（不等应答；`mapId` 故意做成可传任意值 —— 这一段要伪造的就是它） */
    sendPos(mapId, x, y, hp, moving = false) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving } }));
    },
    /** 只等「发出去之后到达」的 world 帧（广播与应答同形，按发送时刻切分） */
    async joinWorld(mapId, timeoutMs = 8_000) {
      const before = session.worlds.length;
      session.sendJoin(mapId);
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => {
        const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
        return hits.length > 0 ? hits[hits.length - 1] : null;
      }, timeoutMs);
    },
    /** 等「这条消息之后」到达的换图判定（mapEnter 与 worldJoin 被拒共用同一帧） */
    async waitForResult(action, mapId, timeoutMs = 8_000) {
      const before = session.results.length;
      action();
      return waitFor(`mapId=${mapId} 的换图判定`, async () => {
        const hits = session.results.slice(before).filter((frame) => frame.mapId === mapId);
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
      if (frame.type === "mapEnterResult") session.results.push(frame.data);
      if (frame.type === "players") session.players.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-enter-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    //#region 准备：管理员 / 玩家 / 角色 / 连接

    group("准备：管理员、玩家、角色与实时连接");

    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "map_admin", password: "pass1234", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { username: "map_admin", password: "pass1234" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "map_player", password: "pass1234" } });
    const playerToken = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token: playerToken, body: { name: "门槛测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!roleId, "准备：1 级角色已建（建号位置 = 新手村 0）", created.message);

    const initial = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
    const initialData = (initial.data && initial.data.data) || {};
    checkEqual(initialData.onMap, "0", "准备：建号位置是 0（新手村）");
    checkEqual(initialData.mapAt, undefined, "准备：还没有服务端位置记录（mapAt 未写）");

    const connectAs = async (token) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor("握手成功", async () => (session.opened ? session : null));
      return session;
    };
    let session = await connectAs(playerToken);
    check(session.opened, "准备：实时连接已建立");

    const roleData = async () => {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
      return (detail.data && detail.data.data) || {};
    };

    //#endregion

    //#region 一、首次进图：没有位置记录只准进新手村，未知图直接拒（#859）

    group("一、首次进图：没有位置记录只准进新手村，未知图直接拒（#859）");
    {
      // 以前是「没有位置记录就不拦」—— 那一刻客户端说在哪就在哪，于是新号能直接落到任意图，
      // 而且 `setMapAt` 会把这次放行记下来，下一次就按新位置判了（门槛的永久后门）。
      const notStart = await session.waitForResult(() => session.sendJoin("1"), "1");
      check(!!notStart && notStart.ok === false, "新号 worldJoin(1) 被拒（不再「没有位置记录就放行」）", JSON.stringify(notStart));
      checkEqual(notStart && notStart.field, "start", "拒绝原因 = start（还没有落脚点，只准进新手村）");
      checkEqual(notStart && notStart.mapLabel, "卧龙城", "带目标图名（提示要用）");
      checkEqual((await roleData()).mapAt, undefined, "被拒的那次不写位置");

      // 未知图：以前会放行并给它建一张空图 —— 拼错一个地图 id 就能进没有地形、没有怪、
      // 没有复活点的表外世界，运营永远不知道有人在那儿
      const unknown = await session.waitForResult(() => session.sendJoin("99"), "99");
      check(!!unknown && unknown.ok === false, "未知图 worldJoin(99) 被拒", JSON.stringify(unknown));
      checkEqual(unknown && unknown.field, "unknown", "拒绝原因 = unknown（图不存在）");
      checkEqual(unknown && unknown.mapLabel, "99", "mapLabel 回客户端报上来的那个 id");
      checkEqual(session.worlds.length, 0, "两次被拒都没有 world 帧（世界层没被惊动）");

      const firstWorld = await session.joinWorld("0");
      check(!!firstWorld && firstWorld.mapId === "0", "新号 worldJoin(0) 放行（新手村）", JSON.stringify(firstWorld && firstWorld.mapId));
      check(Array.isArray(firstWorld && firstWorld.monsters), "world 帧带怪物实例列表", JSON.stringify(firstWorld && firstWorld.monsters.length));
      checkEqual((await roleData()).mapAt, "0", "服务端记下位置：data.mapAt = 0");
    }

    //#endregion

    //#region 二、改包直发 worldJoin 换高级图 → 被拒

    group("二、改包直发 worldJoin 换高级图（1 级 → 王城 40 级）");
    {
      const worldsBefore = session.worlds.length;
      const before = session.results.length;
      session.sendJoin("2");
      const rejected = await waitFor("mapId=2 的换图判定", async () => {
        const hits = session.results.slice(before).filter((frame) => frame.mapId === "2");
        return hits.length > 0 ? hits[hits.length - 1] : null;
      });
      check(!!rejected && rejected.ok === false, "worldJoin(2) 被拒（ok=false）", JSON.stringify(rejected));
      checkEqual(rejected && rejected.field, "level", "拒绝原因指向等级");
      // 要求的等级来自那张图的配置（运营数据）；这里判「带出一个正的等级」，具体值由后面「改门槛即生效」那段证明
      check(Number(rejected && rejected.need) > 0, "拒绝里带出该图要求的等级", JSON.stringify(rejected && rejected.need));
      checkEqual(rejected && rejected.mapLabel, "王城", "带图名（提示要用）");
      // 被拒不该落地：没有 world 帧，观看者身份也没登记
      await sleep(600);
      checkEqual(session.worlds.length, worldsBefore, "被拒后没有收到 world 帧（世界层没被惊动）");
      checkEqual((await roleData()).mapAt, "0", "位置没有被改动（仍是 0）");
    }

    //#endregion

    //#region 三、换图意图 mapEnter：同一套判据，只回答「能不能去」

    group("三、换图意图 mapEnter：够条件的放行、不够的给结构化原因");
    {
      const rejected = await session.waitForResult(() => session.sendMapEnter("2"), "2");
      check(!!rejected && rejected.ok === false && rejected.field === "level" && Number(rejected.need) > 0, "mapEnter(2) 被拒且原因同 worldJoin", JSON.stringify(rejected));
      const allowed = await session.waitForResult(() => session.sendMapEnter("3"), "3");
      check(!!allowed && allowed.ok === true, "mapEnter(3) 放行（雪域高原只要 1 级）", JSON.stringify(allowed));
      const same = await session.waitForResult(() => session.sendMapEnter("0"), "0");
      check(!!same && same.ok === true, "mapEnter(当前图) 放行", JSON.stringify(same));
      checkEqual((await roleData()).mapAt, "0", "意图不落地：位置仍是 0（只有 worldJoin 才写位置）");
    }

    //#endregion

    //#region 四、运营摆位 / 门槛调高都不锁人

    group("四、运营把人摆进高级图 / 事后调高门槛：已经在那里的低等级角色永远放行");
    {
      // 运营摆位：PATCH onMap 同时承认这个位置（mapAt），否则「门槛认为他还在旧图」
      const placed = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { onMap: "2" } });
      check(placed.code === 0, "运营把 1 级角色摆到王城（PATCH onMap=2）", placed.message);
      const placedData = await roleData();
      checkEqual(placedData.mapAt, "2", "摆位同时写了服务端位置：mapAt = 2");

      const joined = await session.joinWorld("2");
      check(!!joined && joined.mapId === "2", "1 级角色进王城成功（位置与目标一致 → 不拦）");

      // 运营再把门槛调高：站在里面的人重连进来仍然不拦（#573 的教训）
      const mapTwo = await api(baseUrl, "GET", "admin/maps/2", { token: adminToken });
      const config = mapTwo.data;
      const raised = await api(baseUrl, "PATCH", "admin/maps/2", {
        token: adminToken,
        body: { label: config.label, type: config.type, level: 99, combat: config.combat, soulOfWar: config.soulOfWar },
      });
      check(raised.code === 0, "运营把王城进入等级调到 99", raised.message);

      // 换一条连接（模拟重新登录）：登录进的是脚下那张图，不能被自己的门槛挡住
      session.socket.close();
      session = await connectAs(playerToken);
      const relogin = await session.joinWorld("2");
      check(!!relogin && relogin.mapId === "2", "重连后 worldJoin(2) 仍然放行（运营调高门槛不锁人）", JSON.stringify(relogin && relogin.mapId));

      // 但此时去别的图就按新门槛判：10 图（桃花源溪 50 级）依然进不去，且 2 图的门槛确实生效
      const other = await session.waitForResult(() => session.sendMapEnter("10"), "10");
      check(!!other && other.ok === false && other.field === "level" && Number(other.need) > 0, "mapEnter(10) 被拒（带出要求的等级）", JSON.stringify(other));
    }

    //#endregion

    //#region 五、位置客户端改不了（mapAt 独占）

    group("五、客户端改不了位置：PUT 里塞 mapAt 会被回填丢弃");
    {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token: playerToken });
      const data = { ...detail.data.data, mapAt: "10" };
      const saved = await api(baseUrl, "PUT", `roles/${roleId}`, { token: playerToken, body: { data, revision: detail.data.revision } });
      check(saved.code === 0, "存档推送成功（服务端不拒收，只回填）", saved.message);
      checkEqual((await roleData()).mapAt, "2", "mapAt 仍是 2（上报的 10 被丢弃）");

      const worldsBefore = session.worlds.length;
      const bypass = await session.waitForResult(() => session.sendJoin("10"), "10");
      check(!!bypass && bypass.ok === false, "改位置再直发 worldJoin(10) 仍被拒（绕不过去）", JSON.stringify(bypass));
      await sleep(600);
      checkEqual(session.worlds.length, worldsBefore, "被拒后依旧没有 world 帧");
    }

    //#endregion

    //#region 六、正常换图：够条件就放行，并更新位置

    group("六、正常换图：够条件放行，位置跟着走");
    {
      const allowed = await session.waitForResult(() => session.sendMapEnter("3"), "3");
      check(!!allowed && allowed.ok === true, "mapEnter(3) 放行（雪域高原 1 级）", JSON.stringify(allowed));
      const joined = await session.joinWorld("3");
      check(!!joined && joined.mapId === "3", "worldJoin(3) 成功", JSON.stringify(joined && joined.mapId));
      checkEqual((await roleData()).mapAt, "3", "位置更新为 3");
      // 位置变了，门槛就重新生效：2 图现在要 99 级，1 级角色从 3 回 2 应该被拒
      const back = await session.waitForResult(() => session.sendJoin("2"), "2");
      check(!!back && back.ok === false && back.need === 99, "位置变成 3 之后，worldJoin(2) 按新门槛被拒（99 级）", JSON.stringify(back));
    }

    //#endregion

    //#region 七、pos 帧防伪造：自报的图与登记的不一致整帧丢弃（#861）

    group("七、pos 帧防伪造：自报的图与登记的不一致，整帧丢弃（#861）");
    {
      // 在场条目里的图**只由 worldJoin 写**。以前 `updatePosition` 遇到「上报的图变了」
      // 就整份接受 —— 改个包就能把自己搬到任意图：注入幽灵玩家、被那张图的怪选中、
      // 跨图发世界聊天。这一段靠第二个连接的**眼睛**看：互见帧是在场表的外部投影。

      const watcherReg = await api(baseUrl, "POST", "auth/register", { body: { username: "map_watcher", password: "pass1234" } });
      const watcherToken = watcherReg.data && watcherReg.data.token;
      const watcherRole = await api(baseUrl, "POST", "roles", { token: watcherToken, body: { name: "看客", occupation: "1", sex: "1" } });
      check(!!(watcherToken && watcherRole.data && watcherRole.data.id), "准备：看客账号与角色");
      // 看客也得先在图 3（#859：没有位置记录只准进新手村），否则看不见这一段的任何东西
      placeRolesAt(dbPath, "3", ["看客"]);
      const watcher = await connectAs(watcherToken);
      const watcherWorld = await watcher.joinWorld("3");
      check(!!watcherWorld && watcherWorld.mapId === "3", "看客进图 3（与目标同图）");

      // 目标此时在图 3（上一段刚 join 进来），但还没上报过位置 —— 在场条目由 pos 帧建
      const beforePos = watcher.players.length;
      session.sendPos("3", 520, 380, 100, true);
      const seen = await waitFor("看客收到目标的互见条目", async () => {
        return watcher.players
          .slice(beforePos)
          .flatMap((frame) => frame.players || [])
          .filter((entry) => entry.n === "门槛测试")
          .pop() || null;
      }, 5_000);
      check(!!seen && seen.x === 520 && seen.y === 380, "真上报（mapId = 当前图）被接受：同图玩家看得见", JSON.stringify(seen && { x: seen.x, y: seen.y, hp: seen.hp }));
      const targetAccountId = seen ? seen.a : "";
      check(!!targetAccountId, "拿得到目标的账号 id（后面按它判离开）");

      // 伪造：换成别的图（1 图）连发几十帧 —— 以前这会把人搬到 1 图，现在整帧丢弃
      const beforeForge = watcher.players.length;
      const forgeTimer = setInterval(() => session.sendPos("1", 9_999, 9_999, 1), 150);
      await sleep(1_200);
      clearInterval(forgeTimer);
      const forged = watcher.players
        .slice(beforeForge)
        .flatMap((frame) => frame.players || [])
        .filter((entry) => entry.a === targetAccountId);
      check(forged.length === 0, "伪造帧没有改变任何东西（坐标 / 血量一个字段都没动）", JSON.stringify(forged.slice(-1)[0]));
      const stillThere = watcher.players
        .slice(beforeForge)
        .flatMap((frame) => frame.left || []);
      check(!stillThere.includes(targetAccountId), "伪造帧也不把人踢下他的图（丢弃 ≠ 离场）");

      // 关键判据：`updatedAt` 也不刷 —— 否则伪造帧能让幽灵玩家在别人的屏幕上永不过期。
      // 只发伪造帧、不再发真上报，超过位置过期时间后必须收到 left。
      const forgeOnly = setInterval(() => session.sendPos("1", 9_999, 9_999, 1), 150);
      const leftFrame = await waitFor("目标超时离场（left）", async () => {
        return watcher.players.find((frame) => (frame.left || []).includes(targetAccountId)) || null;
      }, 8_000);
      clearInterval(forgeOnly);
      check(!!leftFrame, "只发伪造帧 → 照样按位置过期离场（updatedAt 不被伪造帧刷新）", JSON.stringify(leftFrame && leftFrame.left));

      // 离场之后条目就没了，下一帧走的是「首帧」那条路径 —— 这才是最容易被漏掉的一段：
      // 只挡「条目还在」的帧，等它过期再发一帧伪造的图，人就被注入到那张图了。
      const afterLeft = watcher.players.length;
      session.sendPos("1", 900, 900, 100, false); // 伪造：把自己放到 1 图（此刻没有条目）
      await sleep(400);                            // 给旧行为留够建条目的时间
      session.sendPos("3", 300, 300, 100, false);  // 真上报（当前图）
      const back = await waitFor("目标重新出现", async () => {
        return watcher.players
          .slice(afterLeft)
          .flatMap((frame) => frame.players || [])
          .find((entry) => entry.a === targetAccountId && entry.x === 300) || null;
      }, 5_000);
      check(!!back, "首帧也校验位置：伪造帧没能建出条目，真上报把人接回在场表", JSON.stringify(back && { x: back.x, y: back.y }));

      session.socket.close();
      watcher.socket.close();
    }

    //#endregion
  } finally {
    server.child.kill("SIGKILL");
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✔" : "✗"} 进图门槛：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log(failures.map((item) => `  - ${item}`).join("\n"));
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
