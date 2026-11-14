#!/usr/bin/env node
/**
 * 物法分离专项 e2e（#823 / docs/37 A6）
 *
 * `CastPlan.baseType` 一直解析着却从没用过：怪物打玩家恒取 `physical_attack` 对 `physicalDefense`，
 * 于是「魔法怪」的难度全靠物理那条线走。这一套把三件事钉死：
 *
 * 把「吃的是哪一列」写成**相对关系**而不是数值区间（#966：只校验代码，不校验数据）：
 * 同一个玩家、同一套装备（物防 5000 / 魔防 ~6），只切换技能的 baseType 与怪物的攻击列 ——
 * 若两系走的是同一列，两次伤害会相等；能分出「法术伤害 > 物理伤害」，就说明各读各的列。
 *
 * 一、**物理技能打物防**：技能 baseType = physicalAttack → 伤害被 5000 物防吃掉大半
 * 二、**法术技能打魔防**：同一套装备只换 baseType = magicAttack → 伤害基本不被吃掉，
 *     必然大于第一条（物防 5000 一点没参与）
 * 三、**法攻配 0 视为未配**（拍板口径）：法师技能挂上去但 `magic_attack` 是 0 →
 *     该技能**整个跳过**（回落到普攻），服务端日志留一条 warn，不留「放了法术不掉血」的哑弹
 *
 * 玩家堆物防的做法：把一件装备的八项属性整份改成「物防 5000 / 魔防 0」再穿上 ——
 * 角色等级的 defense 曲线对两系是同一条（`defense_max`），不这样做就分不出「吃的是哪一列」。
 *
 * 走的是 `dist/`，前置 `npm run build`。用法：npm run test:e2e:element-damage
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 只有一只怪：长尾跳鼠怪（BOSS，aggressive、检测 200px；点位固定才好量距离） */
const BOSS = { key: "200", x: 400, y: -400 };
/** 唯一挂上去的伤害技能（9001 跃鼠猛击）；两个状态技能要删掉 —— 它们乘攻击 / 防御，会把伤害数值搅乱 */
const SKILL = "9001";
/** 玩家站的位置：离怪 60px（够得着技能 90 与普攻 60） */
const STAND = { x: BOSS.x, y: BOSS.y - 60 };
/** 测试装备：整份属性改成「物防 5000 / 魔防 0」 */
const GEAR = { id: "cloth_32", slot: "cloth" };

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

const waitFor = async (label, predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
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
 * 把地图 1 的刷怪区换成单点位，并把 BOSS 的技能表/节拍准备好
 *
 * 0×0 的刷怪区落点恒等于中心点（`pickPointInArea`），位置确定才能量「伤害吃了哪一列」。
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
    db.exec("DELETE FROM map_spawn_areas WHERE map_id = '1'");
    db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES ('1', '物法分离点位', ?, 0, 1, ?, ?, 0, 0, ?)`,
    ).run(BOSS.key, BOSS.x, BOSS.y, Date.now());

    // 只留一个伤害技能（挂载行的 cooldown 覆盖成 1 秒，别让 6 秒冷却拖长用例）
    db.exec("DELETE FROM monster_skills WHERE monster_key = '200'");
    db.prepare(`INSERT INTO monster_skills (monster_key, skill_id, priority, cooldown, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      BOSS.key,
      SKILL,
      1,
      1,
      Date.now(),
    );

    // 出手节拍调快（出厂 2000ms 的普攻间隔会让三段用例拖到十几秒）
    const row = db.prepare("SELECT monster_ai FROM runtime_params WHERE id = 1").get();
    const raw = row && row.monster_ai ? JSON.parse(row.monster_ai) : {};
    const next = { ...raw, attackInterval: 300, attackActionTime: 100, attackRange: 120 };
    db.prepare("UPDATE runtime_params SET monster_ai = ? WHERE id = 1").run(JSON.stringify(next));
  });
}

/** 怪物的三系攻击（其余列不动） */
function setMonsterAttack(dbPath, { physical, magic }) {
  withDb(dbPath, (db) => {
    db.prepare(
      `UPDATE monsters SET physical_attack_min = ?, physical_attack_max = ?,
                          magic_attack_min = ?, magic_attack_max = ? WHERE id = '200'`,
    ).run(physical, physical, magic, magic);
  });
}

