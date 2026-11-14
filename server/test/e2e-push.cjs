#!/usr/bin/env node
/**
 * 撞飞与群体技能专项 e2e（#826 第二批 / docs/37 B9）
 *
 * `skills.desc` 里写着「65% 概率将等级低于自身的目标撞飞」「扇形范围群攻」：
 * 位移（#670 的 `applyPush`）早就有，但概率、等级条件与 1009 的群体化一直没接上。
 * 这一套钉死四件事：
 *
 * 一、**撞飞端点**：`push_chance = 1` 时每一刀都推（`settle.pushDistance` = 配的距离）；
 *     `push_chance = 0` 时不推；怪物等级 ≥ 玩家等级时不推（desc「等级低于自身的目标撞飞」，
 *     严格小于）—— 三道闸按顺序逐个验证，互不依赖
 * 二、**真实位移**：结算回执说推了，AI 侧就真的把怪推走（等两个广播拍对比 world 帧里的坐标）
 * 三、**击杀不推**：都打死了就没必要推（击杀分支里没有 push 逻辑）
 * 四、**1009 群体化**：`target_type` 改成区域后，不带目标的 cast 也能结算，
 *     半径内的多只怪都在 `hits` 里 —— 服务端 AOE 是 #824 落的，这里只验配置接线
 *
 * 数值不锁具体攻防曲线；走 `dist/`，前置 `npm run build`。用法：npm run test:e2e:push
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

/** 图 1：三个 0 尺寸刷怪区，位置固定 */
const MAP_ID = "1";
/** 撞飞靶：普通怪 */
const PUSH_TARGET = { key: "1", x: 400, y: -400 };
/** 群体靶（1009 用）：同区两只，稍微散开 */
const GROUP_CENTER = { x: 600, y: -400 };
/** 脆怪：一刀就能杀（击杀不推用） */
const FRAGILE = { key: "3", x: 200, y: -400 };
/** 靶子血厚到打不死：撞飞测试不能中途变成 target_dead */
const TARGET_HP = 1_000_000;
/** 撞飞用技能（基础剑术，角色 1 级就会；action=attack_near，paceCast 按它算冷却） */
const SKILL = "1000";
/** 1009 半月弯刀：出厂已配成区域（target_type=2、distance=320） */
const AREA_SKILL = "1009";
/** 1009 的冷却：cooldown 1s ÷ speedRate.stand 1 = 1s（paceCast 只认 1000，这里自己等） */
const AREA_CAST_GAP_MS = 1_100;

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
 * 准备世界：三个刷怪区各放靶子；怪的等级压到 0（玩家 1 级，严格小于成立）
 *
 * 怪物数值是 1 秒 TTL 现取库 —— 改 level / max_hp 后等 1.2s 生效。
 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(MAP_ID);
    const seed = db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    seed.run(MAP_ID, "撞飞靶", PUSH_TARGET.key, 1, 1, PUSH_TARGET.x, PUSH_TARGET.y, 0, 0, Date.now());
    seed.run(MAP_ID, "群体靶", "2", 2, 2, GROUP_CENTER.x, GROUP_CENTER.y, 100, 100, Date.now());
    seed.run(MAP_ID, "脆怪", FRAGILE.key, 1, 1, FRAGILE.x, FRAGILE.y, 0, 0, Date.now());

    const setMonster = db.prepare(
      `UPDATE monsters SET level = 0, max_hp = ?, physical_defense_min = 0, physical_defense_max = 0,
        magic_defense_min = 0, magic_defense_max = 0, taoist_defense_min = 0, taoist_defense_max = 0
       WHERE id = ?`,
    );
    setMonster.run(TARGET_HP, PUSH_TARGET.key);
    setMonster.run(TARGET_HP, "2");
    // 脆怪：一刀就能死（击杀不推用）。1 级角色一刀 14~20（不锁曲线），hp 必须压到下限以下
    const setFragile = db.prepare(`UPDATE monsters SET level = 0, max_hp = 10 WHERE id = ?`);
    setFragile.run(FRAGILE.key);

    // 怪不动也不打人：这一套只看玩家的出手（击杀脆怪那一刀除外，脆怪 hp=30 也还不了手）
    const row = db.prepare("SELECT monster_ai FROM runtime_params WHERE id = 1").get();
    const raw = row && row.monster_ai ? JSON.parse(row.monster_ai) : {};
    db.prepare("UPDATE runtime_params SET monster_ai = ? WHERE id = 1").run(
      JSON.stringify({ ...raw, attackInterval: 60_000, idleMoveInterval: [60_000, 60_000] }),
    );
  });
}

