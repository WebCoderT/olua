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
/**
 * 四、**脱战与回家**（#853 / #858）：目标跑出牵引半径（600px）就放弃，直线走回出生点，
 *     途中不索敌；到家后回复待机 —— 而且**记恨一起清掉**（原来 `provoked` 只写不清，
 *     被动怪永久锁死第一个打它的人）
 * 五、**移动不穿墙**（#854）：击退也走碰撞，撞墙被挡则原地不动，任何一帧都不许进碰撞盒
 * 六、**无人看只冻结不删**（#857）：进出图不该白回血、白回出生点
 * 七、**AI 只吃仲裁后的坐标**（#855）：一份伪造的 `pos` 骗不动索敌
 * 八、**目标倒下即放弃**（#454）：玩家被怪打死后再也收不到这只怪的命中，伤害型技能也
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
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 两只有点位的怪：3 = 干尸行者（普通，65~79 血，够挨两下不死），200 = 长尾跳鼠怪（BOSS，主动、会放技能） */
const BRUISER = { key: "3", x: 200, y: -200 };
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
  // 击退参数不在这里直改库：技能配置是「启动装载 + 管理端写操作触发刷新」的缓存，
  // 直改库结算读不到（map_spawn_areas 能直改是因为播种 1 秒 TTL 现取库，两者口径不同）。
  // 1001 的 push_distance / push_chance 由主流程走管理端 PATCH（#826 第二批起不再锁出厂值）。
  // 怪物等级压到 0：撞飞有「施法者等级 > 怪物等级」的等级闸（#826），出厂干尸行者 level=2
  // 会把 1 级玩家的击退拦掉 —— 这套要测的是位移本身。怪物数值 1 秒 TTL 现取库，直改生效。
  // 血量拉到 10 万：79 血会被暴击一刀带走（killed 分支没有 push，二、三段全部连锁红）
  db.prepare("UPDATE monsters SET level = 0, max_hp = 100000 WHERE id IN ('3', '200')").run();
  db.close();
}

/**
 * 改一只怪的移动速度（`monster_presentation.move_speed`，AI 1 秒 TTL 现取库）
 *
 * 出厂表里 220 行怪几乎全是 `move_speed = 2`（占位值，运营还没配）——2px/s 的怪连
 * 600px 的牵引半径都走不出去，脱战与回家这两件事根本测不出来。这一套只把参与断言的
 * 两只怪调到「人跑得掉、怪走得回」的量级，不改数值断言（不锁具体速度）。
 */
function setMonsterSpeed(dbPath, monsterKey, moveSpeed) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE monster_presentation SET move_speed = ? WHERE id = ?").run(moveSpeed, monsterKey);
  } finally {
    db.close();
  }
}

/**
 * 分步走到目标点（**不能瞬移**）
 *
 * 在场表有最小仲裁（#596，`playerPosMaxSpeed` 默认 1000px/s）：一帧跨几百像素会被整帧
 * 丢掉，AI 也就看不到这个人离开。60px / 110ms ≈ 545px/s，稳定被接受。
 */
async function walk(session, from, to, hp, stepPx = 60, intervalMs = 110) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const distance = Math.hypot(dx, dy);
  const frames = Math.max(1, Math.ceil(distance / stepPx));
  for (let index = 1; index <= frames; index += 1) {
    session.sendPos("1", from[0] + (dx * index) / frames, from[1] + (dy * index) / frames, hp);
    await sleep(intervalMs);
  }
}

/**
 * 地图 1 的**左外墙**（`map_collisions` 里本来就有的四道围墙之一：`cx=0 / w=128`）
 *
 * 用它测「不穿墙」不用另造地形：墙就在出生点左边 136px，把怪往左推一定撞上。
 * 口径与 `map.service.walkGeometryOf` 一致（中心 + 宽高，含边界）。
 */