/** 技能吃哪一系（写回 damage_coefficients；怪物不练级，取等级 1 那一条） */
function setSkillBaseType(dbPath, baseType) {
  withDb(dbPath, (db) => {
    db.prepare("UPDATE skills SET damage_coefficients = ? WHERE id = ?").run(JSON.stringify([{ baseType, baseTypeRate: 1 }]), SKILL);
  });
}

/** 起一台服务（临时文件库：用例要在服务起来之后改库） */
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
      JWT_SECRET: "e2e-element-damage-secret",
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

/** 一条会话化的 WS 连接（只收 monster-ai 与 world 帧） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    aiFrames: [],
    sendPos(mapId, x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: false } }));
    },
    async joinWorld(mapId) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(`mapId=${mapId} 的 world 帧`, async () => session.worlds.slice(before).find((frame) => frame.mapId === mapId) ?? null, 15_000);
    },
    hitsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...session.aiFrames[i].hits);
      return out;
    },
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
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "monster-ai") session.aiFrames.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

/** 建号 → 拿票 → 连实时 → 进图，并把角色提到「穿上测试装备」的状态 */
async function spawnPlayer(baseUrl, adminToken, name) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
  if (registered.code !== 0) throw new Error(`注册 ${name} 失败：${registered.message}`);
  const token = registered.data.token;
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: `法测${name.slice(-1).toUpperCase()}`, occupation: "1", sex: "1" } });
  if (created.code !== 0) throw new Error(`建号 ${name} 失败：${created.message}`);
  const roleId = created.data.id;

  // #859：新号没有位置记录时只准进新手村，而这一套全程在图 1 上打 ——
  // 用运营摆位（`onMap` 一并写 `mapAt`）把人放过去，比直接改库更贴近真实链路
  const placed = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { onMap: "1" } });
  if (placed.code !== 0) throw new Error(`摆位失败：${placed.message}`);

  const worn = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { equipments: { [GEAR.slot]: GEAR.id } } });
  if (worn.code !== 0) throw new Error(`穿装备失败：${worn.message}`);

  const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
  const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  await waitFor(`${name} 握手`, async () => (session.opened ? session : null), 15_000);
  const world = await session.joinWorld("1");
  return { token, roleId, session, world, derived: worn.data.derived };
}

