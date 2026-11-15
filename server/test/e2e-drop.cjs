#!/usr/bin/env node
/**
 * 地面掉落（世界实体）专项 e2e（server/test/e2e-drop.cjs，#802）
 *
 * ## 这一套盯什么
 *
 * #802 把掉落从「击杀者的私人账本」升级成**世界实体**，四条不变量各自的证据在这里：
 *
 * 一、**世界可见**：一个人打出来的掉队，同图另一个连接也收到 `dropSpawn`，`dropId` 与
 *    坐标逐字段一致；两个玩家各自击杀，id 不撞车（旧的 `castId` 各自从 1 开始，必须修掉的就是这个）
 * 二、**投影表**：`world_drops` 是给管理端读的投影 —— 内存是权威，100ms 一拍批量写库，
 *    这里验「库里的行与广播出去的那件是同一件」（id / 物品 / 坐标 / 归属），以及
 *    **连续击杀时每一件都落库、同一件只有一行**（批量写不丢行、upsert 幂等）
 * 三、**保护期与归属**：保护期内非归属者拿 `protected`（带 `waitMs`）；保护期压 0 之后
 *    新掉落谁都能捡，捡走时原归属者收到 `dropRemove(reason=picked, byName)`
 * 四、**生命周期与重启清场**：TTL 到点自己消失（`dropRemove(reason=expired)` + 投影行删除）；
 *    实时进程重启后地面清空（`world_drops` 无残留，新连接拿到的 `world.drops` 为空）
 *
 * ## 为什么单独一套
 *
 * `e2e-combat` 的第九组盯的是**拾取语义**（入包 / 幂等 / 距离闸 / 换图），它的世界只用到
 * 一个人一张图；而这一套要**两个连接 + 重启进程**，塞进去会把那边变成什么都测一点的套装。
 *
 * 与其他 e2e 一样：**用临时文件库**（重启清场那条只有文件库能验）。
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
const ADMIN_CODE = "olua-e2e-drop-admin";

//#region 断言小工具（与 e2e-combat 同款口径）

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
    await sleep(25);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 起一台实时服务（文件库）
 *
 * `WORLD_RESPAWN_MS` 调小：这一套每段都要打一只怪，等 5 秒重生太浪费。
 * `ADMIN_REGISTER_CODE` 固定，省得从 .env 猜。
 */
async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-drop-secret",
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
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
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