/** 改怪等级（1 秒 TTL 生效） */
function setMonsterLevel(dbPath, key, level) {
  withDb(dbPath, (db) => {
    db.prepare("UPDATE monsters SET level = ? WHERE id = ?").run(level, key);
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
      JWT_SECRET: "e2e-push-secret",
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
    aiFrames: [],
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
    /** 位置上报（applyPush 靠它取施法者坐标；guard 的距离闸也用它 —— 报到靶子旁边） */
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
      // 怪的位置广播走 monster-ai 帧（entry 只有 instanceId，没有 monsterKey）
      if (frame.type === "monster-ai") session.aiFrames.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-push-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：管理员 / 玩家 / 三只靶子");

    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_push", password: "pass1234", registerCode: "test-admin-code" },
    });
    check(superAdmin.code === 0 && !!superAdmin.data.token, "准备：注册管理员拿到令牌", superAdmin.message);
    const adminToken = superAdmin.data && superAdmin.data.token;

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "push_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "撞飞测试", occupation: "1", sex: "1" } });
    check(!!(token && created.data && created.data.id), "准备：账号与角色已建好", created.message);

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // 怪物数值 1 秒 TTL：等它过期，播种时才会读到 prepareWorld 写的三只
    await sleep(1_200);
    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
  // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
  placeRolesAt(dbPath, "1");
  const world = await session.joinWorld(MAP_ID);
    const monsters = ((world && world.monsters) || []).filter((mob) => mob.alive);
    const pushTarget = monsters.find((mob) => mob.monsterKey === PUSH_TARGET.key);
    const fragile = monsters.find((mob) => mob.monsterKey === FRAGILE.key);
    check(!!(pushTarget && fragile), "撞飞靶与脆怪都已播种", JSON.stringify(monsters.map((m) => m.monsterKey)));
    if (!pushTarget || !fragile) throw new Error("靶子没播种，后面没法测");

    // 玩家位置报到撞飞靶旁边（5px < 1000 的施法距离 10，距离闸放行；applyPush 也靠它取方向）
    // **站在怪的 −x 侧**：击退的方向是「施法者 → 怪」，站右边就会一路往左推 —— 而左边 400px
    // 外就是图边（外墙 `cx = 0, w = 128`），#854 起击退走碰撞、被墙挡住原地不动，
    // 那几刀就再也推不出位移了。站左边往右推，走廊 y = −400 一路到 x = 3000 都是空的
    let playerPos = { x: PUSH_TARGET.x - 5, y: PUSH_TARGET.y };
    const stand = async (x, y) => {
      playerPos = { x, y };
      // 连发三帧：位置仲裁按速度上限拒「瞬移」帧，但**连续两帧超速就信任并重置基线**
      // （#861 / `POS_TRUST_STREAK`）。只发一帧的话人还站在上一处，区域技能的作用点
      // 就会跟着错位（本套踩过：`1009` 一发命中 0 只）
      for (let index = 0; index < 3; index += 1) {
        session.sendPos(x, y, 1_000_000);
        await sleep(120);
      }
    };
    await stand(playerPos.x, playerPos.y);

    const patchSkill = async (skillId, body) => {
      const result = await api(baseUrl, "PATCH", `admin/skills/${skillId}`, { token: adminToken, body });
      checkEqual(result && result.code, 0, `准备：改技能 ${skillId} ${JSON.stringify(body)}`);
      return result && result.data;
    };

    /** 打 N 刀（单体技能），返回成功的 settle */
    const strike = async (target, count) => {
      const results = [];
      while (results.length < count) {
        await paceCast();
        // 出手前补一帧位置：在场表 3 秒收不到 `pos` 就把人当离场删掉（#861 的口径），
        // 而 `applyPush` 的推方向**只认在场表**（#855）—— 不补的话第二刀起就静默不推了。
        // 真实客户端 4Hz 上报，走不到这个缺口；测试的 `paceCast` 比它慢得多
        session.sendPos(playerPos.x, playerPos.y, 1_000_000);
        const castId = session.fire({ skillId: SKILL, targetId: target.instanceId, monsterKey: target.monsterKey });
        const settle = await session.settleOf(castId);
        if (settle && settle.ok) {
          results.push(settle);
          continue;
        }
        await sleep(600);
        session.sendPos(playerPos.x, playerPos.y, 1_000_000);
        const retryId = session.fire({ skillId: SKILL, targetId: target.instanceId, monsterKey: target.monsterKey });
        const retry = await session.settleOf(retryId);
        if (retry && retry.ok) results.push(retry);
      }
      return results;
    };
    //#endregion

    //#region 一、撞飞端点
    group("一、撞飞：push_distance × push_chance × 等级闸（玩家 1 级，靶子 level 0）");

    await patchSkill(SKILL, { pushDistance: 512, pushChance: 1 });
    const pushAll = await strike(pushTarget, 3);
    checkEqual(pushAll.length, 3, "三刀都结算成功");
    check(
      pushAll.every((settle) => settle.pushDistance === 512),
      "push_chance = 1 时每一刀都撞飞 512px",
      JSON.stringify(pushAll.map((settle) => settle.pushDistance)),
    );

    // 没推时回执**不带** pushDistance 字段（与 critical 同款式）—— 断言按「> 0 才算推了」
    await patchSkill(SKILL, { pushChance: 0 });
    const pushNone = await strike(pushTarget, 2);
    checkEqual(pushNone.length, 2, "关概率后的两刀都结算成功");
    check(
      pushNone.every((settle) => !(settle.pushDistance > 0)),
      "push_chance = 0 时同一把刀一下都不推（回执不带 pushDistance）",
      JSON.stringify(pushNone.map((settle) => settle.pushDistance ?? 0)),
    );

    await patchSkill(SKILL, { pushChance: 1 });
    setMonsterLevel(dbPath, PUSH_TARGET.key, 2);
    await sleep(1_200);
    const pushHigh = await strike(pushTarget, 2);
    checkEqual(pushHigh.length, 2, "等级闸的两刀都结算成功");
    check(
      pushHigh.every((settle) => !(settle.pushDistance > 0)),
      "怪物等级(2) ≥ 玩家等级(1) 时不推（desc：等级低于自身的目标才撞飞）",
      JSON.stringify(pushHigh.map((settle) => settle.pushDistance ?? 0)),
    );

    setMonsterLevel(dbPath, PUSH_TARGET.key, 0);
    await sleep(1_200);
    const pushBack = await strike(pushTarget, 2);
    check(
      pushBack.every((settle) => settle.pushDistance === 512),
      "等级闸解除（怪降回 0 级）后恢复撞飞",
      JSON.stringify(pushBack.map((settle) => settle.pushDistance)),
    );
    //#endregion

    //#region 二、真实位移
    group("二、真实位移：回执说推了，AI 侧就把怪推走");

    const aiBefore = session.aiFrames.length;
    const beforePos = (() => {
      for (let i = session.aiFrames.length - 1; i >= 0; i -= 1) {
        const entry = (session.aiFrames[i].monsters || []).find((m) => m.i === pushTarget.instanceId);
        if (entry) return { x: entry.x, y: entry.y };
      }
      return null;
    })();
    check(!!beforePos, "推之前拿到了怪的坐标", JSON.stringify(beforePos));
    const pushed = await strike(pushTarget, 1);
    checkEqual(pushed.length, 1, "位移采样这一刀结算成功");
    checkEqual(pushed[0].pushDistance, 512, "这一刀确实在推");
    // 击退时长 200ms、AI 广播 200ms：等 1.5s 足够看到落点。
    // 取**第一个**位移 > 100px 的帧 —— 怪被推出刷怪区太远后 AI 会回归出生点（往回走），
    // 取最新帧可能采到回归途中的位置，方向就反了（正序找击退那一拍，击退速度 2560px/s 远快于回归）
    const afterPush = await waitFor(
      "推完之后怪在 monster-ai 帧里出现击退位移",
      async () => {
        for (let i = aiBefore; i < session.aiFrames.length; i += 1) {
          const entry = (session.aiFrames[i].monsters || []).find((m) => m.i === pushTarget.instanceId);
          if (!entry) continue;
          const moved = Math.hypot(entry.x - beforePos.x, entry.y - beforePos.y);
          if (moved > 100) return { entry, moved };
        }
        return null;
      },
      5_000,
    );
    if (afterPush && beforePos) {
      // 方向 = 施法者 → 怪（玩家在怪的 −x 侧，推走 = x 更大）。不锁具体位移量
      check(afterPush.entry.x > beforePos.x, "怪真的被推走且方向背离施法者", `移动 ${Math.round(afterPush.moved)}px，x ${Math.round(beforePos.x)} → ${Math.round(afterPush.entry.x)}`);
    }
    //#endregion

    //#region 三、击杀不推
    group("三、击杀不推：都打死了就不推（脆怪 hp=10）");

    // 脆怪在 (200,-400)，距玩家 205px > 1000 的施法距离 10 —— 距离闸会拒；
    // 先把玩家位置挪到脆怪旁边
    await stand(FRAGILE.x + 5, FRAGILE.y);
    // 1 级角色的伤害区间跨 hp=10（实测 8~20+）：多打几刀直到打死，锁的是「击杀帧的行为」
    // 而不是「第几刀打死」—— 不与数值曲线耦合
    let killFrame = null;
    for (let attempt = 0; attempt < 4 && !killFrame; attempt += 1) {
      const settles = await strike(fragile, 1);
      if (settles[0] && settles[0].killed) killFrame = settles[0];
    }
    check(!!killFrame, "脆怪被带走（拿到 killed 帧）", killFrame ? `伤害 ${killFrame.damage}` : "四刀都没杀死");
    check(!!(killFrame && !(killFrame.pushDistance > 0)), "击杀帧里没有撞飞信号（击杀分支没有 push）");
    //#endregion

    //#region 四、1009 群体化
    group("四、1009 半月弯刀：target_type 改区域后，一发命中半径内多只怪");

    // 玩家挪到群体靶中心：区 B 两只怪都在 320 半径内
    await stand(GROUP_CENTER.x, GROUP_CENTER.y);
    const areaCastId = session.fire({ skillId: AREA_SKILL });
    const areaSettle = await session.settleOf(areaCastId);
    check(!!(areaSettle && areaSettle.ok), "区域 cast（不带 targetId / monsterKey）结算成功", areaSettle && areaSettle.message);
    const hits = (areaSettle && areaSettle.hits) || [];
    check(hits.length >= 2, "radius 内的多只怪都在 hits 里", `命中 ${hits.length} 只`);
    check(
      hits.every((hit) => hit.damage > 0),
      "每一只都真的掉血（不是空系数）",
      JSON.stringify(hits.map((hit) => hit.damage)),
    );
    check(
      hits.some((hit) => hit.monsterKey === "2"),
      "命中的是群体靶那两只（monsterKey=2）",
      JSON.stringify([...new Set(hits.map((hit) => hit.monsterKey))]),
    );

    // 再来一发（等冷却）：结果稳定，不因第一发而变化
    await sleep(AREA_CAST_GAP_MS);
    const areaCastId2 = session.fire({ skillId: AREA_SKILL });
    const areaSettle2 = await session.settleOf(areaCastId2);
    check(!!(areaSettle2 && areaSettle2.ok), "第二发也结算成功（冷却间隔足够）", areaSettle2 && areaSettle2.message);
    check(((areaSettle2 && areaSettle2.hits) || []).length >= 2, "第二发同样命中多只", JSON.stringify((areaSettle2 && areaSettle2.hits || []).length));
    //#endregion

    //#region 汇总
    console.log(`\n===== e2e-push：${passed} 条通过 / ${failed} 条失败 =====`);
    if (failed > 0) {
      console.log("失败清单：");
      for (const label of failures) console.log(`  - ${label}`);
      console.log("\n=== 服务端日志尾部 ===");
      console.log(server.logs().slice(-2000));
      process.exitCode = 1;
    }
    //#endregion
  } finally {
    server.child.kill("SIGTERM");
  }
})();
