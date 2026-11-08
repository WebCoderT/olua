#!/usr/bin/env node
/**
 * 怪物 AI 服务端权威专项 e2e（server/test/e2e-monster-ai.cjs，issue #670）
 *
 * 这一套盯的是「同图两个人的画面是不是同一份事实」——客户端 #670 删掉本地 AI 之后，
 * 屏幕上的一切都必须来自服务端广播：
 *
 * 一、**别人的战斗也看得见血量**（#456）：A 出手打怪，同图观看者 B 在 monster-ai 帧里
 *     收到这只怪的 `hp/maxHp`（原来只有 settle 帧给出手者本人，B 的血条不动）
 * 二、**技能击退由服务端模拟**（#670）：带 `push_distance` 的技能命中后怪被推走
 *     （方向 = 施法者 → 怪），落点随普通位置广播下发
 * 三、**晚进图的人看到同一处**（#455）：C 在推完之后才进图，它的 world 快照坐标必须是
 *     怪**现在**的位置 —— 世界层给的出生点在通道发帧前被 AI 运行时坐标覆盖
 *     （站住不动的怪永远不会出现在增量帧里，只靠 monster-ai 帧的人会永远停在出生点）
 * 四、**目标倒下即放弃**（#454）：玩家被怪打死后再也收不到这只怪的命中，伤害型技能也
 *     不再 `casts`。关键在于**客户端还在上报 hp > 0**（伪造「我还活着」）——
 *     服务端不能靠客户端上报的血量判断目标是否还能打，只能认「结算返回 null」
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:monster-ai
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 两只有点位的怪：3 = 干尸行者（普通，65~79 血，够挨两下不死），200 = 长尾跳鼠怪（BOSS，主动、会放技能） */
const BRUISER = { key: "3", x: 100, y: -200 };
const BOSS = { key: "200", x: 400, y: -400 };

//#region 断言小工具（与 e2e-world / e2e-combat 同款口径）

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
 * 把地图 1 的刷怪区换成两块 **0×0** 的点位（#295：播种来源 = map_spawn_areas）
 *
 * 为什么是 0×0：`pickPointInArea` 在 w/h = 0 时落点恒等于中心点，怪物位置就是确定的 ——
 * 这一套要断言「推走多少」「谁在哪」，位置随机抖一下就没法比。必须在服务端就绪之后写
 * （空库首启会用 config-sync.sql 把配置表整表灌一遍，启动前写的行会被覆盖掉）。
 */
function seedSpawnAreas(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
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
  db.exec("DELETE FROM map_spawn_areas WHERE map_id = '1'");
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const [index, spot] of [BRUISER, BOSS].entries()) {
    insert.run("1", `${index + 1}号点位`, spot.key, 0, 1, spot.x, spot.y, 0, 0, now);
  }
  db.close();
}