const LEFT_WALL = { cx: 0, cy: -4096, w: 128, h: 8320 };
const inLeftWall = (x, y) => Math.abs(x - LEFT_WALL.cx) <= LEFT_WALL.w / 2 && Math.abs(y - LEFT_WALL.cy) <= LEFT_WALL.h / 2;

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
      ADMIN_REGISTER_CODE: "test-mai-code",
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
    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");

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
    // 撞飞参数走管理端 PATCH（#826 第二批：出厂 push_distance 是运营数据，测试自配不锁值；
    // 管理端写操作触发 refreshAll，下一刀生效）
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_mai", password: "pass1234", registerCode: "test-mai-code" },
    });
    check(adminReg.code === 0 && !!adminReg.data.token, "准备：注册管理员（撞飞参数要走 PATCH）");
    const patched = await api(baseUrl, "PATCH", "admin/skills/1001", {
      token: adminReg.data && adminReg.data.token,
      body: { pushDistance: 120, pushChance: 1 },
    });
    check(patched.code === 0, "1001 的击退距离配成 120px、概率 1（必撞）");
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
    // 击退位移按「已推游标」补齐（#826 第二批）：无论 AI tick 几时落，窗口走完后总位移
    // 恒等于 push_distance —— 原实现按整个 tick 算步长，位移量 = 配置距离 ± 一个 tick
    // （tick 100ms 时是 0.5~2.5 倍），全看 tick 几时落。容差 ±15 吸收广播采样时机。
    check(pushDistance >= 105 && pushDistance <= 135, "击退距离 = push_distance（120px，位移不再随 tick 抖动）", `实测 ${pushDistance.toFixed(1)}px`);
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

    //#region 四、脱战与回家（#853 E3 / #858）
    group("四、脱战与回家：跑出牵引半径就放弃、走回出生点，记恨一起清掉");
    // 怪的速度调到 120px/s（出厂 2px/s 是占位值，走不出牵引半径，这一组只能空转）。
    // A 报位置的速度约 545px/s —— 人跑得掉、怪走得回，两边都够得着断言
    setMonsterSpeed(dbPath, BRUISER.key, 120);
    await sleep(1_300); // 展示缓存 1 秒 TTL
    const chaseFrom = sessionA.aiFrames.length;
    // 基准取**这一段开始那一刻**的位置：上一段把它推离了出生点，之后它又走回了家 ——
    // 拿出生点当基准会让阈值落在一个刚好够不着的距离上。必须在 A 开跑之前取
    const chaseBaseX = (sessionA.latestAi(bruiser.instanceId, 0) || { x: BRUISER.x }).x;
    const walkStartX = BRUISER.x + 150;
    sessionA.sendPos("1", walkStartX, BRUISER.y, aHp);
    await sleep(300);
    // 先打一下 = 重新记恨。**被动怪不会主动索敌**，而「有没有记恨」这种东西会在
    // 「目标上报超时 → `endChase`」时被一起清掉（#858 的另一个方向）—— 上一段的两次出手
    // 距今已经十几秒，靠它残留的记恨等于靠运气。不先记恨，「怪跟着走出来」这段会退化成
    // 「它在往出生点走」，脱战断言也就白断了
    const reProvokeBeforeChase = await sessionA.cast("1000", bruiser.instanceId, BRUISER.key);
    check(!!reProvokeBeforeChase && reProvokeBeforeChase.ok, "准备：跑开之前先打它一下（这一段要有记恨可脱）");
    // A 从 350 一路走到 1050（700px > 600px 牵引半径）
    await walk(sessionA, [walkStartX, BRUISER.y], [walkStartX + 700, BRUISER.y], aHp);
    // 判据走**帧历史**而不是「最新一帧」：`monster-ai` 帧只发有变化的怪，而这条用例等的
    // 是「路过出生点」这一瞬间 —— 回家的最后 20px 只走一两帧（180px/s），只读最新帧基本必错过。
    // 「走出来」的基准也取**这一段开始时的实际位置**（上一段把它推离了出生点，拿出生点当基线
    // 会让阈值落在一个刚好够不着的距离上）
    const entriesFrom = (from) => sessionA.aiEntries(bruiser.instanceId, from);
    const chased = await waitFor(
      "怪跟着走出来了一段（确实进入了追击）",
      async () => entriesFrom(chaseFrom).find((entry) => entry.x > chaseBaseX + 20) ?? null,
      8_000,
    );
    check(
      !!chased,
      "A 走开的过程中怪确实跟了过来（不是原地没动，否则脱战断言就没有意义）",
      chased && `x=${chased.x}（本段起点 ${chaseBaseX.toFixed(1)}）`,
    );
    const homeEntry = await waitFor(
      "脱战后走回出生点",
      async () =>
        entriesFrom(chaseFrom).find(
          (entry) => Math.abs(entry.x - BRUISER.x) <= 20 && Math.abs(entry.y - BRUISER.y) <= 20,
        ) ?? null,
      10_000,
    );
    check(
      !!homeEntry,
      "目标超出牵引半径后怪放弃追击并直线走回出生点（#853：原来会跨整图无限追下去）",
      homeEntry && `落点 ${homeEntry.x.toFixed(1)},${homeEntry.y.toFixed(1)} / 出生点 ${BRUISER.x},${BRUISER.y}`,
    );

    // #858：记恨跟着脱战一起清 —— 被动怪不该永久锁死第一个打它的人。
    // 判据用「有没有挨打」而不是「怪的坐标」：`monster-ai` 帧只发**有变化**的怪，
    // 站着不动的怪根本不会出现在帧里（读到 null 会把「没动」误判成「测试没跑」）。
    // 有记恨的话它会以 120px/s 从 150px 处走到 60px 再出手，1.5 秒内必有一次命中
    const calmFrom = sessionA.aiFrames.length;
    await walk(sessionA, [walkStartX + 700, BRUISER.y], [BRUISER.x + 150, BRUISER.y], aHp);
    for (let index = 0; index < 21; index += 1) {
      sessionA.sendPos("1", BRUISER.x + 150, BRUISER.y, aHp);
      await sleep(120);
    }
    const noChaseHits = sessionA.hitsFrom(calmFrom).filter((hit) => hit.instanceId === bruiser.instanceId);
    check(
      noChaseHits.length === 0,
      "脱战后 A 站回来（150px，在检测范围 200 内）怪**不再**主动追他（记恨已清，#858）",
      `命中 ${noChaseHits.length} 条`,
    );

    // 再打一下 = 重新记恨：被动怪仍然要能被触发（清记恨不能清成「以后都不理人」）
    const reProvokeFrom = sessionA.aiFrames.length;
    const reProvoke = await sessionA.cast("1000", bruiser.instanceId, BRUISER.key);
    check(!!reProvoke && reProvoke.ok, "A 再打它一下（重新记恨）", JSON.stringify(reProvoke && reProvoke.ok));
    const reProvokedHit = await waitFor(
      "被动怪重新追上来并打人",
      async () => sessionA.hitsFrom(reProvokeFrom).find((hit) => hit.instanceId === bruiser.instanceId) ?? null,
      12_000,
    );
    check(!!reProvokedHit, "重新记恨之后它又追上来打人了（#858 清的是「脱战后的旧账」，不是把人永久拉黑）", reProvokedHit && `damage=${reProvokedHit.damage}`);
    //#endregion

    //#region 五、移动不穿墙（#854 E4）
    group("五、移动不穿墙：击退也走碰撞，撞墙被挡就原地不动");
    // 撞飞距离放到 300px：怪在出生点附近（离左外墙 ~136px），这一下必然撞墙
    const pushedIntoWall = await api(baseUrl, "PATCH", "admin/skills/1001", {
      token: adminReg.data.token,
      body: { pushDistance: 300, pushChance: 1 },
    });
    check(pushedIntoWall.code === 0, "1001 的击退距离改成 300px（必然撞上左外墙）");
    const wallFrom = sessionA.aiFrames.length;
    const wallPush = await sessionA.cast("1001", bruiser.instanceId, BRUISER.key);
    check(!!wallPush && wallPush.ok, "带 300px 击退的技能结算成功");
    // 这一段要持续给 A 报位置：超过 3 秒没上报，AI 会按「位置上报超时」把他当离场（很正常的设计），
    // 但下一段要它有目标可追 —— 断供会让目标在观众不知情的情况下被清掉
    for (let index = 0; index < 6; index += 1) {
      sessionA.sendPos("1", BRUISER.x + 150, BRUISER.y, aHp);
      await sleep(120);
    }
    const wallEntries = sessionA.aiEntries(bruiser.instanceId, wallFrom);
    const enteredWall = wallEntries.filter((entry) => inLeftWall(entry.x, entry.y));
    check(enteredWall.length === 0, "没有任何一帧落在碰撞盒里（穿墙 = 帧出现在墙内）", `越界帧 ${enteredWall.length} 条`);
    const wallSettled = sessionA.latestAi(bruiser.instanceId, wallFrom);
    check(
      !!wallSettled && wallSettled.x >= LEFT_WALL.cx + LEFT_WALL.w / 2 - 1,
      "被墙挡住之后停在墙外（没有 300px 的位移，因为前面没路了）",
      wallSettled && `x=${wallSettled.x.toFixed(1)} 墙面 x=${LEFT_WALL.cx + LEFT_WALL.w / 2}`,
    );
    // 把撞飞距离改回来：后面的用例还要用它量「推得动」
    await api(baseUrl, "PATCH", "admin/skills/1001", { token: adminReg.data.token, body: { pushDistance: 120, pushChance: 1 } });
    //#endregion

    //#region 六、无人看只冻结不删（#857）
    group("六、无人看只冻结不删：进出图不该白回血、白回出生点");
    // 先打掉一点血、再让它「在追击中」被冻结：这两样都是运行时里的东西，删掉重建就全没了。
    // 等它走到 A 身边（350 - 攻击距离 60 ≈ 290，离出生点 90px）再冻 —— 位置要明显离开出生点，
    // 断言才有区分力（否则「保留」与「重建回出生点」看起来一样）
    sessionA.sendPos("1", BRUISER.x + 150, BRUISER.y, aHp);
    const frozenHurt = await sessionA.cast("1000", bruiser.instanceId, BRUISER.key);
    check(!!frozenHurt && frozenHurt.ok, "冻结前先打它一下（血量要比满血低）", frozenHurt && `hp=${frozenHurt.hp}`);
    // 一边等它走过来、一边持续上报（上报断了它会丢掉目标，见五那段的说明）
    for (let index = 0; index < 15; index += 1) {
      sessionA.sendPos("1", BRUISER.x + 150, BRUISER.y, aHp);
      await sleep(120);
    }
    const beforeFreeze = sessionA.latestAi(bruiser.instanceId, 0);
    check(
      !!beforeFreeze && Math.abs(beforeFreeze.x - BRUISER.x) >= 40,
      "冻结前怪已经追到 A 身边（位置明显离开出生点，后面的断言才有区分力）",
      beforeFreeze && `x=${beforeFreeze.x.toFixed(1)} 出生点 ${BRUISER.x}`,
    );
    // 三个人全部断开：这张图就没有观看者了 → AI 冻结（而不是把运行时删掉）。
    // B 也要断 —— 留一个人在图里就永远不触发冻结，这段就白测了
    for (const player of Object.values(players)) player.session.socket.close();
    await sleep(1_500);
    // A、B 各自换一条新连接重新进图（B 是后面「仲裁」那段要用的）
    const reTicket = await api(baseUrl, "POST", "realtime/ticket", { token: players.a.token });
    const backSession = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(reTicket.data.ticket)}`);
    await waitFor("A 重连握手", async () => (backSession.opened ? backSession : null));
    const reTicketB = await api(baseUrl, "POST", "realtime/ticket", { token: players.b.token });
    const backB = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(reTicketB.data.ticket)}`);
    await waitFor("B 重连握手", async () => (backB.opened ? backB : null));
    await backB.joinWorld("1");
    const worldBack = await backSession.joinWorld("1");
    const thawed = worldBack && worldBack.monsters.find((m) => m.instanceId === bruiser.instanceId);
    check(!!thawed, "重连之后同一只怪还在（实例 id 稳定）", thawed && thawed.instanceId);
    check(
      !!thawed && !!beforeFreeze && thawed.hp === beforeFreeze.hp,
      "冻结期间血量原地保留（进出图不白回血，#857）",
      thawed && beforeFreeze && `重连前 ${beforeFreeze.hp} / 重连后 ${thawed.hp}`,
    );
    check(
      !!thawed && !!beforeFreeze && Math.abs(thawed.x - beforeFreeze.x) <= 15,
      "冻结期间**位置也保留**（不是按出生点重建运行时 —— 这一条才真正区分「冻结」与「删掉重来」）",
      thawed && beforeFreeze && `重连前 x=${beforeFreeze.x.toFixed(1)} / 重连后 x=${thawed.x.toFixed(1)} / 出生点 ${BRUISER.x}`,
    );
    //#endregion

    //#region 七、AI 只吃仲裁后的坐标（#855）
    group("七、AI 只吃仲裁后的坐标：伪造的 pos 骗不动索敌，正常移动照样被看见");
    // BOSS 调快：它是不是在「朝伪造点走」必须看得出来（2px/s 的话两公里外也看不出差别）
    setMonsterSpeed(dbPath, BOSS.key, 300);
    await sleep(1_300);
    // A 挪远，别让 BOSS 的目标候选里混进他；B 先站到 1500px 外（在 BOSS 检测范围 200 之外）。
    // **两个都用「连发三帧」瞬移过去，不走过去**：BOSS 就站在 y = −400 这条线上，
    // 一步步走过去必然从它脸上经过 —— 主动怪会一路追着人跑（实测追到 x = 1451），
    // 等伪造帧那一拍它早就不在出生点附近，这条断言也就没有区分力了。
    // 位置仲裁对单帧瞬移拒收、**连续两帧超速就信任并重置基线**（#861），所以发三帧
    const teleport = async (session, x, y) => {
      for (let index = 0; index < 3; index += 1) {
        session.sendPos("1", x, y, aHp);
        await sleep(120);
      }
    };
    await teleport(backSession, BRUISER.x + 900, BRUISER.y);
    const bFarX = BOSS.x + 1_100;
    await teleport(backB, bFarX, BOSS.y);
    await sleep(400);
    const forgedFrom = backB.aiFrames.length;
    // 伪造一帧「瞬移到 BOSS 的检测范围边缘」（1100px / 110ms ≈ 10000px/s，远超仲裁上限，整帧丢弃）。
    // 落点选在**检测范围 200 内、攻击距离 60 外**：老实现（AI 读原始坐标）会当场追过去，
    // 而它追过去这件事只能从「位置朝那个点移动」看出来 —— 落在攻击距离内的话它一步都不用走
    backB.sendPos("1", BOSS.x + 150, BOSS.y, aHp);
    await sleep(120);
    backB.sendPos("1", bFarX, BOSS.y, aHp);
    await sleep(1_500);
    const forgedEntries = backB.aiEntries(boss.instanceId, forgedFrom);
    const movedTowardForge = forgedEntries.some((entry) => entry.x > BOSS.x + 60);
    check(
      !movedTowardForge,
      "伪造帧之后 BOSS 没有朝那个点走过去（AI 读的是仲裁后的坐标，#855）",
      `这段窗口里 ${forgedEntries.length} 帧，最远 x=${forgedEntries.reduce((max, entry) => Math.max(max, entry.x), BOSS.x).toFixed(1)}`,
    );
    const forgedHits = backB.hitsFrom(forgedFrom).filter((hit) => hit.instanceId === boss.instanceId);
    check(forgedHits.length === 0, "也没有对这个「瞬移过来的」玩家出手", `命中 ${forgedHits.length} 条`);
    // 回归：正常走过去还是会被发现（闸不能把所有人都挡住）
    const legitFrom = backB.aiFrames.length;
    await walk(backB, [bFarX, BOSS.y], [BOSS.x + 40, BOSS.y], aHp);
    const legitHit = await waitFor(
      "正常走近之后 BOSS 出手",
      async () => backB.hitsFrom(legitFrom).find((hit) => hit.instanceId === boss.instanceId) ?? null,
      12_000,
    );
    check(!!legitHit, "正常一步步走近的玩家仍然会被索敌并挨打（仲裁没有误杀正常移动）", legitHit && `damage=${legitHit.damage}`);
    // B 的任务到此为止：它站在 BOSS 身边会一直挨打，留着会让下一段「尸体期不许有命中」混进它的命中
    backB.socket.close();
    //#endregion

    //#region 八、目标倒下即放弃（#454）
    group("八、目标倒下即放弃：玩家死了就不再被命中，伤害型技能也不再释放");
    // 走到 BOSS 身边（主动怪，40px 在攻击距离 60 内）：让它开打；hp 一律报「满血」——
    // 这正是 #670 的现场：客户端的上报不可信，服务端只能认结算结果。
    // 注意这里用的是**重连之后的**连接（六那段把 A 断开又接回来了）
    const bossX = BOSS.x + 40;
    // 命中帧是**全图广播**的：不按受击账号过滤，就会把「B 在上一段被打死」当成 A 的死，
    // 于是「尸体期」从 A 还活着的时候开始算，窗口最后一条正好是 A 真正的死亡（假红）
    const meA = await api(baseUrl, "GET", "auth/me", { token: players.a.token });
    const aAccountId = meA.data && meA.data.id;
    check(typeof aAccountId === "string" && aAccountId.length > 0, "准备：拿到 A 的账号 id（下面按受击账号过滤命中帧）");
    const hitsOnA = (fromIndex) =>
      backSession.hitsFrom(fromIndex).filter((hit) => hit.instanceId === boss.instanceId && hit.accountId === aAccountId);
    let keepReporting = true;
    const reporter = (async () => {
      while (keepReporting) {
        backSession.sendPos("1", bossX, BOSS.y, aHp);
        await sleep(120);
      }
    })();
    const deathHit = await waitFor(
      "A 被 BOSS 打死（命中帧里 hp = 0）",
      async () => hitsOnA(0).find((hit) => hit.hp === 0) ?? null,
      25_000,
    );
    check(!!deathHit, "玩家被 BOSS 打到 hp = 0（服务端结算出来的死亡）", deathHit && `damage=${deathHit.damage}`);
    // 从这里开始算「尸体期」：A 继续上报 hp = 100（假装还活着），但服务端已经知道他死了。
    // 观察窗口要跨过至少一个完整的普攻间隔（出厂 2000ms）—— 少了就只是「还没来得及出手」
    const corpseFrom = backSession.aiFrames.length;
    await sleep(5_000);
    const lateHits = hitsOnA(corpseFrom);
    check(
      lateHits.length === 0,
      "目标倒下之后不再有命中（结算返回 null → 服务端把目标作废，不依赖客户端上报的血量）",
      `尸体期命中 ${lateHits.length} 条${lateHits.length > 0 ? `（${lateHits.map((hit) => `${hit.instanceId}→${hit.hp}`).join(", ")}）` : ""}`,
    );
    const lateDamageCasts = backSession.castsFrom(corpseFrom).filter((cast) => cast.instanceId === boss.instanceId && cast.skillId === "9001");
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
