#!/usr/bin/env node
/**
 * 自身 / 区域 / 群体技能专项 e2e（#824 / docs/37 B7）
 *
 * 结算原来只认「一只怪」当目标：第一句就是「没有 targetId → bad_request」，
 * 于是任何 `target_type ≠ 1` 的技能都进不来 —— 1008 十步一杀（区域 + 纯位移）等于不存在。
 * 这一套把新口径逐条钉死：
 *
 * 一、**单体回归**：1000 不带目标仍然 `bad_request`（放开非单体不能顺手把单体也放开）
 * 二、**区域 + 空系数 = 不掷伤害**：1008 带落点施放 → `ok` + `noDamage` + `hits: []`；
 *     紧接着再发一次被判 `cooldown` —— 证明它**真的过了六道闸并记了账**，
 *     而不是「无条件放行」那种假成功
 * 三、**命中集合由服务端算**：把 1009 半月弯刀改成 `target_type = 2`（群体），
 *     一次施放打中三只 —— 每只独立掷伤害、顶层字段等于最近那只
 * 四、**落点夹取**：把落点报到 2000px 外，仍然只打中身边这三只（服务端按 `skills.distance`
 *     截断落点；不截断的话中心在半个图外，三只一只都打不到）
 * 五、**一次施放打死多只**：每只各自带 reward（经验按各自等级差算、掉落各自抽），
 *     顶层 `reward` = 最近那只的；掉落账本合并成一份，`index 0..N-1` 都能拾、`index N` 报
 *     `unknown_drop`（客户端靠这个下标逐件拾取，两份账会让拾取指到别的怪身上）
 *
 * 图 1 上用「血改成 50 万」的怪做**非致命**命中（要看 hits 结构，不能被打死）；
 * 图 2 上用「1 血」的怪做**击杀**（要看 reward 与掉落账本）。
 * 两张图各三个刷怪区（0×0、min=max=1），位置确定才能量半径。
 *
 * 走的是 `dist/`，前置 `npm run build`。用法：npm run test:e2e:area-skill
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

/** 区域 / 群体技能的落点与半径（#824：半径复用 `skills.distance`） */
const REACH = 200;
/** 图 1：三只「打不死」的靶子，用来验命中集合与非致命伤害 */
const HIT_MAP = "1";
const HIT_CLUSTER = { key: "1", points: [{ x: 400, y: -400 }, { x: 470, y: -400 }, { x: 400, y: -470 }] };
/**
 * 图 3：三只「一刀就死」的靶子，用来验逐只奖励与掉落账本
 *
 * 不用图 2（王城）：那是 40 级图，1 级角色进不去（进图有等级门槛），worldJoin 会一直等不到 world 帧。
 * 图 3 是 1 级图，刷怪区在 prepareWorld 里整份换成我们要的三只。
 */
const KILL_MAP = "3";
// 坐标必须是**图内**（世界坐标 y ∈ [-H, 0]）：#850 起越界的落点会被钳到图边，
// 用正 y 铺靶子会被挪到 y = 0 那条线上，离作用点 700px —— 群体技能一只都打不到。
const KILL_CLUSTER = { key: "2", points: [{ x: 700, y: -700 }, { x: 760, y: -700 }, { x: 700, y: -760 }] };
/** 群体技能的冷却比 `paceCast()` 那 250ms 长（1009 的 action 是 stand，speedRate 更低）—— 单独等 */
const paceAoe = () => sleep(1_300);
/** 区域技能（空系数，纯位移）：服务端必须接受它并只记账 */
const DASH_SKILL = "1008";
/** 要改造成群体技能的技能（半月弯刀：本来就是横扫，系数 3.0 起） */
const AOE_SKILL = "1009";
/** 单体技能（回归用） */
const SINGLE_SKILL = "1000";
/** 掉落用物品（每个怪必掉 1 件，方便数账本里的条数） */
const DROP_GOOD = "material_hide";

//#region 断言小工具

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

const checkEqual = (actual, expected, label) =>
  check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

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
    await sleep(30);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 直接改库的小工具（服务端已起来之后再调：空库首启会用 config-sync.sql 整表灌一遍） */