/** 起一台服务（临时文件库：seedSpawnAreas 要能从外面改库）；AI tick/广播都调快，等待才不用按秒算 */
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
      JWT_SECRET: "e2e-monster-ai-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      MONSTER_AI_TICK_MS: "50",
      MONSTER_AI_BROADCAST_MS: "100",
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
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 一条会话化的 WS 连接（收集 settle / world / monster-ai 三类帧） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    aiFrames: [],
    /** 出手序号（每条连接独立计数，与 CombatSettlementService 的幂等账同一口径） */
    castSeq: 0,
    sendPos(mapId, x, y, hp) {
      session.socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: false } }));
    },
    /**
     * 发一次出手并等它的 settle 帧
     *
     * 出手前等一个间隔（`lib/cast-pace.cjs`）：#813 起服务端按真客户端口径判冷却，
     * 连发会拿到 `rejected: "cooldown"`。改成 async 之后调用点本来就在 `await`，形状不变。
     */
    async cast(skillId, targetId, monsterKey) {
      await paceCast();
      session.castSeq += 1;
      const castId = session.castSeq;
      session.socket.send(JSON.stringify({ type: "cast", data: { castId, skillId, targetId, monsterKey } }));
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) ?? null, 8_000);
    },
    async joinWorld(mapId) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => session.worlds.slice(before).find((frame) => frame.mapId === mapId) ?? null);
    },
    /** 某只怪在**这一帧之后**的最新一条 AI 位置（按帧序号取，避免读到旧帧） */
    latestAi(instanceId, fromIndex = 0) {
      for (let i = session.aiFrames.length - 1; i >= fromIndex; i -= 1) {
        const entry = session.aiFrames[i].monsters.find((m) => m.instanceId === instanceId);
        if (entry) return entry;
      }
      return null;
    },
    /** 从 fromIndex 帧起，这只怪的所有 AI 条目（血量断言用） */
    aiEntries(instanceId, fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) {
        for (const entry of session.aiFrames[i].monsters) {
          if (entry.instanceId === instanceId) out.push(entry);
        }
      }
      return out;
    },
    /** 从 fromIndex 帧起，所有命中事件 */
    hitsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...session.aiFrames[i].hits);
      return out;
    },
    /** 从 fromIndex 帧起，所有技能释放事件 */
    castsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...(session.aiFrames[i].casts ?? []));
      return out;
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
      if (frame.type === "monster-ai") session.aiFrames.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-monster-ai-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    seedSpawnAreas(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：三个账号与实时连接（世界是跨账号共享的，要三个视角）");
    const players = {};
    for (const name of ["a", "b", "c"]) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: `ai_player_${name}`, password: "pass1234" } });
      const token = registered.data && registered.data.token;
      await api(baseUrl, "POST", "roles", { token, body: { name: `观战${name.toUpperCase()}`, occupation: "1", sex: "1" } });
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor(`会话 ${name} 握手`, async () => (session.opened ? session : null));
      players[name] = { token, session };
    }
    check(!!players.a.session.opened && !!players.b.session.opened && !!players.c.session.opened, "准备：三个账号各自建好角色并连上实时通道");

    const sessionA = players.a.session;
    const sessionB = players.b.session;
    const sessionC = players.c.session;

    const worldA = await sessionA.joinWorld("1");
    check(!!(worldA && worldA.monsters.length === 2), "准备：地图 1 按两个 0×0 点位播种出 2 只怪", JSON.stringify(worldA && worldA.monsters.map((m) => m.monsterKey)));
    const bruiser = worldA.monsters.find((m) => m.monsterKey === BRUISER.key);
    const boss = worldA.monsters.find((m) => m.monsterKey === BOSS.key);
    check(!!bruiser && bruiser.x === BRUISER.x && bruiser.y === BRUISER.y, "准备：普通怪落在点位上（出生点 = 0×0 区域中心）", bruiser && `${bruiser.x},${bruiser.y}`);
    check(!!boss && boss.x === BOSS.x && boss.y === BOSS.y, "准备：BOSS 落在点位上", boss && `${boss.x},${boss.y}`);
    // B 先就位：它要在 A 出手的那一刻正在看这张图
    const worldB = await sessionB.joinWorld("1");
    check(!!worldB, "准备：观战者 B 已在同一张图上");
    //#endregion

    //#region 一、别人的战斗也看得见血量（#456）
    group("一、别人的战斗也看得见血量：出手者之外的观看者也能收到 hp");
    // A 站到普通怪旁边（150px：在 detectRange 200 内、attackRange 60 外 —— 怪会看着 A 但不至于贴脸）
    const aHp = 100;
    sessionA.sendPos("1", BRUISER.x + 150, BRUISER.y, aHp);
    await sleep(150);
    const framesBeforeHurt = sessionB.aiFrames.length;
    const hurt = await sessionA.cast("1000", bruiser.instanceId, BRUISER.key);
    check(!!hurt && hurt.ok && hurt.damage > 0, "A 的出手结算成功（伤害 > 0）", JSON.stringify(hurt));
    const visibleToB = await waitFor(
      "B 收到这只怪的新血量",
      async () => sessionB.aiEntries(bruiser.instanceId, framesBeforeHurt).find((entry) => entry.hp === hurt.hp) ?? null,
      8_000,
    );
    check(!!visibleToB, "同图观看者 B 在 monster-ai 帧里收到这只怪的血量（别人打的伤害也看得见）", visibleToB && `hp=${visibleToB.hp}`);
    check(!!visibleToB && visibleToB.maxHp === bruiser.maxHp, "血量条目带上上限（客户端画血条要用）", visibleToB && `maxHp=${visibleToB.maxHp}`);
    //#endregion

    //#region 二、击退由服务端模拟（#670）
    group("二、技能击退由服务端模拟：落点随普通位置广播下发");
    const framesBeforePush = sessionA.aiFrames.length;
    const pushed = await sessionA.cast("1001", bruiser.instanceId, BRUISER.key);
    check(!!pushed && pushed.ok, "带 push 的技能（1001，push_distance = 120）结算成功", JSON.stringify(pushed));
    const movedEntry = await waitFor(
      "A 收到这只怪被推走的位置",
      async () => {
        const entry = sessionA.latestAi(bruiser.instanceId, framesBeforePush);
        return entry && entry.x <= BRUISER.x - 40 ? entry : null;
      },
      8_000,
    );
    check(!!movedEntry, "怪物被推离原位（服务端位移 + 位置广播，不需要新协议帧）", movedEntry && `x=${movedEntry.x}`);
    // 位置广播是每 100ms 一拍，movedEntry 很可能取在推的半路上（击退时长 200ms）——
    // 等它停下来再量距离，否则量到的是「推了一半」
    const settledEntry = await waitFor(
      "击退走完后停在落点",
      async () => {
        const first = sessionA.latestAi(bruiser.instanceId, framesBeforePush);
        await sleep(200);
        const second = sessionA.latestAi(bruiser.instanceId, framesBeforePush);
        return first && second && Math.abs(first.x - second.x) < 0.5 ? second : null;
      },
      8_000,
    );
    const pushDistance = settledEntry ? BRUISER.x - settledEntry.x : 0;
    check(pushDistance >= 60 && pushDistance <= 180, "击退距离 = push_distance（120px）+ 一个 tick 的余量", `实测 ${pushDistance.toFixed(1)}px`);
    //#endregion

    //#region 三、晚进图的人看到同一处（#455）
    group("三、晚进图的人看到同一处：world 快照的坐标是实时位置，不是出生点");
    const liveX = settledEntry ? settledEntry.x : 0;
    const worldC = await sessionC.joinWorld("1");
    const seenByC = worldC && worldC.monsters.find((m) => m.instanceId === bruiser.instanceId);
    check(!!seenByC, "C 的 world 快照里有这只怪", seenByC && seenByC.instanceId);
    check(!!seenByC && seenByC.x !== BRUISER.x, "C 拿到的不是出生点（怪的「持久真相」是出生点，但它现在不在这儿）", seenByC && `x=${seenByC.x} 出生点=${BRUISER.x}`);
    check(!!seenByC && Math.abs(seenByC.x - liveX) <= 15, "C 的坐标与 A 屏幕上的一致（同图两个人看到同一处）", seenByC && `C=${seenByC.x} / A=${liveX}`);
    //#endregion

    //#region 四、目标倒下即放弃（#454）
    group("四、目标倒下即放弃：玩家死了就不再被命中，伤害型技能也不再释放");
    // 走到 BOSS 身边（主动怪，40px 在攻击距离 60 内）：让它开打；hp 一律报「满血」——
    // 这正是 #670 的现场：客户端的上报不可信，服务端只能认结算结果
    const bossX = BOSS.x + 40;
    let keepReporting = true;
    const reporter = (async () => {
      while (keepReporting) {
        sessionA.sendPos("1", bossX, BOSS.y, aHp);
        await sleep(120);
      }
    })();
    const deathHit = await waitFor(
      "A 被 BOSS 打死（命中帧里 hp = 0）",
      async () => sessionA.hitsFrom(0).find((hit) => hit.instanceId === boss.instanceId && hit.hp === 0) ?? null,
      25_000,
    );
    check(!!deathHit, "玩家被 BOSS 打到 hp = 0（服务端结算出来的死亡）", deathHit && `damage=${deathHit.damage}`);
    // 从这里开始算「尸体期」：A 继续上报 hp = 100（假装还活着），但服务端已经知道他死了。
    // 观察窗口要跨过至少一个完整的普攻间隔（出厂 2000ms）—— 少了就只是「还没来得及出手」
    const corpseFrom = sessionA.aiFrames.length;
    await sleep(5_000);
    const lateHits = sessionA.hitsFrom(corpseFrom);
    check(lateHits.length === 0, "目标倒下之后不再有命中（结算返回 null → 服务端把目标作废，不依赖客户端上报的血量）", `尸体期命中 ${lateHits.length} 条`);
    const lateDamageCasts = sessionA.castsFrom(corpseFrom).filter((cast) => cast.instanceId === boss.instanceId && cast.skillId === "9001");
    check(lateDamageCasts.length === 0, "也不再释放伤害型技能 9001（原来的实现是「结算不出来照样播 casts」）", `尸体期释放 ${lateDamageCasts.length} 次`);
    keepReporting = false;
    await reporter;
    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 怪物 AI 服务端权威：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
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
})();
