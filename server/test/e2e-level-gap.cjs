#!/usr/bin/env node
/**
 * 服务端 e2e：等级差压制系数配置化（#834 / docs/37 G3）
 *
 * 伤害侧的压制在 #826 第三批就落地了（`sup = max(0, 1 − 系数 × 越级数)`），
 * 但系数是代码里的字面量 `0.05` —— 运营改不了，调一次要发一版服务端。
 * 这一套钉的是「**系数真的从配置表来**」，以及它周边的六个边界：
 *
 * 一、**出厂口径**：`growth_scalars.levelGapSuppress` = 0.05，管理端能读到也能改
 * 二、**同级不压制**（issue 的回归项「同级战斗伤害不变」）：gap 0 → 伤害 > 0 且不带 `suppressed`
 * 三、**越 1 级按表压制**：系数 1 → gap 1 伤害归零且 `suppressed: true`
 * 四、**线性**：系数 0.5 → gap 1 还有伤害（乘 0.5）、gap 2 归零 —— 系数是「每级」不是「一次性」
 * 五、**出厂 0.05 越 20 级归零**（原口径不改）
 * 六、**打低级怪不压制**：gap 为负夹成 0，既不惩罚也不加成
 * 七、**系数 0 = 关闭压制**：运营想关就关，不用改代码
 * 八、**范围校验**：> 1 与 < 0 都被 40000 拒掉（0~1 是语义边界）
 * 九、**区域路径同一个系数**：单体与区域共用 `suppressionOf`，别只在一个路径上生效
 *
 * **不做断言的部分（命中侧）**：issue 原文写「系数同时用于伤害与命中两处」，
 * 但服务端**没有命中 / 闪避判定**（每次出手必中，没有 hitRate / dodge 字段）。
 * 按用户 2026-11-12 口径命中侧暂时放置，重开条件见 `docs/22` §2.2。
 *
 * 数值一律不锁出厂值：怪等级由 `prepareWorld` 写库（`monsters` 是 1 秒 TTL 现取库），
 * 角色等级走 `PATCH admin/roles/:id`（`online()` 每次现读库，改完下一发即生效），
 * 系数走 `PATCH admin/growth-scalars/:key`（内存缓存随写刷新）。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：npm run test:e2e:level-gap
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const MAP_ID = "1";
/** 输出靶：被动怪（不主动打人），血厚到整场打不死，四防归零（伤害只由压制决定） */
const TARGET = { key: "3", x: 200, y: -200 };
const TARGET_HP = 200_000;
/** 靶子的等级：这一段所有「越几级」都以它为基准 */
const MONSTER_LEVEL = 30;

const SKILL_BASE = "1000"; // 基础剑术：单体、距离 10px、1 倍系数
const SKILL_AREA = "1001"; // 烈火剑法：本套临时改成区域（target_type = 0）测第二条路径

const SUP_KEY = "levelGapSuppress";

//#region 断言小工具（与 e2e-attr-points / e2e-skill-upgrade 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? ` —— ${detail}` : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

const checkEqual = (actual, expected, label) =>
  check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