/** 一条会话化的连接（world / dropSpawn / dropRemove / picked 都收） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    dropSpawns: [],
    dropRemoves: [],
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
    /** 等「某件掉落的出现帧」（同图所有连接都该收到同一份） */
    async waitSpawn(dropId, timeoutMs = 10_000) {
      return waitFor(`dropId=${dropId} 的 dropSpawn`, async () => {
        for (const frame of session.dropSpawns) {
          const hit = (frame.drops || []).find((drop) => drop.dropId === dropId);
          if (hit) return hit;
        }
        return null;
      }, timeoutMs);
    },
    async waitRemove(dropId, timeoutMs = 20_000) {
      return waitFor(`dropId=${dropId} 的 dropRemove`, async () => {
        for (const frame of session.dropRemoves) {
          if ((frame.dropIds || []).includes(dropId)) return frame;
        }
        return null;
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
      if (frame.type === "dropSpawn") session.dropSpawns.push(frame.data);
      if (frame.type === "dropRemove") session.dropRemoves.push(frame.data);
      if (frame.type === "picked") session.pickeds.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 读投影表的行（只读连接；服务端在写 WAL，读侧不受影响） */
function readDropRows(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT drop_id, map_id, good_id, count, x, y, owner_name FROM world_drops").all();
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-drop-${Date.now()}.db`);
  const port = await freePort();
  let server = await startServer(dbPath, port);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：管理员 / 两名玩家 / 同一张图");

    // 第一个注册的管理员自动是超级管理员
    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "drop_admin", password: "Drop#12345", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username: "drop_admin", password: "Drop#12345" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    /** 注册 + 建号 + 摆到图 1 + 连上实时通道 */
    async function newPlayer(name) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const token = registered.data && registered.data.token;
      const created = await api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
      // #859：没有位置记录的角色只准进新手村，这里按运营摆位放到图 1（等价管理端 PATCH onMap）
      placeRolesAt(dbPath, "1", [name]);
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor(`${name} 握手成功`, async () => (session.opened ? session : null));
      return { token, roleId: created.data && created.data.id, name, session };
    }

    const alice = await newPlayer("drop_alice");
    const bob = await newPlayer("drop_bob");

    /**
     * 给一份规范化空网格（4×10）
     *
     * 服务端不扩容：新号的 `data.bag` 是**空数组**（= 没有网格），那种存档里任何拾取都会被判
     * `bag_full`。这一套要验「别人也能捡」，两个人的背包都得先有格子。
     */
    const giveEmptyGrid = async (player) => {
      const initial = await api(baseUrl, "GET", `roles/${player.roleId}`, { token: player.token });
      const emptyGrid = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
      const saved = await api(baseUrl, "PUT", `roles/${player.roleId}`, {
        token: player.token,
        body: { revision: initial.data && initial.data.revision, data: { ...(initial.data.data || {}), bag: emptyGrid } },
      });
      const after = await api(baseUrl, "GET", `roles/${player.roleId}`, { token: player.token });
      const bag = after.data && after.data.data && after.data.data.bag;
      return { saved, bag };
    };
    const aliceBag = await giveEmptyGrid(alice);
    const bobBag = await giveEmptyGrid(bob);
    check(
      Array.isArray(aliceBag.bag) && aliceBag.bag.length === 4 && Array.isArray(bobBag.bag) && bobBag.bag.length === 4,
      "准备：两人都有 4×10 的空背包（否则拾取一律 bag_full）",
      JSON.stringify({ alice: aliceBag.bag && aliceBag.bag.length, bob: bobBag.bag && bobBag.bag.length }),
    );

    const aliceWorld = await alice.session.joinWorld("1");
    const bobWorld = await bob.session.joinWorld("1");
    check(!!(aliceWorld && aliceWorld.mapId === "1") && !!(bobWorld && bobWorld.mapId === "1"), "准备：两名玩家都进了图 1（同图才收得到掉落广播）");
    check(
      Array.isArray(aliceWorld.drops) && aliceWorld.drops.length === 0,
      "准备：进图快照带 drops 段且此刻为空（服务端刚起、地面干净）",
      JSON.stringify(aliceWorld.drops),
    );

    /**
     * 把某只怪的掉落改成「必掉 1 件 drug_hp_1」（picks 1 × chance 1 → 结果确定）
     *
     * 按实际要打的怪物 key 改，不写死：图上不只有一只怪，挑到哪只取决于重生时序。
     */
    const patchDropOf = (monsterKey, goodId = "drug_hp_1") =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { tableId: null, picks: 1, entries: [{ goodId, weight: 100, chance: 1, count: [1, 1] }], bindDrops: false },
      });

    /** cast 序号（服务端幂等账按 castId，自己数就行） */
    let castSeq = 0;

    /** 打一只活着的怪，返回击杀那次的结算（打不死 / 被拒返回 null） */
    const killOne = async (player, mapId = "1") => {
      // 怪会被前面的段打空（重生 1500ms 一拍）：这里静默等一只活的，不记失败 ——
      // 等到不了就返回 null，由调用方的断言去说「这一枪没打成」
      let snapshot = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        snapshot = await player.session.joinWorld(mapId);
        if (snapshot && Array.isArray(snapshot.monsters) && snapshot.monsters.some((monster) => monster.alive)) break;
        await sleep(1_500);
      }
      const mob = snapshot && Array.isArray(snapshot.monsters) ? snapshot.monsters.find((monster) => monster.alive) : null;
      if (!mob) return null;
      await patchDropOf(mob.monsterKey);
      // 站在怪旁边上报位置：拾取距离闸读的是这份坐标
      const stand = JSON.stringify({ type: "pos", data: { mapId, x: mob.x, y: mob.y, hp: 100 } });
      player.session.socket.send(stand);
      player.session.socket.send(stand);
      for (let i = 0; i < 80; i += 1) {
        await paceCast();
        const castId = ++castSeq;
        player.session.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }));
        const settle = await player.session.waitSettle(castId);
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

    //#endregion

    //#region 一、世界可见与全局唯一

    group("一、世界可见：同图两个连接收到同一份掉落，两人的掉落 id 不撞车");

    const killedByAlice = await killOne(alice);
    const aliceDrop = dropIdOf(killedByAlice);
    check(!!aliceDrop, "A：A 击杀后结算里带 dropId", JSON.stringify(killedByAlice && killedByAlice.reward && killedByAlice.reward.drops));
    check(/^d_\d+_1_\d+$/.test(aliceDrop), "A：dropId 是「d_<区>_<图>_<序号>」形态（区与图都在 id 里）", aliceDrop);

    const seenByAlice = aliceDrop ? await alice.session.waitSpawn(aliceDrop) : null;
    const seenByBob = aliceDrop ? await bob.session.waitSpawn(aliceDrop) : null;
    check(!!seenByAlice, "A：击杀者自己收到 dropSpawn", JSON.stringify(seenByAlice));
    check(!!seenByBob, "A：**另一个连接**也收到同一件 dropSpawn（掉落是世界实体，不是私人账本）", JSON.stringify(seenByBob));
    check(
      !!(seenByAlice && seenByBob) &&
        seenByAlice.dropId === seenByBob.dropId &&
        seenByAlice.x === seenByBob.x &&
        seenByAlice.y === seenByBob.y &&
        seenByAlice.goodId === seenByBob.goodId,
      "A：两个连接拿到的 dropId / 坐标 / 物品完全一致（客户端不必自己算落点）",
      JSON.stringify({ alice: seenByAlice, bob: seenByBob }),
    );
    check(
      !!(seenByAlice && seenByBob) && seenByBob.ownerAccountId === seenByAlice.ownerAccountId && typeof seenByBob.ownerName === "string" && seenByBob.ownerName.length > 0,
      "A：掉落带归属者身份（保护期与「谁打的」提示都靠它）",
      JSON.stringify({ owner: seenByBob && seenByBob.ownerName, account: seenByBob && seenByBob.ownerAccountId }),
    );
    check(
      !!(seenByAlice && seenByBob) && typeof seenByBob.protectInMs === "number" && seenByBob.protectInMs > 0 && typeof seenByBob.expireInMs === "number" && seenByBob.expireInMs > seenByBob.protectInMs,
      "A：帧里给的是相对量（protectInMs / expireInMs），不是要客户端自己减时钟",
      JSON.stringify({ protectInMs: seenByBob && seenByBob.protectInMs, expireInMs: seenByBob && seenByBob.expireInMs }),
    );

    const killedByBob = await killOne(bob);
    const bobDrop = dropIdOf(killedByBob);
    check(!!bobDrop && bobDrop !== aliceDrop, "B：另一个人打出来的掉落 id 与第一件不同（旧的 castId 各自从 1 开始，这里必须不撞车）", JSON.stringify({ alice: aliceDrop, bob: bobDrop }));
    const bobSeenByAlice = bobDrop ? await alice.session.waitSpawn(bobDrop) : null;
    check(!!bobSeenByAlice, "B：A 也收到了 B 打出来的那件（互相可见，与谁是击杀者无关）", JSON.stringify(bobSeenByAlice));

    //#endregion

    //#region 二、投影表（world_drops）

    group("二、投影表：world_drops 里那行与广播出去的是同一件（id / 物品 / 坐标 / 归属）");

    // 内存是权威、库是投影，100ms 一拍批量写 —— 给一拍的时间差
    const rows = await waitFor("world_drops 出现这次的两行", async () => {
      const all = readDropRows(dbPath);
      return all.filter((row) => row.drop_id === aliceDrop || row.drop_id === bobDrop).length >= 2 ? all : null;
    }, 5_000);
    const aliceRow = Array.isArray(rows) ? rows.find((row) => row.drop_id === aliceDrop) : null;
    check(!!aliceRow, "A：落库了（drop_id 是主键，重连的管理端读得到）", JSON.stringify(aliceRow));
    check(
      !!(aliceRow && seenByAlice) &&
        aliceRow.map_id === "1" &&
        aliceRow.good_id === seenByAlice.goodId &&
        aliceRow.count === seenByAlice.count &&
        aliceRow.x === seenByAlice.x &&
        aliceRow.y === seenByAlice.y &&
        aliceRow.owner_name === seenByAlice.ownerName,
      "A：库里的行与广播的帧逐字段一致（同一份数据，投影不自己算）",
      JSON.stringify({ row: aliceRow, frame: seenByAlice }),
    );

    //#endregion

    //#region 二之二、批量落库（连打多只，100ms 批量写不丢行）

    group("二之二、批量落库：连打三只怪，每一件都进投影表（批量写不丢行、同一件只一行）");

    // 只打三只：这套图一共十来只怪、重生按 30 秒算，打太多会把后面的段饿死（拿不到活靶子）
    const batchIds = [];
    for (let i = 0; i < 3; i += 1) {
      const killed = await killOne(alice);
      for (const entry of (killed && killed.reward && killed.reward.drops) || []) {
        if (typeof entry.dropId === "string" && entry.dropId) batchIds.push(entry.dropId);
      }
    }
    check(batchIds.length >= 3, "三次击杀都出了掉落（否则这条覆盖不到批量）", `共 ${batchIds.length} 件`);
    check(
      new Set(batchIds).size === batchIds.length,
      "几次击杀的 dropId 互不重复（序号按区自增，不按 castId —— 旧口径各自从 1 开始）",
      JSON.stringify(batchIds),
    );

    const batchRows = await waitFor("这批掉落的投影行全部落库", async () => {
      const all = readDropRows(dbPath);
      const have = new Set(all.map((row) => row.drop_id));
      return batchIds.every((id) => have.has(id)) ? all : null;
    }, 10_000);
    check(!!batchRows, "批量写走过之后每一件都查得到（读侧没被写事务挡住，也没有漏行）", `期望 ${batchIds.length} 件`);
    check(
      !!batchRows && batchIds.every((id) => batchRows.filter((row) => row.drop_id === id).length === 1),
      "同一件只落一行（upsert 幂等，不是每拍都插一行）",
      JSON.stringify(batchIds.map((id) => (batchRows || []).filter((row) => row.drop_id === id).length)),
    );

    //#endregion

    //#region 三、保护期与归属

    group("三、保护期：别人的掉落先捡不起来，捡走时原归属者收到 dropRemove");

    // B 去捡 A 的掉落：保护期内 → protected
    bob.session.socket.send(JSON.stringify({ type: "pick", data: { dropId: aliceDrop } }));
    const blocked = await bob.session.waitPicked(aliceDrop);
    check(
      !!(blocked && blocked.ok === false && blocked.code === "protected") && typeof blocked.waitMs === "number" && blocked.waitMs > 0,
      "A：保护期内非归属者被拒（protected + waitMs，客户端能显示「N 秒后可捡」）",
      JSON.stringify(blocked),
    );
    check(
      !!(blocked && blocked.ownerName === (seenByAlice && seenByAlice.ownerName)),
      "A：拒绝帧里带归属者名字（提示语不用客户端自己猜）",
      JSON.stringify(blocked && blocked.ownerName),
    );

    // 保护期压 0 → 只影响**之后生成**的掉落（保护期在 spawn 时固化进实体，不回溯）
    const paramsBefore = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    const protectBefore = paramsBefore.data.drop.protectMs;
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { protectMs: 0 } } });
    const killedByAlice2 = await killOne(alice);
    const aliceDrop2 = dropIdOf(killedByAlice2);
    check(!!aliceDrop2 && aliceDrop2 !== aliceDrop, "B：又打出一份掉落（新的靶子）", aliceDrop2);

    bob.session.socket.send(JSON.stringify({ type: "pick", data: { dropId: aliceDrop2 } }));
    const takenByBob = await bob.session.waitPicked(aliceDrop2);
    check(
      !!(takenByBob && takenByBob.ok && takenByBob.alreadyPicked === false) && takenByBob.dropId === aliceDrop2,
      "B：保护期为 0 时别人也能捡（归属只是优先权，不是永久上锁）",
      JSON.stringify(takenByBob),
    );
    const removedForAlice = aliceDrop2 ? await alice.session.waitRemove(aliceDrop2) : null;
    check(
      !!(removedForAlice && removedForAlice.reason === "picked") && removedForAlice.byName === bob.name,
      "B：捡走时同图的归属者也收到 dropRemove（reason=picked，带捡走的人）",
      JSON.stringify(removedForAlice),
    );
    const rowsAfterPick = readDropRows(dbPath).filter((row) => row.drop_id === aliceDrop2);
    check(rowsAfterPick.length === 0, "B：捡走之后投影行被删掉（重连的人不会再看到它）", JSON.stringify(rowsAfterPick));

    const restored = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { protectMs: protectBefore } },
    });
    check(restored.code === 0, "B：保护期已还原成改之前的值", restored.message);

    //#endregion

    //#region 四、生命周期：TTL 到点自己消失

    group("四、过期：TTL 到点由服务端扫掉（dropRemove reason=expired + 投影行删除）");

    // ttlMs 的下限是 10000（管理端 DTO 也是这个范围）：压到 10 秒，等扫描器一拍
    const ttlPatched = await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { ttlMs: 10_000 } } });
    check(ttlPatched.code === 0, "A：TTL 已压到 10 秒（改完立即生效，只影响新掉落）", ttlPatched.message);
    // 保护期必须 ≤ TTL（服务端会夹逼），这里顺手压小，免得夹逼把 TTL 判定搅浑
    await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { protectMs: 0 } } });

    const killedBeforeExpire = await killOne(alice);
    const expireDrop = dropIdOf(killedBeforeExpire);
    check(!!expireDrop, "A：打出一件将被过期的掉落", expireDrop);
    const spawnOfExpire = expireDrop ? await bob.session.waitSpawn(expireDrop) : null;
    check(
      !!(spawnOfExpire && spawnOfExpire.expireInMs <= 10_000),
      "A：帧里的 expireInMs 就是新 TTL（客户端据此排消失动画，不用读配置）",
      JSON.stringify(spawnOfExpire && spawnOfExpire.expireInMs),
    );
    const expiredRemove = expireDrop ? await alice.session.waitRemove(expireDrop, 25_000) : null;
    check(
      !!(expiredRemove && expiredRemove.reason === "expired"),
      "B：到点收到 dropRemove（reason=expired，不是静默消失）",
      JSON.stringify(expiredRemove),
    );
    const rowsAfterExpire = readDropRows(dbPath).filter((row) => row.drop_id === expireDrop);
    check(rowsAfterExpire.length === 0, "B：过期后投影行被删掉（不会留下捡不起来的幽灵行）", JSON.stringify(rowsAfterExpire));

    // 顺带验一条：拾取被拒之后东西还在（捡不起来 ≠ 消失）
    const killedToKeep = await killOne(alice);
    const keepDrop = dropIdOf(killedToKeep);
    bob.session.socket.send(JSON.stringify({ type: "pick", data: { dropId: keepDrop } }));
    const stillThere = await bob.session.waitPicked(keepDrop);
    check(
      !!(stillThere && stillThere.ok === true),
      "C：TTL 内（保护期已 0）同一件仍可拾取（上一段的过期没有误伤新掉落）",
      JSON.stringify(stillThere),
    );

    //#endregion

    //#region 五、重启清场

    group("五、重启清场：实时进程重启后地面清空，world_drops 无残留");

    // 先在地上留一件（谁都不捡），再重启
    const killedBeforeRestart = await killOne(alice);
    const survivor = dropIdOf(killedBeforeRestart);
    await bob.session.waitSpawn(survivor);
    const rowsBeforeRestart = readDropRows(dbPath).filter((row) => row.drop_id === survivor);
    check(rowsBeforeRestart.length === 1, "A：重启前地面上确实有东西（投影表里有一行）", JSON.stringify(rowsBeforeRestart));

    await stopServer(server);
    server = await startServer(dbPath, port);
    const restarted = server;
    check(!!restarted, "B：实时进程已重启（同一份库）");

    // 重启清场发生在 bootstrap：库里的残留行被删掉（drop_records 的 restart_lost 由 #803 接）
    const rowsAfterRestart = readDropRows(dbPath);
    check(
      rowsAfterRestart.length === 0,
      "B：重启后 world_drops 已清空（上一进程的掉落作废，不留下捡不起来的幽灵行）",
      JSON.stringify(rowsAfterRestart.map((row) => row.drop_id)),
    );
    check(
      /重启清场/.test(restarted.logs()),
      "B：日志里点明清了场（运维能解释「刚才地上的东西怎么没了」）",
      restarted.logs().split("\n").filter((line) => line.includes("重启清场")).slice(-1).join(""),
    );

    // 新连接拿到的快照也必须是空的（客户端屏幕上不能立着捡不起来的东西）
    const reLogin = await api(restarted.baseUrl, "POST", "auth/login", { body: { username: "drop_alice", password: "pass1234" } });
    const reToken = reLogin.data && reLogin.data.token;
    const reTicket = await api(restarted.baseUrl, "POST", "realtime/ticket", { token: reToken });
    const reSession = connect(`${restarted.baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(reTicket.data.ticket)}`);
    await waitFor("重连握手成功", async () => (reSession.opened ? reSession : null));
    const reWorld = await reSession.joinWorld("1");
    check(
      !!reWorld && Array.isArray(reWorld.drops) && reWorld.drops.length === 0,
      "C：重连后的进图快照 drops 为空（地面清空是「服务端权威」，不靠客户端自己忘掉）",
      JSON.stringify(reWorld && reWorld.drops),
    );
    const ghostPick = survivor ? await (async () => {
      reSession.socket.send(JSON.stringify({ type: "pick", data: { dropId: survivor } }));
      return reSession.waitPicked(survivor);
    })() : null;
    check(
      !!(ghostPick && ghostPick.ok === false && ghostPick.code === "unknown_drop"),
      "C：重启前的掉落 id 已经拾不起来（unknown_drop，不是「还在某个人的账本里」）",
      JSON.stringify(ghostPick),
    );

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 地面掉落（世界实体）：${passed} 条通过 / ${failed} 条失败`);
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
