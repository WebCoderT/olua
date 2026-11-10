#!/usr/bin/env node
/**
 * 暴击与破防专项 e2e（#826 / docs/37 B9）
 *
 * `skills.desc` 里写着「附带 15% 暴击率」「无视目标防御」，而结算里一个分支都没有。
 * 这一套把新增的三列（`crit_rate` / `crit_damage` / `def_ignore`）和角色侧的
 * `growth_scalars.critRate / critDamage` 逐条钉死：
 *
 * 一、**破防**：把靶子的物防配成 10 万（远超任何攻击），`def_ignore = 0` 时每刀都是 0 伤害，
 *     配 1 时每刀都打得进去 —— 判据是「破防削的是防御那一项」，与攻击区间具体多少无关
 * 二、**暴击**：`crit_rate = 1` + `crit_damage = 2` 时每一刀都带 `critical: true`，
 *     且伤害整体是同一技能非暴击时的两倍量级（用「最小值 > 非暴击最大值」判，不锁具体数）
 * 三、**角色属性相加**：角色 1.0 + 技能 0 → 必爆；角色 0.5 + 技能 0.5 → 也必爆
 *     （相加语义；只认技能或只认角色都做不到这一条）
 *
 * 数值一律不写死成「第 1 级物攻是 14~20」：等级曲线是运营数据，改了不该让测试红。
 * 走的是 `dist/`，前置 `npm run build`。用法：npm run test:e2e:crit
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 图 1：两个 0×0 刷怪区各放一只，位置固定 */
const MAP_ID = "1";
/** 靶子 A：物防 10 万（破防用） */
const ARMORED = { key: "1", x: 400, y: -400 };
/** 靶子 B：物防 0（暴击用，不能有任何防御吃掉区间） */
const CLEAN = { key: "2", x: 600, y: -400 };
/** 靶子血厚到打不死：这一套要看伤害结构，不能中途变成 target_dead */
const TARGET_HP = 1_000_000;
/** 我们改的那一件技能（基础剑术，角色 1 级就会） */
const SKILL = "1000";

//#region 断言小工具

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

