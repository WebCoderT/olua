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
 * 四、**生命周期**：TTL 到点自己消失（`dropRemove(reason=expired)` + 投影行删除）；
 *    超过单图上限时最旧的被挤掉（`reason=overflow`）；重启后地面清空
 *    （`world_drops` 无残留，新连接拿到的 `world.drops` 为空）
 * 五、**终态流水（#803）**：picked / expired / overflow / restart_lost 四种终态**各写一行**
 *    `drop_records`，冗余的物品名与怪物名不为空、`lived_ms = resolved_at - created_at`；
 *    这一套是这条链路唯一的写侧证据（读侧在 `e2e-drop-records`）
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

/**
 * 读终态流水（`drop_records`，只读连接）
 *
 * 流水是**攒批**写的（100ms 一拍），所以断言一律走 `waitFor` 而不是「捡完立刻查」。
 */
function readRecordRows(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT drop_id, zone_id, map_id, good_id, good_type, good_label, count, bound, monster_key, " +
          "monster_label, monster_instance_id, owner_name, result, reason, picked_account_id, picked_name, " +
          "created_at, resolved_at, lived_ms FROM drop_records ORDER BY id ASC",
      )
      .all();
  } finally {
    db.close();
  }
}

/** 某件掉落有没有流水行（`result` 给了就一并比对） */
function recordsOf(dbPath, dropId, result) {
  return readRecordRows(dbPath).filter((row) => row.drop_id === dropId && (!result || row.result === result));
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
  const dbPath = path.join(os.tmpdir(), `olua-e2e-drop-${Date.now()}.db`);
  const port = await freePort();
  let server = await startServer(dbPath, port);
  seedBattlefield(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：管理员 / 两名玩家 / 同一张图");

    // 第一个注册的管理员自动是超级管理员
    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "drop_admin", password: "Drop#12345", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username: "drop_admin", password: "Drop#12345" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    // #1084 重排后整套搬去图 3（唯一有怪的图），而图 3 出厂 allow_drop = 0（不掉东西的图）。
    // 规则 PATCH 是**整份提交**校验 —— 把 GET 回来的整份改一个开关再交回去；库是一次性的，不必还原
    const rulesZero = (await api(baseUrl, "GET", "admin/maps/3/rules", { token: adminToken, zoneId: ADMIN_ZONE })).data || null;
    if (rulesZero && rulesZero.allowDrop === false) {
      const opened = await api(baseUrl, "PATCH", "admin/maps/3/rules", {
        token: adminToken, zoneId: ADMIN_ZONE,
        body: { ...rulesZero, allowDrop: true, mapId: undefined, inherited: undefined, updatedBy: undefined, updatedAt: undefined },
      });
      check(opened.code === 0, "准备：临时打开图 3 掉落（map_rules.allowDrop，整份提交）", opened.message);
    }

    // 出厂实况的 protectMs / ttlMs 可能就是 0 / 10s（#1177 快照来自运营库）：归属保护用例
    // 需要正值，且「保护期」段隔着两段用例、小值会先到期。压成 protect 60s / ttl 300s
    // （protect 必须严格小于 ttl，否则 spawn 帧里 protectInMs === expireInMs；
    // ttl 上限 5 分钟，再大 DTO 会拒）；段内的「压 0 / 还原」各自照旧
    const protectOn = await api(baseUrl, "PATCH", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { protectMs: 60_000, ttlMs: 300_000 } } });
    check(protectOn.code === 0, "准备：掉落保护期临时压到 5 分钟（后面「保护期」段隔着两段用例，8s 会先到期）（归属保护用例需要正值）", protectOn.message);

    // #1084 重排后图 3 环带拥挤：1 级角色站在怪堆里会被主动怪围殴打死（cast 回 dead，
    // 每一段跟着红在准备上）。这套要的是「地上有掉落」，先把全图怪物主动攻击临时关掉
    // （AI 侧 1 秒 TTL 缓存 → 等一拍再继续）；库是一次性的，不还原
    const monstersAll = await api(baseUrl, "GET", "admin/monsters?page=1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    for (const row of (monstersAll.data && monstersAll.data.list) || []) {
      if (!row.presentation) continue;
      await api(baseUrl, "PATCH", `admin/monsters/${row.id}`, {
        token: adminToken, zoneId: ADMIN_ZONE, body: { presentation: { aggressive: false } },
      });
    }
    await sleep(1500);

    /** 注册 + 建号 + 摆到图 3 + 连上实时通道 */
    async function newPlayer(name) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const token = registered.data && registered.data.token;
      const created = await api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
      // #859：没有位置记录的角色只准进新手村，这里按运营摆位放到图 3（等价管理端 PATCH onMap；#1084 重排后唯一有怪的图）
      placeRolesAt(dbPath, "3", [name]);
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

    const aliceWorld = await alice.session.joinWorld("3");
    const bobWorld = await bob.session.joinWorld("3");
    check(!!(aliceWorld && aliceWorld.mapId === "3") && !!(bobWorld && bobWorld.mapId === "3"), "准备：两名玩家都进了图 3（同图才收得到掉落广播）");
    check(
      Array.isArray(aliceWorld.drops) && aliceWorld.drops.length === 0,
      "准备：进图快照带 drops 段且此刻为空（服务端刚起、地面干净）",
      JSON.stringify(aliceWorld.drops),
    );

    /**
     * 把某只怪的掉落改成「必掉这几件」（picks = 件数 × chance 1 → 结果确定）
     *
     * 按实际要打的怪物 key 改，不写死：图上不只有一只怪，挑到哪只取决于重生时序。
     * 默认只掉 1 件 `drug_hp_1`；挤掉那一段要一次掉好几件（必须是**不同**物品，
     * 同物品会被 `rollDropTable` 合并成一条，件数就不涨了）。
     */
    const patchDropOf = (monsterKey, goodIds = ["drug_hp_1"]) =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: {
          tableId: null,
          picks: goodIds.length,
          entries: goodIds.map((goodId) => ({ goodId, weight: 100, chance: 1, count: [1, 1] })),
          bindDrops: false,
        },
      });

    /** cast 序号（服务端幂等账按 castId，自己数就行） */
    let castSeq = 0;

    /** 最近一次 `killOne` 没打成的真实原因（只报 null 的话，分不清「没怪」和「这一刀被拒」） */
    let lastKillError = "";

    /** 等到一只活着的怪（重生 1500ms 一拍，等不到返回 null） */
    const aliveMobOf = async (player, mapId) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await player.session.joinWorld(mapId);
        // 靶子挑「编号最小的活怪」：图 3 重铺刷怪区后第一个实例是 10 级 boss，
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

    /** 角色被打死了就复活（这一套要的是「还能继续打」；死亡判定本身有专门的套件在验） */
    const reviveOf = async (player) => {
      const revived = await api(baseUrl, "POST", `roles/${player.roleId}/revive`, { token: player.token });
      if (revived.code !== 0) lastKillError = `复活失败：${revived.code} ${revived.message || ""}`.trim();
      await sleep(300);
    };

    /**
     * 打一只活着的怪，返回击杀那次的结算（打不成返回 null，原因留在 `lastKillError`）
     *
     * 打不成**不是**立刻放弃整段准备：怪会游走（快照里的坐标一过期，下一刀就被距离拒掉）、
     * 会被前面那段打空、也会卡在冷却上 —— 这些都不影响**换一只**再来。这一步要的是
     * 「地上出现一件掉落」，不是「这一只怪必须一刀死」。所以最多换 3 只、总时长封在 40 秒。
     *
     * 站在怪堆里连打二十来刀，被怪打死是常态（cast 回 `dead`）—— 那种情况先复活再换下一只，
     * 否则后面每一段都会跟着报「没打成」，红在准备上却像是掉落语义坏了。
     */
    const killOne = async (player, mapId = "3", goodIds = ["drug_hp_1"]) => {
      const deadline = Date.now() + 40_000;
      for (let target = 0; target < 3 && Date.now() < deadline; target += 1) {
        const mob = await aliveMobOf(player, mapId);
        if (!mob) {
          lastKillError = `等了 12 秒没等到活怪（mapId=${mapId}）`;
          return null;
        }
        await patchDropOf(mob.monsterKey, goodIds);
        // 站在怪旁边上报位置：拾取距离闸读的是这份坐标
        const stand = JSON.stringify({ type: "pos", data: { mapId, x: mob.x, y: mob.y, hp: 100 } });
        player.session.socket.send(stand);
        player.session.socket.send(stand);
        for (let i = 0; i < 80 && Date.now() < deadline; i += 1) {
          await paceCast();
          const castId = ++castSeq;
          player.session.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }));
          const settle = await player.session.waitSettle(castId);
          if (!settle) {
            lastKillError = `castId=${castId} 没收到结算帧`;
            break;
          }
          if (!settle.ok) {
            lastKillError = `cast 被拒：${settle.code || ""} ${settle.message || ""}`.trim();
            if (settle.code === "dead") await reviveOf(player);
            break;
          }
          if (settle.killed) {
            lastKillError = "";
            return settle;
          }
        }
        // 这一只没打成：等半拍换下一只（重新取快照 = 拿到怪此刻的位置）
        await sleep(500);
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
    check(/^d_\d+_\d+_\d+$/.test(aliceDrop), "A：dropId 是「d_<区>_<图>_<序号>」形态（区与图都在 id 里）", aliceDrop);

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
        aliceRow.map_id === "3" &&
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

    // 终态流水（#803）：攒批写（100ms 一拍），所以等而不是立刻查
    const pickedRecord = await waitFor("捡走之后出现一条 picked 流水", async () => {
      const hits = recordsOf(dbPath, aliceDrop2, "picked");
      return hits.length > 0 ? hits[0] : null;
    }, 5_000);
    check(!!pickedRecord, "B：捡走写了一条 picked 流水（这件东西最后去哪了有据可查）", JSON.stringify(pickedRecord));
    check(
      !!pickedRecord && pickedRecord.picked_name === bob.name && typeof pickedRecord.picked_account_id === "string" && pickedRecord.picked_account_id.length > 0,
      "B：流水记了捡走的人（picked_name / picked_account_id，角色被删也查得出是谁）",
      JSON.stringify(pickedRecord && { name: pickedRecord.picked_name, account: pickedRecord.picked_account_id }),
    );
    check(
      !!pickedRecord && !!takenByBob && pickedRecord.good_id === takenByBob.goodId && pickedRecord.count === takenByBob.count,
      "B：流水里的物品 / 件数 = 拾取应答里的（同一次操作，两处不各自算）",
      JSON.stringify(pickedRecord && { good: pickedRecord.good_id, count: pickedRecord.count, response: takenByBob && { good: takenByBob.goodId, count: takenByBob.count } }),
    );
    check(
      !!pickedRecord && typeof pickedRecord.good_label === "string" && pickedRecord.good_label.length > 0 &&
        typeof pickedRecord.good_type === "string" && pickedRecord.good_type.length > 0 &&
        typeof pickedRecord.monster_label === "string" && pickedRecord.monster_label.length > 0,
      "B：物品名 / 物品类型 / 怪物名都冗余进流水（配置日后被删，这条记录仍要能看懂）",
      JSON.stringify(pickedRecord && { label: pickedRecord.good_label, type: pickedRecord.good_type, monster: pickedRecord.monster_label }),
    );
    check(
      !!pickedRecord && pickedRecord.monster_key.length > 0 && pickedRecord.monster_instance_id.length > 0,
      "B：流水带来源怪物（key + 实例 id，排查「哪只怪掉太多」用）",
      JSON.stringify(pickedRecord && { key: pickedRecord.monster_key, instance: pickedRecord.monster_instance_id }),
    );
    check(
      !!pickedRecord && pickedRecord.lived_ms === pickedRecord.resolved_at - pickedRecord.created_at,
      "B：lived_ms 就是 resolved_at - created_at（管理端按存活时长排序，不自己减）",
      JSON.stringify(pickedRecord && { lived: pickedRecord.lived_ms, created: pickedRecord.created_at, resolved: pickedRecord.resolved_at }),
    );
    check(
      !!pickedRecord && pickedRecord.reason === null,
      "B：picked 行的 reason 为 null（细分列只有 overflow 用得上）",
      JSON.stringify(pickedRecord && pickedRecord.reason),
    );

    const restored = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { protectMs: protectBefore } },
    });
    check(restored.code === 0, "B：保护期已还原成改之前的值", restored.message);

    //#region 三点五、校验消息全中文（#1172）

    group("三点五、校验消息全中文（#1172：DTO 自带 message，不落英文默认模板）");

    const ttlTooLow = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { ttlMs: 5000 } },
    });
    check(
      ttlTooLow.code === 40000 && /掉落存活时长至少 10 秒/.test(ttlTooLow.message) && !/must /.test(ttlTooLow.message),
      "A：ttlMs=5000 → 40000 且消息是中文（含「掉落存活时长至少 10 秒」，不是 must not be less than）",
      JSON.stringify(ttlTooLow && { code: ttlTooLow.code, message: ttlTooLow.message }),
    );
    const capTooLow = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { maxGroundPerMap: 5 } },
    });
    check(
      capTooLow.code === 40000 && /单图地面上限至少 20 件/.test(capTooLow.message) && !/must /.test(capTooLow.message),
      "A：maxGroundPerMap=5 → 40000 且消息是中文（含「单图地面上限至少 20 件」）",
      JSON.stringify(capTooLow && { code: capTooLow.code, message: capTooLow.message }),
    );

    //#endregion

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

    const expiredRecord = await waitFor("过期之后出现一条 expired 流水", async () => {
      const hits = recordsOf(dbPath, expireDrop, "expired");
      return hits.length > 0 ? hits[0] : null;
    }, 5_000);
    check(!!expiredRecord, "B：过期写了一条 expired 流水（没人捡走也要留痕）", JSON.stringify(expiredRecord));
    check(
      !!expiredRecord && expiredRecord.picked_name === null && expiredRecord.picked_account_id === null,
      "B：expired 行没有拾取人（三个 picked_* 列都是 null）",
      JSON.stringify(expiredRecord && { name: expiredRecord.picked_name, account: expiredRecord.picked_account_id }),
    );
    check(
      !!expiredRecord && expiredRecord.lived_ms === expiredRecord.resolved_at - expiredRecord.created_at,
      "B：expired 行的存活时长同样自洽",
      JSON.stringify(expiredRecord && { lived: expiredRecord.lived_ms, created: expiredRecord.created_at, resolved: expiredRecord.resolved_at }),
    );

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

    //#region 四之二、挤掉（overflow：超单图上限时挤掉最旧的）

    group("四之二、挤掉：超单图上限时最旧的被挤掉（dropRemove reason=overflow + 流水 reason=auto）");

    // 上限的下限是 20（#802 定下的夹逼：配 0 或 3 会被夹成 20），所以得造够 21 件才挤得动。
    // TTL 拉回 180 秒：这一批要在攒够之前一直躺着（过期是另一条路径，别混进来）。
    const overflowParams = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE, body: { drop: { ttlMs: 180_000, protectMs: 0, maxGroundPerMap: 20 } },
    });
    check(overflowParams.code === 0, "A：单图上限压到 20 件、TTL 拉回 180 秒（改完立即生效，只影响新掉落）", overflowParams.message);

    // 一次击杀掉 6 件**不同**物品：同物品会被 rollDropTable 合并成一条，件数就不涨了
    const drugList = await api(baseUrl, "GET", "admin/drugs?size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    const goodIds = ((drugList.data && drugList.data.list) || []).map((item) => item.id).slice(0, 6);
    check(goodIds.length >= 6, "A：取到 6 种药品 id（一次击杀掉 6 件，几枪就攒够上限）", JSON.stringify(goodIds));

    const overflowPool = [];
    for (let round = 0; round < 10 && overflowPool.length <= 20; round += 1) {
      const killed = await killOne(alice, "3", goodIds);
      if (!killed) break;
      for (const entry of (killed.reward && killed.reward.drops) || []) {
        if (typeof entry.dropId === "string" && entry.dropId) overflowPool.push(entry.dropId);
      }
    }
    check(
      overflowPool.length > 20,
      "A：地上的件数已经超过单图上限（服务端最多留 20 件，多出来的必须被挤掉）",
      `共 ${overflowPool.length} 件${lastKillError ? `（最后一次没打成：${lastKillError}）` : ""}`,
    );

    const overflowFrame = await waitFor("溢出移除帧", async () => {
      const hit = alice.session.dropRemoves.find(
        (frame) => frame.reason === "overflow" && (frame.dropIds || []).some((id) => overflowPool.includes(id)),
      );
      return hit || null;
    }, 15_000);
    check(!!overflowFrame, "B：到点收到 dropRemove（reason=overflow，客户端据此移除节点）", JSON.stringify(overflowFrame));

    const overflowRecord = await waitFor("挤掉之后出现一条 overflow 流水", async () => {
      const hit = readRecordRows(dbPath).find((row) => row.result === "overflow" && overflowPool.includes(row.drop_id));
      return hit || null;
    }, 10_000);
    check(!!overflowRecord, "B：挤掉也写一行流水（result=overflow）", JSON.stringify(overflowRecord));
    check(
      !!overflowRecord && overflowRecord.reason === "auto",
      "B：reason=auto（与 #805 的管理端清空 manual_clear 区分开：一个是产出过剩，一个是人为操作）",
      JSON.stringify(overflowRecord && overflowRecord.reason),
    );
    check(
      !!overflowRecord && overflowRecord.lived_ms === overflowRecord.resolved_at - overflowRecord.created_at,
      "B：overflow 行的存活时长同样自洽",
      JSON.stringify(overflowRecord && { lived: overflowRecord.lived_ms, created: overflowRecord.created_at, resolved: overflowRecord.resolved_at }),
    );
    const overflowGhost = overflowRecord ? readDropRows(dbPath).filter((row) => row.drop_id === overflowRecord.drop_id) : [];
    check(overflowGhost.length === 0, "B：被挤掉的那件投影行已删除（不会留下捡不起来的幽灵行）", JSON.stringify(overflowGhost));

    //#endregion

    //#region 五、重启清场

    group("五、重启清场：实时进程重启后地面清空，world_drops 无残留");

    // 先在地上留一件（谁都不捡），再重启
    const killedBeforeRestart = await killOne(alice);
    const survivor = dropIdOf(killedBeforeRestart);
    check(!!survivor, "A：重启前打出一件留在地上的掉落", lastKillError || survivor);
    if (survivor) await bob.session.waitSpawn(survivor);
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

    // 清场之前先把每行转成一条 restart_lost 流水（#803）：只删不记的话，
    // 「上一进程地上那些东西最后怎么了」就永远没人答得上来
    const restartRecords = readRecordRows(dbPath).filter((row) => row.result === "restart_lost");
    check(restartRecords.length > 0, "B：重启清场把残留的地面掉落转成了 restart_lost 流水（不是静默删掉）", `共 ${restartRecords.length} 条`);
    check(
      restartRecords.some((row) => row.drop_id === survivor),
      "B：重启前地上那一件（survivor）在流水里是 restart_lost",
      JSON.stringify(restartRecords.filter((row) => row.drop_id === survivor)),
    );
    check(
      restartRecords.every((row) => row.picked_name === null && row.resolved_at >= row.created_at && row.lived_ms === row.resolved_at - row.created_at),
      "B：restart_lost 行没有拾取人，存活时长同样自洽",
      JSON.stringify(restartRecords.slice(0, 3)),
    );

    // 新连接拿到的快照也必须是空的（客户端屏幕上不能立着捡不起来的东西）
    const reLogin = await api(restarted.baseUrl, "POST", "auth/login", { body: { username: "drop_alice", password: "pass1234" } });
    const reToken = reLogin.data && reLogin.data.token;
    const reTicket = await api(restarted.baseUrl, "POST", "realtime/ticket", { token: reToken });
    const reSession = connect(`${restarted.baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(reTicket.data.ticket)}`);
    await waitFor("重连握手成功", async () => (reSession.opened ? reSession : null));
    const reWorld = await reSession.joinWorld("3");
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