function withDb(dbPath, work) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    work(db);
  } finally {
    db.close();
  }
}

/**
 * 两张图各摆三个「0×0 刷怪区」（落点恒等于中心点，`pickPointInArea`），
 * 并把这个技能改造成群体技能
 *
 * 0×0 是关键：刷怪区是一个矩形，宽度非 0 时落点随机 —— 位置飘了就没法量半径。
 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
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

    const seed = (mapId, cluster, label) => {
      db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(mapId);
      cluster.points.forEach((point, index) => {
        db.prepare(
          `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
           VALUES (?, ?, ?, 1, 1, ?, ?, 0, 0, ?)`,
        ).run(mapId, `${label} ${index + 1}`, cluster.key, point.x, point.y, Date.now());
      });
    };
    seed(HIT_MAP, HIT_CLUSTER, "区域命中");
    seed(KILL_MAP, KILL_CLUSTER, "区域击杀");

    // 图 1 的怪血厚到打不死（要验 hits 结构，不能在中途变成 target_dead）
    db.prepare("UPDATE monsters SET max_hp = ?, physical_defense_min = 0, physical_defense_max = 0 WHERE id = ?").run(500_000, HIT_CLUSTER.key);
    // 图 2 的怪 1 血（一刀必死，用来验逐只奖励与掉落账本）
    db.prepare("UPDATE monsters SET max_hp = ?, physical_defense_min = 0, physical_defense_max = 0 WHERE id = ?").run(1, KILL_CLUSTER.key);

    // 每只怪必掉 1 件（内联条目，不引用具名表 —— 抽多少件完全确定）
    const entries = JSON.stringify([{ goodId: DROP_GOOD, weight: 1, chance: 1, count: [1, 1] }]);
    for (const key of [HIT_CLUSTER.key, KILL_CLUSTER.key]) {
      db.prepare("DELETE FROM monster_drops WHERE monster_key = ?").run(key);
      db.prepare(
        `INSERT INTO monster_drops (monster_key, source, table_id, picks, entries, bind_drops, updated_at)
         VALUES (?, 'entries', '', 1, ?, 0, ?)`,
      ).run(key, entries, Date.now());
    }

    // 1009 半月弯刀 → 群体技能；半径用 distance（#824 的约定），系数放大到「一定有伤害」，
    // 蓝耗置 0：这一套不测耗蓝闸（e2e-cast-guard 专门测它），别让 1 级那点蓝把用例卡成 mp。
    // **走管理端接口改而不是改库**：结算读的 `skillOf` 是「启动时 + 管理端每次写操作之后」
    // 重装的（不走 1 秒 TTL），直接改库结算侧看不到。
    // 1008 十步一杀保持 `target_type = '0'` + 空系数（这是它的真实配置），只把蓝耗置 0。

    // 怪物 AI 放慢：这一套只看玩家的出手，怪不需要动也不需要打人
    const row = db.prepare("SELECT monster_ai FROM runtime_params WHERE id = 1").get();
    const raw = row && row.monster_ai ? JSON.parse(row.monster_ai) : {};
    db.prepare("UPDATE runtime_params SET monster_ai = ? WHERE id = 1").run(JSON.stringify({ ...raw, attackInterval: 60_000 }));
  });
}

/**
 * 把角色的背包铺成 4×10 空网格
 *
 * 新角色的 `data.bag` 是空数组（= 没有网格），`placeGoodsIntoBag` 遍历 0 行 → 一律 bag_full。
 * 走 PUT 改不动：`bag` 在服务端的独占字段名单里，上报值会被丢弃。
 */
function seedEmptyBag(dbPath, roleId) {
  const grid = JSON.stringify(Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null)));
  withDb(dbPath, (db) => {
    db.prepare("UPDATE roles SET data = json_set(data, '$.bag', json(?)) WHERE id = ?").run(grid, roleId);
  });
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
      ADMIN_REGISTER_CODE: "test-admin-code",
      JWT_SECRET: "e2e-area-skill-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 怪不动、不打人：位置与存活都由这一套自己控制
      MONSTER_AI_TICK_MS: "1000",
      MONSTER_AI_BROADCAST_MS: "200",
      WORLD_RESPAWN_MS: "60000",
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