function group(title) {
  console.log(`\n▶ ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
}

//#endregion

/** 打开临时库做一件事（`busy_timeout` 让这次写等服务端放锁，避免 CI 上偶发 locked） */
function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * 准备世界：一个 0×0 刷怪区（落点恒等于中心点）+ 一只血厚、不还手、指定等级的靶子
 *
 * 等级写 30 而不是 1：角色可以靠管理端 PATCH 往 30 以上 / 以下走，两边都能造出
 * 「越 1 级」「平级」「打低级」三种 gap，不用去改怪物缓存（那是 1 秒 TTL）。
 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(MAP_ID);
    db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(MAP_ID, "等级靶", TARGET.key, 1, 1, TARGET.x, TARGET.y, 0, 0, Date.now());

    // 四防归零 + 物攻压到 1：这一套要的是「压制乘了多少」，不是「谁打死谁」
    db.prepare(
      `UPDATE monsters SET level = ?, max_hp = ?,
         physical_attack_min = 1, physical_attack_max = 1,
         magic_attack_min = 0, magic_attack_max = 0, taoist_attack_min = 0, taoist_attack_max = 0,
         physical_defense_min = 0, physical_defense_max = 0,
         magic_defense_min = 0, magic_defense_max = 0, taoist_defense_min = 0, taoist_defense_max = 0
       WHERE id = ?`,
    ).run(MONSTER_LEVEL, TARGET_HP, TARGET.key);
    // 不追人、不动：位置与命中数才干净
    db.prepare("UPDATE monster_presentation SET move_speed = 0, aggressive = 0, detect_range = 200 WHERE id = ?").run(
      TARGET.key,
    );
  });
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
      JWT_SECRET: "e2e-level-gap-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      MONSTER_AI_TICK_MS: "50",
      MONSTER_AI_BROADCAST_MS: "100",
      WORLD_RESPAWN_MS: "600000",
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

/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

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
    return { ...(await response.json()), status: response.status };
  } catch {
    return null;
  }
}

/** 一条会话化的 WS 连接（只收 settle / world 帧） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    seq: 0,
    /** 单体出手（要 targetId / monsterKey） */
    async cast(skillId, targetId, monsterKey) {
      // 与真客户端同一口径的出手间隔（#813）：连发会被 `rejected: "cooldown"` 拒掉
      await paceCast();
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, skillId, targetId, monsterKey } }));
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) ?? null);
    },
    /** 区域出手（落点走 x / y，没有 targetId） */
    async castArea(skillId, x, y) {
      await paceCast();
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, skillId, x, y } }));
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) ?? null);
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
    sendPos(x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId: MAP_ID, x, y, hp, moving: false } }));
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
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-level-gap-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：管理员 / 玩家 / 30 级靶");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_gap", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "gap_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "越级者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "准备：账号与角色已建好", created.message);

    /** 改角色等级（`admin/roles/:id` 会当场重算面板；`online()` 每发都现读库，改完即生效） */
    const setLevel = async (level) => {
      const patched = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { level } });
      check(patched.code === 0, `准备：角色等级改成 ${level}`, patched.message);
    };
    /** 改压制系数（内存缓存随写刷新） */
    const setSuppress = (value) =>
      api(baseUrl, "PATCH", `admin/growth-scalars/${SUP_KEY}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { value } });

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // 怪物数值 / 刷怪区都是 1 秒 TTL 现取库：等它过期，播种时才读得到 prepareWorld 写的那只靶子
    await sleep(1_200);
    // #859 起「没有位置记录」的角色只准进新手村 —— 要进 1 图得先让服务端认为他本来就在
    placeRolesAt(dbPath, "1");
    const world = await session.joinWorld(MAP_ID);
    const target = ((world && world.monsters) || []).find((mob) => mob.alive && mob.monsterKey === TARGET.key);
    check(!!target, "准备：30 级靶已播种", JSON.stringify(((world && world.monsters) || []).map((mob) => mob.monsterKey)));
    if (!target) throw new Error("靶子没播种，后面没法测");

    /** 站桩（连发三帧：位置仲裁按速度上限拒单帧瞬移，但连续两帧超速就信任并重置基线） */
    const playerPos = { x: TARGET.x - 5, y: TARGET.y };
    for (let index = 0; index < 3; index += 1) {
      session.sendPos(playerPos.x, playerPos.y, 1_000_000);
      await sleep(120);
    }

    /** 砍一刀；先补一帧位置（在场表 3 秒收不到 pos 就把人当离场） */
    const strike = async () => {
      session.sendPos(playerPos.x, playerPos.y, 1_000_000);
      return session.cast(SKILL_BASE, target.instanceId, target.monsterKey);
    };

    //#endregion

    //#region 一、出厂口径

    group("一、出厂口径：growth_scalars.levelGapSuppress = 0.05，管理端读得到也改得动");
    const scalars = await api(baseUrl, "GET", "admin/growth-scalars?page=1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    const listed = ((scalars.data && scalars.data.list) || []).find((row) => row.key === SUP_KEY);
    check(!!listed, "管理端「成长参数」里能读到这一行（存量库由启动时 INSERT OR IGNORE 补）", SUP_KEY);
    // 出厂值本身是配置数据：只判「这一行存在且是个正系数」，不锁 0.05
    check(!!listed && Number(listed.value) > 0, "出厂系数是个正数（每越 1 级按它压）", listed && String(listed.value));
    const writable = await setSuppress(0.05);
    checkEqual(writable.code, 0, "管理端写得动（不是只读行）", writable.message);

    //#endregion

    //#region 二、同级不压制

    group("二、同级不压制：gap 0 → 伤害 > 0，且回执里没有 suppressed");
    await setLevel(MONSTER_LEVEL);
    const same = await strike();
    check(!!same && same.ok, "同级出手结算成功", same && same.message);
    check(!!same && same.damage > 0, "同级伤害 > 0（issue 的回归项：同级战斗伤害不变）", same && `damage=${same.damage}`);
    check(!same || same.suppressed === undefined, "同级不带 suppressed（客户端不该飘「压制」）", same && JSON.stringify(same.suppressed));

    //#endregion

    //#region 三、越 1 级按表压制

    group("三、越 1 级按表压制：系数 1 → gap 1 伤害归零");
    const toOne = await setSuppress(1);
    checkEqual(toOne.code, 0, "准备：系数改成 1（越 1 级就打不动）", toOne.message);
    await setLevel(MONSTER_LEVEL - 1);
    const gapped = await strike();
    check(!!gapped && gapped.ok, "越 1 级出手结算成功", gapped && gapped.message);
    checkEqual(gapped && gapped.damage, 0, "伤害 = 0（1 − 1 × 1 = 0）");
    check(!!gapped && gapped.suppressed === true, "回执带 suppressed: true（客户端据此显示「等级压制」而不是「伤害 0」）");

    //#endregion

    //#region 四、线性

    group("四、线性：系数 0.5 → gap 1 还有伤害（×0.5）、gap 2 归零");
    const toHalf = await setSuppress(0.5);
    checkEqual(toHalf.code, 0, "准备：系数改成 0.5", toHalf.message);
    await setLevel(MONSTER_LEVEL - 1);
    const half = await strike();
    check(!!half && half.damage > 0, "gap 1、系数 0.5 → 伤害还 > 0（乘 0.5，不是归零）", half && `damage=${half.damage}`);
    check(!!half && half.suppressed === true, "但已经算「被压制」（系数 < 1）");
    await setLevel(MONSTER_LEVEL - 2);
    const doubled = await strike();
    checkEqual(doubled && doubled.damage, 0, "gap 2、系数 0.5 → 伤害归零（1 − 0.5 × 2 = 0）");

    //#endregion

    //#region 五、出厂 0.05 越 20 级归零

    group("五、出厂口径越 20 级归零：系数 0.05 → gap 20 伤害 = 0");
    const restore = await setSuppress(0.05);
    checkEqual(restore.code, 0, "准备：系数改回出厂 0.05", restore.message);
    await setLevel(MONSTER_LEVEL - 20);
    const far = await strike();
    check(!!far && far.ok, "越 20 级出手结算成功", far && far.message);
    checkEqual(far && far.damage, 0, "伤害 = 0（1 − 0.05 × 20）");
    check(!!far && far.suppressed === true, "带 suppressed: true");
    await setLevel(MONSTER_LEVEL - 19);
    const nearFar = await strike();
    check(!!nearFar && nearFar.damage > 0, "越 19 级还有一点伤害（0.05 × 19 = 0.95，归零发生在第 20 级）", nearFar && `damage=${nearFar.damage}`);

    //#endregion

    //#region 六、打低级怪不压制

    group("六、打低级怪不压制：gap 为负夹成 0");
    await setLevel(MONSTER_LEVEL + 5);
    const overleveled = await strike();
    check(!!overleveled && overleveled.damage > 0, "高 5 级打低级怪伤害 > 0", overleveled && `damage=${overleveled.damage}`);
    check(!overleveled || overleveled.suppressed === undefined, "不压制（下界夹 0，既不惩罚也不加成）");

    //#endregion

    //#region 七、系数 0 = 关闭

    group("七、系数 0 = 关闭压制：越 5 级照样打得动");
    const off = await setSuppress(0);
    checkEqual(off.code, 0, "准备：系数改成 0（关闭）", off.message);
    await setLevel(MONSTER_LEVEL - 5);
    const unpressed = await strike();
    check(!!unpressed && unpressed.damage > 0, "越 5 级伤害 > 0（运营想关就关，不用改代码）", unpressed && `damage=${unpressed.damage}`);
    check(!unpressed || unpressed.suppressed === undefined, "系数 0 时连 suppressed 都不该带（乘数恒 1）");

    //#endregion

    //#region 八、范围校验

    group("八、范围校验：0~1 之外一律 40000");
    const tooBig = await setSuppress(2);
    checkEqual(tooBig.code, 40000, "系数 2 → 40000（上限 1，> 1 会让所有整数等级差都归零）", tooBig.message);
    checkEqual(tooBig.status, 400, "40000 走 HTTP 400");
    const tooSmall = await setSuppress(-0.1);
    checkEqual(tooSmall.code, 40000, "系数 -0.1 → 40000（负的压制等于越级打怪更疼，是刷怪口子）", tooSmall.message);
    const afterInvalid = await api(baseUrl, "GET", "admin/growth-scalars?page=1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    const kept = ((afterInvalid.data && afterInvalid.data.list) || []).find((row) => row.key === SUP_KEY);
    checkEqual(kept && Number(kept.value), 0, "两次非法写入都没落库（还是上一步的 0）");

    //#endregion

    //#region 九、区域路径同一个系数

    group("九、区域路径同一个系数：单体与区域共用 suppressionOf");
    const toArea = await api(baseUrl, "PATCH", `admin/skills/${SKILL_AREA}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { targetType: "0" },
    });
    checkEqual(toArea.code, 0, `准备：把 ${SKILL_AREA} 改成区域技能（target_type = 0）`, toArea.message);
    const toOneAgain = await setSuppress(1);
    checkEqual(toOneAgain.code, 0, "准备：系数改回 1", toOneAgain.message);
    await setLevel(MONSTER_LEVEL - 1);
    session.sendPos(playerPos.x, playerPos.y, 1_000_000);
    const area = await session.castArea(SKILL_AREA, TARGET.x, TARGET.y);
    check(!!area && area.ok, "区域技能结算成功", area && area.message);
    const areaHits = (area && area.hits) || [];
    check(areaHits.length > 0, "区域命中至少一只（落点在靶子身上）", `hits=${areaHits.length}`);
    check(
      areaHits.every((hit) => hit.damage === 0 && hit.suppressed === true),
      "区域路径的每一只也吃压制（不是只有单体路径接了系数）",
      JSON.stringify(areaHits.map((hit) => ({ damage: hit.damage, suppressed: hit.suppressed }))),
    );

    //#endregion

    // 收尾：靶子恢复成单体（这一套自己改的配置自己还原，别影响复跑）
    await api(baseUrl, "PATCH", `admin/skills/${SKILL_AREA}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { targetType: "1" } });
    await setSuppress(0.05);
  } finally {
    server.child.kill();
    try {
      require("node:fs").rmSync(dbPath, { force: true });
    } catch {
      /* 临时库删不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 等级差压制：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const label of failures) console.log(`  - ${label}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();