async function waitFor(label, predicate, timeoutMs = 10_000) {
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

function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * 准备世界：图 1 两个刷怪区各一只靶子，血厚、防按用途配
 *
 * 改完要等一次怪物配置的缓存过期（怪物数值是 1 秒 TTL 现取库），再 worldJoin 播种。
 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(MAP_ID);
    const seed = db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?, 0, 0, ?)`,
    );
    seed.run(MAP_ID, "暴击靶子", CLEAN.key, CLEAN.x, CLEAN.y, Date.now());
    seed.run(MAP_ID, "破防靶子", ARMORED.key, ARMORED.x, ARMORED.y, Date.now());

    const setMonster = db.prepare(
      `UPDATE monsters SET max_hp = ?, physical_defense_min = ?, physical_defense_max = ?,
        magic_defense_min = 0, magic_defense_max = 0, taoist_defense_min = 0, taoist_defense_max = 0
       WHERE id = ?`,
    );
    setMonster.run(TARGET_HP, 100_000, 100_000, ARMORED.key);
    setMonster.run(TARGET_HP, 0, 0, CLEAN.key);

    // 怪不动也不打人：这一套只看玩家的出手
    const row = db.prepare("SELECT monster_ai FROM runtime_params WHERE id = 1").get();
    const raw = row && row.monster_ai ? JSON.parse(row.monster_ai) : {};
    db.prepare("UPDATE runtime_params SET monster_ai = ? WHERE id = 1").run(
      JSON.stringify({ ...raw, attackInterval: 60_000, idleMoveInterval: [60_000, 60_000] }),
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
      JWT_SECRET: "e2e-crit-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
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

function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    seq: 0,
    fire(body) {
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return castId;
    },
    async settleOf(castId) {
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) || null);
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
  const dbPath = path.join(os.tmpdir(), `olua-e2e-crit-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：管理员 / 玩家 / 两只靶子");

    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_crit", password: "pass1234", registerCode: "test-admin-code" },
    });
    check(superAdmin.code === 0 && !!superAdmin.data.token, "准备：注册管理员拿到令牌", superAdmin.message);
    const adminToken = superAdmin.data && superAdmin.data.token;

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "crit_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "暴击测试", occupation: "1", sex: "1" } });
    check(!!(token && created.data && created.data.id), "准备：账号与角色已建好", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // 怪物数值是 1 秒 TTL 现取库：等它过期，播种时才会读到 prepareWorld 写的那两只
    await sleep(1_200);
    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");
    const world = await session.joinWorld(MAP_ID);
    const monsters = ((world && world.monsters) || []).filter((mob) => mob.alive);
    const armored = monsters.find((mob) => mob.monsterKey === ARMORED.key);
    const clean = monsters.find((mob) => mob.monsterKey === CLEAN.key);
    check(!!(armored && clean), "两只靶子都已播种（一只厚防、一只零防）", JSON.stringify(monsters.map((m) => m.monsterKey)));

    // 技能配置走管理端：结算读的 skillOf 只在「启动 + 管理端写操作后」重装
    const patchSkill = async (body) => {
      const result = await api(baseUrl, "PATCH", `admin/skills/${SKILL}`, { token: adminToken, body });
      checkEqual(result && result.code, 0, `准备：改 ${SKILL} ${JSON.stringify(body)}`);
      return result && result.data;
    };

    /** 打 N 刀，返回成功的 settle（每刀之间等冷却；偶发被冷却拒绝就补一发，不把「次采样」算进结论） */
    const strike = async (target, count) => {
      const results = [];
      while (results.length < count) {
        await paceCast();
        const castId = session.fire({ skillId: SKILL, targetId: target.instanceId, monsterKey: target.monsterKey });
        const settle = await session.settleOf(castId);
        if (settle && settle.ok) {
          results.push(settle);
          continue;
        }
        // 只补一次：连补说明冷却真的没等够，那该让断言红出来
        await sleep(600);
        const retryId = session.fire({ skillId: SKILL, targetId: target.instanceId, monsterKey: target.monsterKey });
        const retry = await session.settleOf(retryId);
        if (retry && retry.ok) results.push(retry);
      }
      return results;
    };
    //#endregion

    //#region 一、破防
    group("一、破防：def_ignore 削的是防御那一项（靶子物防 10 万）");

    const guardedNone = await strike(armored, 3);
    checkEqual(guardedNone.length, 3, "三刀都结算成功");
    check(
      guardedNone.every((settle) => settle.damage === 0),
      "def_ignore = 0 时每刀都被 10 万防御吃掉（伤害 0）",
      JSON.stringify(guardedNone.map((settle) => settle.damage)),
    );

    await patchSkill({ defIgnore: 1 });
    const guardedAll = await strike(armored, 3);
    checkEqual(guardedAll.length, 3, "破防后的三刀都结算成功");
    check(
      guardedAll.every((settle) => settle.damage > 0),
      "def_ignore = 1 时同样的靶子每刀都打得进去（防御被整项剥掉）",
      JSON.stringify(guardedAll.map((settle) => settle.damage)),
    );

    await patchSkill({ defIgnore: 0.5 });
    const guardedHalf = await strike(armored, 3);
    check(
      guardedHalf.every((settle) => settle.damage === 0),
      "def_ignore = 0.5 时防御减半（10 万 → 5 万）仍然打不动 —— 它是按比例削防御，不是「配了就必中」",
      JSON.stringify(guardedHalf.map((settle) => settle.damage)),
    );
    await patchSkill({ defIgnore: 0 });
    //#endregion

    //#region 二、暴击
    group("二、暴击：crit_rate 必爆时伤害整体翻倍（靶子零防）");

    // **交错采样**而不是「先打 16 刀非暴击、再打 16 刀必爆」：攻击伤害是
    // `[attackMin, attackMax]` 上均匀掷的，而连打会把角色的经验 / 等级 / 属性推着走
    // （实测必爆那一段的基础值平均比非暴击那一段高 0.5~1.1）。四轮各打 4 刀，两段样本
    // 覆盖同一段时间窗，漂移在两边同时发生就抵掉了。
    const ROUNDS = 4;
    const PER_ROUND = 4;
    const plain = [];
    const burst = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      await patchSkill({ critRate: 0, critDamage: 0 });
      plain.push(...(await strike(clean, PER_ROUND)));
      await patchSkill({ critRate: 1, critDamage: 2 });
      burst.push(...(await strike(clean, PER_ROUND)));
    }
    checkEqual(plain.length, ROUNDS * PER_ROUND, `非暴击基线 ${ROUNDS * PER_ROUND} 刀都结算成功`);
    check(
      plain.every((settle) => settle.critical === undefined),
      "没配暴击时回执不带 critical 字段",
      JSON.stringify(plain.map((settle) => settle.critical)),
    );
    const plainMin = Math.min(...plain.map((settle) => settle.damage));
    const plainMax = Math.max(...plain.map((settle) => settle.damage));

    checkEqual(burst.length, ROUNDS * PER_ROUND, `必爆 ${ROUNDS * PER_ROUND} 刀都结算成功`);
    check(
      burst.every((settle) => settle.critical === true),
      "crit_rate = 1 时每一刀都带 critical: true",
      JSON.stringify(burst.map((settle) => settle.critical)),
    );
    const burstMin = Math.min(...burst.map((settle) => settle.damage));
    check(
      burstMin > plainMax,
      "暴击的最小伤害大于非暴击的最大伤害（倍率真的乘上去了，不是只加了个标记）",
      `暴击 ${burstMin}..${Math.max(...burst.map((s) => s.damage))} vs 非暴击 ${plainMin}..${plainMax}`,
    );
    const burstMax = Math.max(...burst.map((settle) => settle.damage));
    // 两条断言各管一件事，都不锁具体数值：
    // 1. `burstMin > plainMax` —— 倍率真的乘上去了（不是只回了个 `critical: true` 标记）；
    // 2. 均值比 —— 倍率**是 critDamage 那个数**。
    //
    // 为什么不能用极值比：`rollCastDamage` 里攻击伤害是在 `[attackMin, attackMax]` 上掷的，
    // 两次采样是不同掷骰，6 刀的区间经常盖不满。CI 上真的红过两次（非暴击 17..19、暴击 28..36，
    // 28 ÷ 2 = 14 落在 17 之外，差的只是「这一把没掷到 14」）。
    // 改成**交错采样 + 比均值**之后噪声已经压到 ±1.0 量级，容差留 ±20%（本档约 ±3.4）：
    // 「倍率配错」（配成 1.5 → 偏离 25%）仍然一定红，实测反证见提交说明。
    const plainMean = plain.reduce((sum, settle) => sum + settle.damage, 0) / plain.length;
    const burstMean = burst.reduce((sum, settle) => sum + settle.damage, 0) / burst.length;
    check(
      Math.abs(burstMean / 2 - plainMean) <= plainMean * 0.2,
      "暴击伤害的均值是基础伤害的 2 倍（±20%：比均值不比极值，两次采样不同掷骰）",
      `暴击均值 ${burstMean.toFixed(2)} ÷2 = ${(burstMean / 2).toFixed(2)} vs 非暴击均值 ${plainMean.toFixed(2)}` +
        `；极值 暴击 ${burstMin}..${burstMax} vs 非暴击 ${plainMin}..${plainMax}`,
    );
    //#endregion

    //#region 三、角色属性相加
    group("三、角色属性相加：growth_scalars.critRate + skills.crit_rate");

    const patchScalar = async (key, value) => {
      const result = await api(baseUrl, "PATCH", `admin/growth-scalars/${key}`, { token: adminToken, body: { value } });
      checkEqual(result && result.code, 0, `准备：把成长参数 ${key} 设为 ${value}`, result && result.message);
    };

    await patchSkill({ critRate: 0, critDamage: 2 });
    await patchScalar("critRate", 1);
    const roleOnly = await strike(clean, 3);
    check(
      roleOnly.every((settle) => settle.critical === true),
      "技能不带暴击、角色 100% → 仍然必爆（角色那一份真的进了公式）",
      JSON.stringify(roleOnly.map((settle) => settle.critical)),
    );

    // 相加而不是取大：0.5 + 0.5 = 1，任一侧单独都不够
    await patchScalar("critRate", 0.5);
    await patchSkill({ critRate: 0.5 });
    const summed = await strike(clean, 3);
    check(
      summed.every((settle) => settle.critical === true),
      "角色 0.5 + 技能 0.5 → 必爆（相加语义；取大或相乘都做不到这一条）",
      JSON.stringify(summed.map((settle) => settle.critical)),
    );

    // 两边都配满也只是 100%，不会溢出成「必然暴击且倍率叠加」
    await patchScalar("critRate", 1);
    await patchSkill({ critRate: 1 });
    const capped = await strike(clean, 2);
    check(
      capped.every((settle) => settle.critical === true),
      "角色 1 + 技能 1 仍然只是必爆（概率裁到 100%，不抛错也不叠加）",
      JSON.stringify(capped.map((settle) => settle.critical)),
    );

    // 收尾：把出厂值改回去（同一套用例里后面的段落若再加，别被这一段污染）
    await patchScalar("critRate", 0);
    await patchSkill({ critRate: 0, critDamage: 0, defIgnore: 0 });
    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 暴击与破防：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log(failures.map((label) => `  - ${label}`).join("\n"));
    }
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    server.child.kill("SIGTERM");
    await sleep(300);
    try {
      require("node:fs").rmSync(dbPath, { force: true });
      require("node:fs").rmSync(`${dbPath}-wal`, { force: true });
      require("node:fs").rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时库删不掉不影响结论 */
    }
  }
})().catch((error) => {
  console.error("e2e 失败：", error);
  process.exitCode = 1;
});