/** 一条会话化的 WS 连接：收 settle / world / picked，发 cast / pick / pos */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    pickeds: [],
    seq: 0,
    /** 发一发，返回它的 castId（不等结果） */
    fire(body) {
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return castId;
    },
    async settleOf(castId) {
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) || null);
    },
    sendPos(mapId, x, y, hp = 500) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: false } }));
    },
    async joinWorld(mapId, timeoutMs = 10_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => session.worlds.slice(before).filter((frame) => frame.mapId === mapId).pop() ?? null,
        timeoutMs,
      );
    },
    sendPick(castId, index) {
      socket.send(JSON.stringify({ type: "pick", data: { castId, index } }));
    },
    async pickedOf(castId, index) {
      return waitFor(
        `pick castId=${castId} index=${index}`,
        async () => session.pickeds.find((frame) => frame.castId === castId && frame.index === index) || null,
      );
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
      if (frame.type === "picked") session.pickeds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 站在点位上报位置（区域技能的作用点参照系），连送几拍确保服务端收到了 */
async function standAt(session, mapId, point) {
  for (let i = 0; i < 4; i += 1) {
    session.sendPos(mapId, point.x, point.y);
    await sleep(80);
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-area-skill-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：管理员 / 玩家 / 两张图的靶子");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_area", password: "pass1234", registerCode: "test-admin-code" },
    });
    check(superAdmin.code === 0 && !!superAdmin.data.token, "准备：注册管理员拿到令牌", superAdmin.message);
    const adminToken = superAdmin.data && superAdmin.data.token;

    // 把 1009 改造成群体技能（走管理端接口：结算读的技能表是「启动时 + 管理端写操作后」重装的）
    const patchedAoe = await api(baseUrl, "PATCH", `admin/skills/${AOE_SKILL}`, {
      token: adminToken,
      body: {
        targetType: "2",
        distance: REACH,
        mpCost: 0,
        damageCoefficients: [{ baseType: "physicalAttack", baseTypeRate: 100 }],
      },
    });
    check(patchedAoe.code === 0, `准备：把 ${AOE_SKILL} 改成群体技能（target_type=2、半径 ${REACH}）`, patchedAoe.message);
    const patchedDash = await api(baseUrl, "PATCH", `admin/skills/${DASH_SKILL}`, { token: adminToken, body: { mpCost: 0 } });
    check(patchedDash.code === 0, `准备：把 ${DASH_SKILL} 的蓝耗置 0（这一套不测耗蓝闸）`, patchedDash.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "area_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "区域测试", occupation: "1", sex: "1" } });
    check(!!(token && created.data && created.data.id), "准备：账号与角色已建好", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");
    const hitWorld = await session.joinWorld(HIT_MAP);
    const hitTargets = ((hitWorld && hitWorld.monsters) || []).filter((mob) => mob.alive);
    checkEqual(hitTargets.length, 3, "图 1 播出了三只靶子（三个 0×0 刷怪区各一只）");
    await standAt(session, HIT_MAP, HIT_CLUSTER.points[0]);
    //#endregion

    //#region 一、单体回归
    group("一、单体回归：没有目标的单体技能仍然被拒（放开非单体不能顺手把单体也放开）");

    const noTarget = await (async () => {
      const id = session.fire({ skillId: SINGLE_SKILL, targetId: "", monsterKey: "" });
      return session.settleOf(id);
    })();
    checkEqual(noTarget && noTarget.code, "bad_request", "1000 不带目标 → bad_request");
    check(!noTarget || noTarget.ok !== true, "这一发没有任何结算结果（ok 不为 true）");

    await paceCast();
    const singleTarget = hitTargets[0];
    const singleOk = await (async () => {
      const id = session.fire({ skillId: SINGLE_SKILL, targetId: singleTarget.instanceId, monsterKey: singleTarget.monsterKey });
      return session.settleOf(id);
    })();
    check(!!(singleOk && singleOk.ok) && singleOk.damage > 0, "1000 带目标照常结算（ok + 伤害 > 0）", singleOk && `damage=${singleOk.damage}`);
    checkEqual(singleOk && singleOk.hits, undefined, "单体结算**不带** hits 字段（客户端据此区分单目标与群体）");
    //#endregion

    //#region 二、区域 + 空系数 = 不掷伤害，但真的过闸记账
    group("二、区域技能（1008 十步一杀：target_type=0、空系数）→ ok + noDamage，且冷却真的记上了");

    await paceCast();
    const dashCastId = session.fire({ skillId: DASH_SKILL, targetId: "", monsterKey: "", x: 500, y: -400 });
    const dash = await session.settleOf(dashCastId);
    check(!!(dash && dash.ok), "1008 不再 bad_request（这一条就是 #824 的验收）", dash && JSON.stringify(dash).slice(0, 160));
    checkEqual(dash && dash.noDamage, true, "回执带 noDamage（客户端不要拿它改血条）");
    check(Array.isArray(dash && dash.hits) && dash.hits.length === 0, "hits 是空数组（区域技能带 hits，只是没打中）", JSON.stringify(dash && dash.hits));
    checkEqual(dash && dash.damage, 0, "damage 是 0 占位");
    checkEqual(dash && dash.killed, false, "killed 是 false");

    // 立刻再发一次：冷却闸会拒 —— 证明上一发**真的过闸并记了账**（而不是无条件放行）
    const again = await (async () => {
      const id = session.fire({ skillId: DASH_SKILL, targetId: "", monsterKey: "", x: 500, y: -400 });
      return session.settleOf(id);
    })();
    checkEqual(again && again.rejected, "cooldown", "同一技能连发被判冷却（说明上一发确实记了冷却）");
    //#endregion

    //#region 三、群体命中集合由服务端算
    group(`三、群体技能（${AOE_SKILL} 改成 target_type=2，半径 ${REACH}）一次打中三只`);

    const center = HIT_CLUSTER.points[0];
    // 位置样本 3 秒过期（PlayerPresenceService 的「位置超时」）：区域技能的服务端夹取要读它，
    // 所以每次施放前重报一次 —— 隔了几段用例之后旧样本早失效了
    await standAt(session, HIT_MAP, center);
    await paceAoe();
    const aoeCastId = session.fire({ skillId: AOE_SKILL, targetId: "", monsterKey: "", x: center.x, y: center.y });
    const aoe = await session.settleOf(aoeCastId);
    check(!!(aoe && aoe.ok), `${AOE_SKILL} 施放成功`, aoe && JSON.stringify(aoe).slice(0, 160));
    check(Array.isArray(aoe && aoe.hits) && aoe.hits.length === 3, "hits 里正好三只（半径内的全部命中）", aoe && JSON.stringify((aoe.hits || []).map((hit) => hit.targetId)));
    const hitIds = (aoe && aoe.hits ? aoe.hits : []).map((hit) => hit.targetId).sort();
    const worldIds = hitTargets.map((mob) => mob.instanceId).sort();
    check(
      hitIds.length === worldIds.length && hitIds.every((id, index) => id === worldIds[index]),
      "命中的就是场上这三只（服务端按自己持有的实例算，不听客户端报目标）",
      JSON.stringify(hitIds),
    );
    check(
      (aoe && aoe.hits ? aoe.hits : []).length === 3 && aoe.hits.every((hit) => hit.damage > 0 && hit.hp < hit.maxHp),
      "每只都各自扣了血（伤害逐只掷，不是一份结果套三只）",
      aoe && JSON.stringify((aoe.hits || []).map((hit) => `${hit.damage}/${hit.hp}`)),
    );
    check(
      !!aoe && !!aoe.hits && aoe.hits.length > 0 && aoe.targetId === aoe.hits[0].targetId && aoe.damage === aoe.hits[0].damage && aoe.hp === aoe.hits[0].hp,
      "顶层字段等于最近那只（旧客户端只看这几个字段也不至于什么都不显示）",
      aoe && `target=${aoe.targetId} damage=${aoe.damage}`,
    );

    // 落点报远：服务端按 skills.distance 夹回身边 —— 不夹的话中心在半个图外，三只一只都打不到
    await standAt(session, HIT_MAP, center);
    await paceAoe();
    const farCastId = session.fire({ skillId: AOE_SKILL, targetId: "", monsterKey: "", x: center.x + 2000, y: center.y });
    const far = await session.settleOf(farCastId);
    // 不断「恰好三只」：落点被夹到玩家身边 200px 处，三只靶子里本来就有一只正好在 212px 外，
    // 而怪还会游走 —— 断死只数就是拿运气当契约。要断的是**夹取生效**：中心被拉回身边，
    // 所以还能打到人；不夹的话中心在 2000px 外，一只都进不了半径。
    const farHitIds = (far && far.hits ? far.hits : []).map((hit) => hit.targetId);
    check(
      farHitIds.length > 0 && farHitIds.every((id) => worldIds.indexOf(id) >= 0),
      "落点报到 2000px 外仍然打得到身边的怪（服务端把落点夹到作用半径内；不夹则一只都打不到）",
      far && JSON.stringify(farHitIds),
    );
    // 跨图（#861 之后改断「伪造帧被丢弃」）：作用点的地图来自在场表，而在场表的图
    // **只由 worldJoin 写** —— 自报换图的 pos 帧会被整帧丢弃，改包再也挪不动作用点。
    // `cross_map` 那道闸保留为兜底（在场表与服务端位置理论上不会不一致），
    // 所以这里不能再去断 `rejected === "cross_map"` —— 那正好是「洞在上游被堵住」的证据。
    const worldsBeforeForge = session.worlds.length;
    await standAt(session, KILL_MAP, { x: 0, y: 0 });
    // 在场表 3 秒收不到**有效** pos 就把条目当离场删掉（伪造帧不刷新 `updatedAt`，
    // 那正是 #861 的要点），而这条用例前后两个 `paceAoe` 加起来已经够 3 秒 ——
    // 不补一帧有效位置，`areaSpotOf` 拿到的是 null，断到的就成了「人超时离场」而不是
    // 「伪造帧被丢弃」。补的这一帧回的是原来的坐标，作用点没被挪动
    session.sendPos(HIT_MAP, center.x, center.y);
    await sleep(80);
    await paceAoe();
    // 落点报「中心 +400」（会被夹到 +200，与上面「报远」那一段同一落点）：这一段要断的是
    // **作用点的地图**有没有被伪造帧搬走，不是「报 (0,0) 还能不能打到人」——
    // 报 (0,0) 会把作用点整体挪到另一个方向，靶子可能一只都不在半径内，
    // 断到的就成了「没打到」而不是「打到了图 1 的怪」
    const crossCastId = session.fire({ skillId: AOE_SKILL, targetId: "", monsterKey: "", x: center.x + 400, y: center.y });
    const cross = await session.settleOf(crossCastId);
    check(
      !!cross && cross.ok === true && cross.rejected === undefined,
      "自报换图的 pos 帧被丢弃：作用点仍在放行过的图（不判 cross_map）",
      JSON.stringify(cross && { ok: cross.ok, rejected: cross.rejected, hits: (cross.hits || []).length }),
    );
    // 作用点还在图 1：打到的仍然是图 1 的靶子（伪造帧没能把作用点搬到 KILL_MAP）
    const crossHitIds = ((cross && cross.hits) || []).map((hit) => hit.targetId);
    check(crossHitIds.length > 0 && crossHitIds.every((id) => worldIds.indexOf(id) >= 0), "打中的仍是图 1 的实例（作用点没被搬到别的图）", JSON.stringify(crossHitIds));
    checkEqual(session.worlds.length, worldsBeforeForge, "伪造帧不触发 world 帧（没进过那张图）");
    // 回到图 1：后面的用例还要在这张图上出手
    await standAt(session, HIT_MAP, HIT_CLUSTER.points[0]);
    //#endregion

    //#region 四、一次施放打死多只：逐只奖励 + 掉落账本合并
    group("四、群体击杀（图 2，1 血怪）：逐只 reward + 掉落账本合并成一份");

    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 3 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "3");
    const killWorld = await session.joinWorld(KILL_MAP);
    const killTargets = ((killWorld && killWorld.monsters) || []).filter((mob) => mob.alive);
    checkEqual(killTargets.length, 3, "图 2 播出了三只 1 血靶子");
    const killCenter = KILL_CLUSTER.points[0];
    await standAt(session, KILL_MAP, killCenter);
    await paceAoe();
    const killCastId = session.fire({ skillId: AOE_SKILL, targetId: "", monsterKey: "", x: killCenter.x, y: killCenter.y });
    const kill = await session.settleOf(killCastId);
    check(Array.isArray(kill && kill.hits) && kill.hits.length === 3, "一次施放命中三只", kill && JSON.stringify((kill.hits || []).map((hit) => hit.targetId)));
    check(
      (kill && kill.hits ? kill.hits : []).length === 3 && kill.hits.every((hit) => hit.killed === true),
      "三只全被打死（1 血怪吃什么伤害都死）",
      kill && JSON.stringify((kill.hits || []).map((hit) => `${hit.damage}/${hit.hp}`)),
    );
    check(
      (kill && kill.hits ? kill.hits : []).length === 3 && kill.hits.every((hit) => hit.reward && typeof hit.reward.exp === "number"),
      "每只各自带一份 reward（经验按各自等级差算、掉落各自抽）",
      kill && JSON.stringify((kill.hits || []).map((hit) => hit.reward && hit.reward.exp)),
    );
    check(
      !!kill && !!kill.reward && !!kill.hits && kill.hits.length === 3 && !!kill.hits[0].reward && kill.reward.exp === kill.hits[0].reward.exp,
      "顶层 reward 是最近那只的（兼容只看顶层的旧客户端）",
      kill && `top=${kill.reward && kill.reward.exp} first=${kill.hits && kill.hits[0] && kill.hits[0].reward && kill.hits[0].reward.exp}`,
    );

    // 拾取前先给背包一个网格：新角色的 `data.bag` 是**空数组**（= 没有网格），那种存档里
    // 任何拾取都会被判 bag_full（服务端不扩容，语义与商城一致）。
    // 直接改库而不是走 `PUT roles/:id`：`bag` 在服务端的「独占字段」名单里，
    // 客户端上报会被丢弃（日志会留一条「已按库中值为准」），PUT 改不动它。
    seedEmptyBag(dbPath, created.data.id);
    const afterBag = await api(baseUrl, "GET", `roles/${created.data.id}`, { token });
    const bagRows = afterBag.data && afterBag.data.data && afterBag.data.data.bag;
    check(
      Array.isArray(bagRows) && bagRows.length === 4 && Array.isArray(bagRows[0]) && bagRows[0].length === 10,
      "准备：背包已铺成 4×10 空网格（否则拾取一律 bag_full）",
      Array.isArray(bagRows) ? `${bagRows.length}×${bagRows[0] && bagRows[0].length}` : JSON.stringify(bagRows),
    );

    // 掉落账本：三只各掉 1 件，合并成一份（拾取帧只有 castId + index，没有 targetId）
    const dropCount = (kill && kill.hits ? kill.hits : []).reduce((sum, hit) => sum + ((hit.reward && hit.reward.drops.length) || 0), 0);
    checkEqual(dropCount, 3, "三只各掉 1 件，一共 3 件");

    const picked = [];
    for (let index = 0; index < dropCount; index += 1) {
      session.sendPick(killCastId, index);
      const result = await session.pickedOf(killCastId, index);
      picked.push(result ? (result.ok ? "ok" : result.code) : "timeout");
    }
    check(
      picked.length === dropCount && picked.every((item) => item === "ok"),
      "账本合并成一份：index 0..N-1 逐件都能拾（下标接着数，不是每只从 0 数）",
      JSON.stringify(picked),
    );

    session.sendPick(killCastId, dropCount);
    const overflow = await session.pickedOf(killCastId, dropCount);
    checkEqual(overflow && overflow.code, "unknown_drop", "index 越界报 unknown_drop（账本只装这次施放的掉落）");
    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 自身 / 区域 / 群体技能：${passed} 条通过 / ${failed} 条失败`);
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