/** 站在点位上报位置（AI 的目标检测输入），直到 predicate 满足或超时 */
async function standAndWait(session, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    session.sendPos("1", STAND.x, STAND.y, 100);
    const hit = await predicate();
    if (hit) return hit;
    await sleep(120);
  }
  check(false, "等命中（等待超时）");
  return null;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-element-damage-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：管理员 / 把测试装备改成「物防 5000、魔防 0」");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_element", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    // 改的是**变体行**不是基础件：`equipmentAttributesOf` 读 `equipment_variants`（每件基础件 15 行，
    // #655 起变体各自成行、改基础件不带动变体）。穿在身上的 id 解析到的就是变体那一行。
    const patchedGear = await api(baseUrl, "PATCH", `admin/equipment-variants/${GEAR.id}`, {
      token: adminToken,
      body: {
        attributes: {
          maxHp: 0,
          hpRecover: 0,
          physicalAttack: { min: 0, max: 0 },
          magicAttack: { min: 0, max: 0 },
          taoistAttack: { min: 0, max: 0 },
          physicalDefense: { min: 5000, max: 5000 },
          magicDefense: { min: 0, max: 0 },
          taoistDefense: { min: 0, max: 0 },
        },
      },
    });
    check(patchedGear.code === 0, `准备：把 ${GEAR.id} 的属性整份改成「物防 5000 / 魔防 0」`, patchedGear.message);
    //#endregion

    //#region 一、物理技能打物防
    group("一、物理技能打物防：怪攻 9000 撞上玩家物防 5000");
    setMonsterAttack(dbPath, { physical: 9000, magic: 0 });
    setSkillBaseType(dbPath, "physicalAttack");
    await sleep(1_300); // 技能缓存 TTL 1 秒：等它按新配置重建

    const playerA = await spawnPlayer(baseUrl, adminToken, "elem_a");
    const defenseA = playerA.derived.attributes;
    // 构造回读：5000 是我们刚写进装备的那一份（不是出厂配置），派生的下限得把它算进去
    check(Array.isArray(defenseA.physicalDefense) && defenseA.physicalDefense[1] >= 5000, "玩家侧物防确实被堆到 5000", JSON.stringify(defenseA.physicalDefense));
    // 两列真的分开：魔防不是我们写的 5000（走的是等级那一档）
    check(Array.isArray(defenseA.magicDefense) && defenseA.magicDefense[1] !== defenseA.physicalDefense[1], "而魔防仍是等级那一档（两列真的分开了）", JSON.stringify(defenseA.magicDefense));

    const hitPhysical = await standAndWait(playerA.session, async () => {
      return playerA.session.hitsFrom(0).find((hit) => hit.i && hit.d > 0) ?? null;
    });
    check(!!hitPhysical, "被物理技能命中（伤害 > 0）", hitPhysical && `damage=${hitPhysical.d}`);
    //#endregion

    //#region 二、法术技能打魔防
    group("二、法术技能打魔防：同一套装备换成 magAttack，伤害不再被物防吃掉");
    setMonsterAttack(dbPath, { physical: 0, magic: 9000 });
    setSkillBaseType(dbPath, "magicAttack");
    await sleep(1_300);

    const playerB = await spawnPlayer(baseUrl, adminToken, "elem_b");
    const castFrom = playerB.session.aiFrames.length;
    const hitMagic = await standAndWait(playerB.session, async () => {
      return playerB.session.hitsFrom(0).find((hit) => hit.d > 0) ?? null;
    });
    check(!!hitMagic, "被法术技能命中（伤害 > 0）", hitMagic && `damage=${hitMagic.d}`);
    // 核心判据（相对关系，不是数值区间）：同一套装备，法术伤害必须**大于**物理伤害。
    // 两系若读同一列，两个数会相等 —— 相等就是回归，这一条就红
    check(
      !!hitMagic && !!hitPhysical && hitMagic.d > hitPhysical.d,
      "法术打的是魔防那一列（同一套装备下，法术伤害 > 物理伤害；读同一列就会相等）",
      `物理 ${hitPhysical && hitPhysical.d} / 法术 ${hitMagic && hitMagic.d}`,
    );
    const magicCast = await waitFor(
      "法术技能 9001 的 casts 帧",
      async () => playerB.session.castsFrom(castFrom).find((cast) => cast.s === SKILL) ?? null,
      8_000,
    );
    check(!!magicCast, "这一下确实是「法术技能」打出来的（casts 帧里有 9001）", magicCast && magicCast.skillId);
    //#endregion

    //#region 三、法攻为 0 时跳过该技能
    group("三、法攻打 0 视为未配：跳过技能并 warn，不留哑弹");
    setMonsterAttack(dbPath, { physical: 1, magic: 0 });
    setSkillBaseType(dbPath, "magicAttack");
    await sleep(1_300);

    const playerC = await spawnPlayer(baseUrl, adminToken, "elem_c");
    const observeFrom = playerC.session.aiFrames.length;
    // 站 3 秒：普攻节拍 300ms，够它出手十几次
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      playerC.session.sendPos("1", STAND.x, STAND.y, 100);
      await sleep(120);
    }
    const silentCasts = playerC.session.castsFrom(observeFrom).filter((cast) => cast.s === SKILL);
    check(silentCasts.length === 0, "法攻配 0 时该技能一次都没放（回落到普攻）", `放了 ${silentCasts.length} 次`);
    const weakHits = playerC.session.hitsFrom(observeFrom);
    // 判「普攻还在打」（回落到普攻这件事真的发生），不比伤害档位（那是物攻 1 与防御算出来的数值）
    check(weakHits.length > 0, "法攻配 0 时仍然有普攻命中（回落到普攻，不是站着不动）", `命中 ${weakHits.length} 次`);
    check(
      server.logs().includes("配成 0") && server.logs().includes(SKILL),
      "服务端日志里有一条「该项攻击配成 0，已跳过该技能」的 warn",
      server.logs().split("\n").filter((line) => line.includes("配成 0")).slice(-1).join(""),
    );
    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 物法分离：${passed} 条通过 / ${failed} 条失败`);
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
